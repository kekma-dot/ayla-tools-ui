import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { assertFits, fakeCtx, fakePi, fakeTui, load, PLAIN_THEME } from "./helpers/harness.mjs";

const footerExtension = await load("footer.ts");

const statuses = (entries) => ({
	get: (key) => entries[key],
	keys: () => Object.keys(entries),
});

/** Install the footer and return the live component the host would render. */
async function install(overrides = {}) {
	const { api, emit } = fakePi();
	footerExtension(api);
	const { ctx, state } = fakeCtx(overrides);
	await emit("session_start", ctx);
	const factory = state.footerFactory;
	if (!factory) return { api, emit, ctx, state, component: undefined };
	const data = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses(overrides.statuses ?? {}),
		onBranchChange: () => () => {},
	};
	const component = factory(fakeTui(), PLAIN_THEME, data);
	return { api, emit, ctx, state, component, factory };
}

test("rows never exceed the columns the host gives us", async () => {
	const { component } = await install();
	for (let width = 1; width <= 40; width += 1) {
		assertFits(assert, component.render(width), width, `footer@${width} `);
	}
	for (const width of [80, 120]) assertFits(assert, component.render(width), width, `footer@${width} `);
});

test("a foreign status stays visible, our own keys are not duplicated", async () => {
	const { component } = await install({
		statuses: {
			mcp: "MCP 1/4",
			"ayla-voice": "mic live",
			warning: "sandbox limited",
		},
	});
	const text = component.render(120).join("\n");
	assert.ok(text.includes("sandbox limited"), `foreign status lost: ${text}`);
	assert.ok(!text.includes("mic live"), "ayla-voice is drawn by the chip, not twice");
	assert.ok(!text.includes("MCP 1/4"), "partial MCP is not a row of its own");
});

test("a control sequence in a status never reaches the terminal", async () => {
	const { component } = await install({ statuses: { risky: "bad\u001b[31mred\u0007text" } });
	const text = component.render(120).join("\n");
	assert.ok(!text.includes("\u001b[31m"), "escape sequence leaked");
	assert.ok(!text.includes("\u0007"), "bell leaked");
	assert.ok(text.includes("red text"), `text not sanitized: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("\u001b"), "escape byte remained");
});

test("token stats read the active branch, not abandoned branches", async () => {
	const { api, commands, emit } = fakePi();
	footerExtension(api);
	const active = [
		{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 10, cost: { total: 0.01 } } } },
	];
	const abandoned = [
		{ type: "message", message: { role: "assistant", usage: { input: 900_000, output: 5, cost: { total: 9 } } } },
	];
	const { ctx, state } = fakeCtx({ branchEntries: active, entries: [...active, ...abandoned] });
	await emit("session_start", ctx);
	state.footerFactory(fakeTui(), PLAIN_THEME, {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses({}),
		onBranchChange: () => () => {},
	});
	await commands.get("ayla-footer").handler("status", ctx);
	const message = state.notifications.at(-1).message;
	assert.match(message, /↑1\.0k ↓10/, `active branch totals missing: ${message}`);
	assert.ok(!message.includes("900k"), `abandoned branch leaked into usage: ${message}`);
});

test("another owner's footer is never blanked at shutdown", async () => {
	const { emit, ctx, state, component } = await install();
	// The host disposes our component when another extension installs its own footer.
	component.dispose();
	await emit("session_shutdown", ctx);
	assert.equal(state.footerCleared, 0, "a replaced footer must not be cleared");
});

test("our own footer is cleared at shutdown", async () => {
	const { emit, ctx, state } = await install();
	await emit("session_shutdown", ctx);
	assert.equal(state.footerCleared, 1);
});

test("no timer runs while idle, headless, or after the footer was replaced", async () => {
	const intervals = { created: 0, cleared: 0 };
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	globalThis.setInterval = (fn, ms, ...rest) => {
		intervals.created += 1;
		return realSet(fn, ms, ...rest);
	};
	globalThis.clearInterval = (handle) => {
		intervals.cleared += 1;
		return realClear(handle);
	};
	try {
		const { api, emit, ctx, state } = await install();
		assert.equal(intervals.created, 0, "installing must not start a timer");

		await emit("agent_start", ctx);
		assert.equal(intervals.created, 1, "streaming starts one timer");
		await emit("agent_settled", ctx);
		assert.equal(intervals.cleared, 1, "settling stops it");

		state.footerFactory(fakeTui(), PLAIN_THEME, {
			getGitBranch: () => null,
			getExtensionStatuses: () => statuses({}),
			onBranchChange: () => () => {},
		}).dispose();
		await emit("agent_start", ctx);
		assert.equal(intervals.created, 1, "a disposed footer must not restart its timer");

		// Headless session: the extension must install nothing at all.
		const { api: headlessApi, emit: headlessEmit } = fakePi();
		footerExtension(headlessApi);
		const headless = fakeCtx({ mode: "print", hasUI: false });
		await headlessEmit("session_start", headless.ctx);
		assert.equal(headless.state.footerFactory, undefined, "no footer outside the TUI");
		await headlessEmit("agent_start", headless.ctx);
		assert.equal(intervals.created, 1, "headless streaming must not start a timer");
	} finally {
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
});

test("a narrow footer still shows something rather than empty lines", async () => {
	const { component } = await install();
	const lines = component.render(20);
	assert.ok(lines.length >= 1);
	for (const line of lines) assert.ok(visibleWidth(line) > 0);
});
