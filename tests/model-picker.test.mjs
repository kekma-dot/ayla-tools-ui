import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { entry, fakeCtx, fakePi, jiti, PLAIN_THEME } from "./helpers/harness.mjs";

const module = await jiti.import(entry("model-picker.ts"));
const { ModelPicker, matchesQuery, modelKey, pickerLayout, toPickerModels } = module;

const keybindings = getKeybindings();

const MODELS = [
	{ provider: "openai-codex", id: "terra", name: "terra", contextWindow: 200_000 },
	{ provider: "deepseek", id: "flash", name: "deepseek flash", contextWindow: 128_000 },
	{ provider: "kimi", id: "k3", name: "Kimi K3", contextWindow: 256_000 },
].map((model) => ({ ...model }));

const pickerModels = () => toPickerModels(MODELS, (provider) => provider, "openai-codex/terra");

function makePicker(overrides = {}) {
	const picked = [];
	const term = overrides.term ?? (() => ({ columns: 80, rows: 24 }));
	const picker = new ModelPicker(
		PLAIN_THEME,
		overrides.models ?? pickerModels(),
		overrides.recent ?? [],
		(value) => picked.push(value),
		overrides.keybindings ?? keybindings,
		term,
	);
	return { picker, picked };
}

test("model labels are sanitized and carry provider meta", () => {
	const dirty = [
		{ provider: "evil\u001b[31mprov", id: "id", name: "name\u0007x", contextWindow: 1000 },
	];
	const [item] = toPickerModels(dirty, (p) => p);
	assert.ok(!item.label.includes("\u0007"), "bell leaked into label");
	assert.ok(!item.description.includes("\u001b[31m"), "escape leaked into description");
	assert.equal(item.value, "evil\u001b[31mprov/id");
	assert.ok(item.description.includes("1k ctx"));
});

test("query matching is case-insensitive and token based", () => {
	assert.ok(matchesQuery("deepseek flash deepseek/flash", "deep"));
	assert.ok(matchesQuery("deepseek flash deepseek/flash", "FLASH deep"));
	assert.ok(!matchesQuery("kimi k3", "terra"));
	assert.equal(modelKey({ provider: "a", id: "b" }), "a/b");
});

test("the panel never asks for more columns or rows than the terminal has", () => {
	for (const columns of [4, 10, 26, 80, 200]) {
		const layout = pickerLayout({ columns, rows: 24 });
		assert.ok(layout.width <= columns, `width ${layout.width} > ${columns} columns`);
		assert.ok(layout.width >= 1);
	}
	for (const rows of [4, 10, 14, 30]) {
		const layout = pickerLayout({ columns: 80, rows });
		assert.ok(layout.maxVisible >= 1);
		assert.ok(layout.maxVisible <= rows, `visible ${layout.maxVisible} > ${rows} rows`);
		assert.ok(layout.maxHeight <= rows, `maxHeight ${layout.maxHeight} > ${rows} rows`);
	}
});

