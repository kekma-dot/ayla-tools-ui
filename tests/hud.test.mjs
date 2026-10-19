import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { entry, fakeCtx, fakePi, jiti, PLAIN_THEME } from "./helpers/harness.mjs";

const module = await jiti.import(entry("hud.ts"));
const hudModel = await jiti.import(entry("hud-model.mjs"));
const { buildHud, hudContentRows, normalizeTab, nextTab } = hudModel;
const { LocalHudComponent, createHudController, readLocalSnapshot } = module;

const SNAPSHOT = {
	name: "feature work",
	id: "session-1",
	cwd: "/work/project",
	model: "terra",
	provider: "openai-codex",
	thinking: "medium",
	context: { tokens: 1200, window: 10000, percent: 12 },
	activeTools: ["bash", "read"],
	allTools: ["bash", "read", "write"],
	scopedModels: [{ id: "terra", name: "terra", provider: "openai-codex", current: true }],
	availableModels: 4,
};

test("every HUD line fits and the panel never exceeds its height", () => {
	for (const width of [12, 16, 20, 40, 80, 120]) {
		for (const height of [8, 12, 20, 30]) {
			const lines = buildHud(SNAPSHOT, { tab: "session", offset: 0 }, width, height, PLAIN_THEME);
			assert.equal(lines.length, height - 1, `height ${height} at width ${width}`);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `overflow at ${width}x${height}: ${JSON.stringify(line)}`);
			}
		}
	}
});

test("a width too small for a frame still renders one bounded line", () => {
	const lines = buildHud(SNAPSHOT, { tab: "session", offset: 0 }, 8, 20, PLAIN_THEME);
	assert.equal(lines.length, 1);
	assert.ok(visibleWidth(lines[0]) <= 8);
});

test("tabs, scrolling and identity are bounded by the content", () => {
	const many = { ...SNAPSHOT, activeTools: Array.from({ length: 30 }, (_v, i) => `tool-${i}`) };
	const height = 12;
	const budget = hudContentRows(height);
	const first = buildHud(many, { tab: "tools", offset: 0 }, 60, height, PLAIN_THEME);
	const scrolled = buildHud(many, { tab: "tools", offset: 5 }, 60, height, PLAIN_THEME);
	assert.notDeepEqual(first, scrolled, "offset must change the window");
	const beyond = buildHud(many, { tab: "tools", offset: 10_000 }, 60, height, PLAIN_THEME);
	assert.equal(beyond.length, height - 1);
	assert.deepEqual(beyond, buildHud(many, { tab: "tools", offset: 30 - budget }, 60, height, PLAIN_THEME));
	if (budget < 30) assert.ok(first.join("\n").includes("↓"), "scroll marker appears");
});

test("untrusted session names and ids are sanitized", () => {
	const dirty = { ...SNAPSHOT, name: "evil\u001b[31mname", id: "id\u0007bell" };
	const text = buildHud(dirty, { tab: "session", offset: 0 }, 80, 20, PLAIN_THEME).join("\n");
	assert.ok(!text.includes("\u001b[31m"), "escape sequence leaked");
	assert.ok(!text.includes("\u0007"), "bell leaked");
	assert.ok(text.includes("evilname"), `sanitized name missing: ${text}`);
});

test("tab helpers clamp unknown values", () => {
	assert.equal(normalizeTab("models"), "models");
	assert.equal(normalizeTab("MODELS"), "models");
	assert.equal(normalizeTab("2"), "models");
	assert.equal(normalizeTab("bogus"), "session");
	assert.equal(nextTab("session", -1), "tools");
	assert.equal(nextTab("tools", 1), "session");
});

function makeComponent(overrides = {}) {
	const { api } = fakePi(overrides.api);
	const { ctx } = fakeCtx(overrides.ctx);
	let closed = 0;
	const component = new LocalHudComponent(
		api,
		ctx,
		PLAIN_THEME,
		overrides.keybindings,
		overrides.tab ?? "session",
		() => {
			closed += 1;
		},
	);
	return { component, api, ctx, closed: () => closed };
}

