import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { entry, jiti, PLAIN_THEME } from "./helpers/harness.mjs";

const { glamBox } = await jiti.import(entry("editor-box.ts"));
const border = (text) => text;

/** What `Editor.render(width - 2)` looks like: borders plus padded content lines. */
function inner(width, content = ["", " hello "]) {
	const mid = Math.max(0, width - 2);
	const line = (text) => (text.length >= mid ? text.slice(0, mid) : text.padEnd(mid));
	return ["─".repeat(mid), ...content.map((text) => line(` ${text}`)), "─".repeat(mid)];
}

test("glamBox keeps the frame exactly as wide as the editor got", () => {
	for (let width = 16; width <= 40; width += 1) {
		const lines = glamBox(inner(width), width, PLAIN_THEME, border, { thinking: "medium", model: "gpt-5.6-terra", contextPercent: 42 });
		assert.equal(lines.length, inner(width).length, `line count at ${width}`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
		assert.equal(visibleWidth(lines[0]), width, `top border at ${width}`);
	}
});

test("narrow widths degrade instead of breaking", () => {
	for (let width = 0; width < 16; width += 1) {
		const input = width === 0 ? [] : inner(width);
		const lines = glamBox(input, width, PLAIN_THEME, border, {});
		assert.equal(lines.length, input.length);
		assert.deepEqual(lines, input);
	}
});

test("CJK and emoji content never overflow and the rail stays in front", () => {
	for (const width of [20, 40, 80, 120]) {
		const lines = glamBox(inner(width, ["漢字かな漢字", "🙂🙃 status"]), width, PLAIN_THEME, border, {
			thinking: "high",
			model: "漢字モデル",
			hiddenBottom: 3,
		});
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
		assert.ok(lines[1].startsWith("┃ "), "content rows start after the rail");
		if (width >= 40) assert.ok(lines[lines.length - 1].includes("↓3"), `scroll marker survives at ${width}`);
	}
});

test("the editor's autocomplete tail stays outside the frame", () => {
	const body = inner(40);
	const autocomplete = ["  bash   run a command", "  read   read a file"];
	const bottomIndex = body.length - 1;
	const lines = glamBox([...body, ...autocomplete], 40, PLAIN_THEME, border, {}, bottomIndex);
	assert.equal(lines.length, body.length + autocomplete.length);
	assert.deepEqual(lines.slice(body.length), autocomplete);
	assert.ok(lines[body.length - 1].startsWith("╰"), "status strip replaces the editor's border");
});

test("the status strip drops low-priority parts but keeps the model name", () => {
	const body = inner(44);
	const lines = glamBox(body, 44, PLAIN_THEME, border, { thinking: "medium", model: "gpt-5.6-terra", contextPercent: 90 });
	const row = lines[lines.length - 1];
	assert.ok(row.includes("med"), `thinking lost: ${row}`);
	assert.ok(row.includes("terra"), `model lost: ${row}`);
	assert.ok(!row.includes("90%"), `context should drop first: ${row}`);
});

test("control characters in model names never reach the frame", () => {
	const body = inner(60);
	const lines = glamBox(body, 60, PLAIN_THEME, border, { model: "evil\u001b[31m\u0007name" });
	const row = lines[lines.length - 1];
	assert.ok(!row.includes("\u0007"), "bell byte leaked");
	assert.ok(!row.includes("\u001b[31m"), "escape sequence leaked");
});