test("rendering stays inside the width at every size, including CJK and emoji", () => {
	const { picker } = makePicker({
		models: toPickerModels(
			[
				{ provider: "p", id: "漢字", name: "漢字モデル 🙂", contextWindow: 1000 },
				...MODELS,
			],
			(provider) => provider,
		),
	});
	for (const width of [1, 5, 8, 16, 20, 40, 80, 120]) {
		for (const line of picker.render(width)) {
			assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("typing filters, enter picks, escape cancels", () => {
	const typed = makePicker();
	typed.picker.handleInput("f");
	typed.picker.handleInput("l");
	typed.picker.handleInput("a");
	typed.picker.handleInput("\r");
	assert.deepEqual(typed.picked, ["deepseek/flash"], "typed query selected the matching model");

	const cancelled = makePicker();
	cancelled.picker.handleInput("\x1b");
	assert.deepEqual(cancelled.picked, [null]);

	const ctrlC = makePicker();
	ctrlC.picker.handleInput("\x03");
	assert.deepEqual(ctrlC.picked, [null], "ctrl+c is a host cancel key");
});

test("navigation uses the injected keybindings", () => {
	const { picker, picked } = makePicker();
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	assert.deepEqual(picked, ["deepseek/flash"], "down moved the selection");
});

test("the visible list shrinks when the terminal does", () => {
	const many = toPickerModels(
		Array.from({ length: 10 }, (_value, index) => ({
			provider: "p",
			id: `model-${index}`,
			name: `model ${index}`,
			contextWindow: 1000,
		})),
		(provider) => provider,
	);
	let size = { columns: 80, rows: 40 };
	const { picker } = makePicker({ models: many, term: () => size });
	const tall = picker.render(60).length;
	size = { columns: 80, rows: 12 };
	const short = picker.render(60).length;
	assert.ok(short < tall, `list did not shrink with the terminal: ${short} vs ${tall}`);
	assert.ok(short >= 6, "header, search and hint stay");
	size = { columns: 80, rows: 40 };
	assert.equal(picker.render(60).length, tall, "and it grows back");
});

test("mouse clicks below the list are not forwarded into the list", () => {
	const { picker, picked } = makePicker();
	const lines = picker.render(60);
	const listLines = lines.length - 5;
	assert.equal(
		picker.handleMouse({ type: "click", button: "left", x: 1, y: 3 + listLines, width: 60, height: 24 }),
		undefined,
	);
	picker.handleMouse({ type: "press", button: "left", x: 1, y: 3, width: 60, height: 24 });
	picker.handleMouse({ type: "click", button: "left", x: 1, y: 3, width: 60, height: 24 });
	assert.equal(picked.length, 1, "a click inside the list still selects");
});

test("focus forwards to the search field so IME has a cursor", () => {
	const { picker } = makePicker();
	const unfocused = picker.render(60).join("\n");
	picker.focused = true;
	const focused = picker.render(60).join("\n");
	assert.equal(picker.focused, true);
	assert.ok(focused.includes("\x1b_pi:c\x07"), "hardware cursor marker missing while focused");
	assert.ok(!unfocused.includes("\x1b_pi:c\x07"), "no cursor marker while blurred");
});

test("a session shutdown drops a pending pick instead of switching models", async () => {
	let setModelCalls = 0;
	const { api, commands, emit } = fakePi({
		setModel: async () => {
			setModelCalls += 1;
			return true;
		},
	});
	const extension = (await jiti.import(entry("model-picker.ts"))).default;
	extension(api);
	const { ctx, state } = fakeCtx({
		availableModels: MODELS,
		model: MODELS[0],
	});
	const pending = commands.get("ayla-model").handler("", ctx);
	await Promise.resolve();
	assert.equal(state.customCalls, 1);

	await emit("session_shutdown", ctx);
	state.customClose("deepseek/flash");
	await pending;

	assert.equal(setModelCalls, 0, "a pick from the dead session must not switch models");
	assert.ok(
		state.notifications.every((item) => item.type !== "info"),
		`stale session was notified: ${JSON.stringify(state.notifications)}`,
	);
});

test("a model change that resolves after shutdown cannot notify the old session", async () => {
	for (const changed of [true, false]) {
		let resolveChange;
		const { api, commands, emit } = fakePi({
			setModel: () => new Promise((resolve) => { resolveChange = resolve; }),
		});
		const extension = (await jiti.import(entry("model-picker.ts"))).default;
		extension(api);
		const { ctx, state } = fakeCtx({ availableModels: MODELS, model: MODELS[0] });
		const pending = commands.get("ayla-model").handler("", ctx);
		await Promise.resolve();
		state.customClose("deepseek/flash");
		await Promise.resolve();
		assert.equal(typeof resolveChange, "function");
		await emit("session_shutdown", ctx);
		resolveChange(changed);
		await pending;
		assert.deepEqual(state.notifications, [], `late changed=${changed} must be silent`);
	}
});

test("a live pick does switch the model and reports it once", async () => {
	let setModelCalls = 0;
	const { api, commands } = fakePi({
		setModel: async () => {
			setModelCalls += 1;
			return true;
		},
	});
	const extension = (await jiti.import(entry("model-picker.ts"))).default;
	extension(api);
	const { ctx, state } = fakeCtx({ availableModels: MODELS, model: MODELS[0] });
	const pending = commands.get("ayla-model").handler("", ctx);
	await Promise.resolve();
	state.customClose("deepseek/flash");
	await pending;
	assert.equal(setModelCalls, 1);
	assert.equal(state.notifications.filter((item) => item.type === "info").length, 1);
});

test("a picker opened outside the TUI only reports", async () => {
	const { api, commands, emit } = fakePi();
	const extension = (await jiti.import(entry("model-picker.ts"))).default;
	extension(api);
	const { ctx, state } = fakeCtx({ mode: "rpc", hasUI: true, availableModels: MODELS });
	await emit("session_start", ctx);
	await commands.get("ayla-model").handler("", ctx);
	assert.equal(state.customCalls, 0);
	assert.equal(state.notifications.at(-1)?.type, "warning");
});