test("HUD keys: cancel closes, digits switch tabs, r refreshes", () => {
	const { component, closed } = makeComponent();
	component.handleInput("\x1b");
	assert.equal(closed(), 1, "escape cancels");

	const tools = makeComponent();
	tools.component.handleInput("3");
	assert.equal(tools.closed(), 0, "switching tabs must not close");
	tools.component.handleInput("q");
	assert.equal(tools.closed(), 1, "q closes");
});

test("the HUD honors the injected keybindings for cancel", () => {
	const keybindings = getKeybindings();
	const { component, closed } = makeComponent({ keybindings });
	component.handleInput("\x1b");
	assert.equal(closed(), 1, "injected manager matched escape");
	component.handleInput("\x03");
	assert.equal(closed(), 2, "injected manager matched ctrl+c");
});

test("refresh reads the live host instead of cached state", () => {
	let tools = ["bash"];
	const { api } = fakePi({ getActiveTools: () => tools });
	const { ctx } = fakeCtx();
	const component = new LocalHudComponent(api, ctx, PLAIN_THEME, undefined, "tools", () => {});
	assert.ok(component.render(80).join("\n").includes("bash"));
	tools = ["grep"];
	component.handleInput("r");
	const text = component.render(80).join("\n");
	assert.ok(text.includes("grep"), "refresh picked up the new tool set");
});

test("readLocalSnapshot survives a context that throws", () => {
	const { api } = fakePi();
	const broken = {
		...fakeCtx().ctx,
		getContextUsage() {
			throw new Error("no usage");
		},
		modelRegistry: {
			getAvailable() {
				throw new Error("no registry");
			},
			getProviderDisplayName: (p) => p,
		},
	};
	const snapshot = readLocalSnapshot(api, broken);
	assert.equal(snapshot.context, null);
	assert.equal(snapshot.availableModels, 0);
});

test("the controller refuses a second overlay while one is open", async () => {
	const { api } = fakePi();
	const controller = createHudController(api);
	const { ctx, state } = fakeCtx();
	const first = controller.open(ctx, "session");
	await Promise.resolve();
	assert.equal(state.customCalls, 1);
	await controller.open(ctx, "models");
	assert.equal(state.customCalls, 1, "no stacked HUD");

	// The component renders through the public overlay.
	assert.ok(state.customComponent.render(60).length > 1);
	state.customClose(undefined);
	await first;
	assert.equal(controller.pending, false);
	const reopenedSameSession = controller.open(ctx, "models");
	await Promise.resolve();
	assert.equal(state.customCalls, 2, "reopening after close works");
	state.customClose(undefined);
	await reopenedSameSession;
});

test("dispose settles custom UI without hiding its overlay handle", async () => {
	const { api } = fakePi();
	const controller = createHudController(api);
	const { ctx, state } = fakeCtx();
	const pending = controller.open(ctx, "session");
	await Promise.resolve();
	assert.equal(state.customCalls, 1);
	controller.dispose();
	assert.equal(state.overlaysHidden, 0, "custom UI must close through done(), never handle.hide()");
	await Promise.race([
		pending,
		new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error("dispose must settle the pending custom promise")), 500);
			timer.unref();
		}),
	]);
	state.customClose(undefined); // Repeated late completion is harmless.
	assert.equal(controller.pending, false, "a late resolution leaves no lock behind");

	// A new session can open normally afterwards.
	const next = fakeCtx();
	const reopened = controller.open(next.ctx, "session");
	await Promise.resolve();
	assert.equal(next.state.customCalls, 1);
	next.state.customClose(undefined);
	await reopened;
});

test("the HUD refuses to open outside the TUI", async () => {
	const { api } = fakePi();
	const controller = createHudController(api);
	const { ctx, state } = fakeCtx({ mode: "print", hasUI: false });
	await controller.open(ctx, "session");
	assert.equal(state.customCalls, 0);
	assert.equal(state.notifications.at(-1)?.type, "warning");
});
