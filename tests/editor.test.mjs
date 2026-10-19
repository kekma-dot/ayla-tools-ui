import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import { entry, fakeCtx, fakePi, fakeTui, jiti } from "./helpers/harness.mjs";

const editorModule = await jiti.import(entry("editor.ts"));
const { AylaEditor } = editorModule;
// Same module instance, so `instanceof` and the installed factory agree.
const editorExtension = editorModule.default;

const keybindings = getKeybindings();
const editorTheme = { borderColor: (text) => text };

function makeEditor(context) {
	let opened = 0;
	const editor = new AylaEditor(
		fakeTui(),
		editorTheme,
		keybindings,
		() => {
			opened += 1;
		},
		() => context ?? fakeCtx().ctx,
	);
	editor.focused = true;
	return { editor, openedCount: () => opened };
}

test("the host editor buffer, multiline input and submit stay untouched", () => {
	const { editor } = makeEditor();
	const submitted = [];
	editor.onSubmit = (text) => submitted.push(text);

	editor.handleInput("hello");
	editor.handleInput(" ");
	editor.handleInput("world");
	assert.equal(editor.getText(), "hello world");

	editor.handleInput("\r");
	assert.deepEqual(submitted, ["hello world"]);
	assert.equal(editor.getText(), "", "submit clears the buffer");

	// Bracketed paste of two lines arrives as one chunk and is not submitted.
	editor.handleInput("\x1b[200~line1\nline2\x1b[201~");
	assert.equal(editor.getText().trim(), "line1\nline2".trim());
});

test("bare /model is submitted verbatim: no command remapping", () => {
	const { editor } = makeEditor();
	const submitted = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.handleInput("/model");
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["/model"]);
});

test("Tab on an empty prompt opens the HUD", () => {
	const { editor, openedCount } = makeEditor();
	editor.handleInput("\t");
	assert.equal(openedCount(), 1);
});

test("Tab with text, or inside a paste, never opens the HUD", () => {
	const { editor, openedCount } = makeEditor();
	editor.setText("draft");
	editor.handleInput("\t");
	assert.equal(openedCount(), 0, "Tab with text belongs to autocomplete/indentation");
	assert.ok(editor.getText().startsWith("draft"));

	editor.setText("");
	editor.handleInput("\x1b[200~");
	editor.handleInput("\t");
	editor.handleInput("\x1b[201~");
	assert.equal(openedCount(), 0, "a paste containing a tab must not open the HUD");
});

test("the frame renders at every width without touching the buffer", () => {
	const { editor } = makeEditor(
		fakeCtx({
			model: { id: "gpt-5.6-terra", provider: "openai-codex", name: "terra" },
			thinkingLevel: "medium",
			usage: { tokens: 1000, contextWindow: 10000, percent: 10 },
		}).ctx,
	);
	editor.setText("a prompt with 漢字 and 🙂");
	for (const width of [16, 20, 40, 80, 120]) {
		const lines = editor.render(width);
		assert.ok(lines.length >= 2, `no frame at ${width}`);
	}
	assert.equal(editor.getText(), "a prompt with 漢字 and 🙂");
});

test("mouse coordinates track whether the last render used a frame", (t) => {
	const { editor } = makeEditor();
	let forwarded;
	t.mock.method(Object.getPrototypeOf(AylaEditor.prototype), "handleMouse", (event) => {
		forwarded = event;
		return { handled: true };
	});
	const event = { type: "click", x: 3, y: 1, width: 80, height: 10 };
	editor.render(80);
	editor.handleMouse(event);
	assert.equal(forwarded.x, 1, "the wide frame adds two columns");
	assert.equal(forwarded.width, 78);
	editor.render(8);
	editor.handleMouse({ ...event, x: 1, width: 8 });
	assert.equal(forwarded.x, 1, "the unframed narrow editor must keep host coordinates");
	assert.equal(forwarded.width, 8);
});

test("a foreign editor factory is left exactly as it was", async () => {
	const { api, emit } = fakePi();
	editorExtension(api);
	const sentinel = (tui, theme, keys) => ({ render: () => ["sentinel"], handleInput() {}, invalidate() {} });
	const { ctx, state } = fakeCtx({ editorFactory: sentinel });
	await emit("session_start", ctx);
	assert.equal(state.editorFactory, sentinel, "a foreign editor must not be wrapped or replaced");
	await emit("session_shutdown", ctx);
	assert.equal(state.editorFactory, sentinel, "shutdown must not clear another owner's editor");
});

test("with no foreign editor we install, then restore only our own factory", async () => {
	const { api, emit } = fakePi();
	editorExtension(api);
	const { ctx, state } = fakeCtx();
	await emit("session_start", ctx);
	const installed = state.editorFactory;
	assert.equal(typeof installed, "function");
	assert.ok(installed(fakeTui(), editorTheme, keybindings) instanceof AylaEditor);

	await emit("session_shutdown", ctx);
	assert.equal(state.editorFactory, undefined, "our own factory is restored on shutdown");
});

test("a rejected Tab overlay is handled and is silent after shutdown", async () => {
	for (const shutdown of [false, true]) {
		let rejectOverlay;
		const { api, emit } = fakePi();
		editorExtension(api);
		const { ctx, state } = fakeCtx();
		ctx.ui.custom = () => new Promise((_, reject) => { rejectOverlay = reject; });
		await emit("session_start", ctx);
		const editor = state.editorFactory(fakeTui(), editorTheme, keybindings);
		editor.handleInput("\t");
		assert.equal(typeof rejectOverlay, "function");
		if (shutdown) await emit("session_shutdown", ctx);
		rejectOverlay(new Error("synthetic closed UI"));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.notifications.length, shutdown ? 0 : 1);
	}
});

test("a factory installed after ours survives shutdown", async () => {
	const { api, emit } = fakePi();
	editorExtension(api);
	const { ctx, state } = fakeCtx();
	await emit("session_start", ctx);
	const later = () => ({ render: () => ["later"], handleInput() {}, invalidate() {} });
	state.editorFactory = later;
	await emit("session_shutdown", ctx);
	assert.equal(state.editorFactory, later, "a later owner must never be overwritten");
});

test("headless and RPC modes install no editor and no overlay", async () => {
	for (const mode of ["print", "rpc", "json"]) {
		const { api, commands, emit } = fakePi();
		editorExtension(api);
		const { ctx, state } = fakeCtx({ mode, hasUI: mode === "rpc" });
		await emit("session_start", ctx);
		assert.equal(state.editorFactory, undefined, `${mode} must not install an editor`);
		await commands.get("ayla-ui").handler("session", ctx);
		assert.equal(state.customCalls, 0, `${mode} must not open an overlay`);
		assert.equal(state.notifications.at(-1)?.type, "warning", `${mode} reports instead`);
	}
});

test("/ayla-ui reports instead of drawing outside the TUI", async () => {
	const { api, commands, emit } = fakePi();
	editorExtension(api);
	const { ctx, state } = fakeCtx({ mode: "print", hasUI: false });
	await emit("session_start", ctx);
	assert.ok(commands.has("ayla-ui"), "/ayla-ui must exist without our editor");
	await commands.get("ayla-ui").handler("", ctx);
	assert.equal(state.customCalls, 0, "no overlay outside the TUI");
	assert.equal(state.notifications.at(-1)?.type, "warning");
});
