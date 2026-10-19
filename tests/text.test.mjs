import assert from "node:assert/strict";
import test from "node:test";
import {
	bound,
	columns,
	fit,
	formatTokens,
	gauge,
	sanitize,
	shortModel,
	shortThinking,
	shortenPath,
	terminalSize,
	visibleWidth,
} from "../extensions/text.mjs";

test("sanitize strips escapes and control bytes, collapses whitespace, caps width", () => {
	assert.equal(sanitize("\u001b[31mred\u001b[0m"), "red");
	assert.equal(sanitize("a\u0000b\u0007c\u009bd"), "a b c d");
	assert.equal(sanitize("  spaced   out  "), "spaced out");
	assert.equal(sanitize(undefined), "");
	assert.equal(sanitize(42), "42");
	const capped = sanitize("x".repeat(200), 10);
	assert.ok(visibleWidth(capped) <= 10, `expected <= 10 columns, got ${visibleWidth(capped)}`);
});

test("fit and bound keep the allocated columns for wide characters", () => {
	for (const width of [1, 2, 5, 8, 16, 20, 40, 80, 120]) {
		for (const text of ["plain", "漢字かな", "🙂🙃 emoji", "\u001b[32mgreen\u001b[0m", "a漢b🙂c"]) {
			assert.equal(visibleWidth(fit(text, width)), width, `fit(${JSON.stringify(text)}, ${width})`);
			assert.ok(visibleWidth(bound(text, width)) <= width, `bound(${JSON.stringify(text)}, ${width})`);
		}
	}
	assert.equal(fit("abc", 0), "");
	assert.equal(bound("abc", 0), "");
	assert.equal(columns(-5), 0);
	assert.equal(columns(4.7), 4);
});

test("shortenPath trims from the left and never exceeds its budget", () => {
	const home = "/Users/example";
	assert.equal(shortenPath(`${home}/projects/long-name`, home, 40), "~/projects/long-name");
	assert.equal(shortenPath(`${home}/projects/long-name`, home, 12), "…/long-name");
	const tight = shortenPath(`${home}/a/very-long-directory-name`, home, 5);
	assert.ok(visibleWidth(tight) <= 5, `short path wider than 5: ${tight}`);
});

test("model and thinking labels stay short and safe", () => {
	assert.equal(shortModel("gpt-5.6-terra"), "terra");
	assert.equal(shortModel("k3"), "k3");
	assert.equal(shortThinking("medium"), "med");
	assert.equal(shortThinking("off"), "");
	assert.equal(shortThinking("\u001b[31mweird\u001b[0m"), "weird");
});

test("gauge, tokens and terminal size are bounded", () => {
	assert.equal(gauge(0, 5), "░░░░░");
	assert.equal(gauge(1, 5), "▓▓▓▓▓");
	assert.equal(gauge(2, 5), "▓▓▓▓▓");
	assert.equal(gauge(-1, 5), "░░░░░");
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(2_500_000), "2.5M");
	assert.deepEqual(terminalSize({ columns: 100, rows: 40 }), { columns: 100, rows: 40 });
	assert.deepEqual(terminalSize({}), { columns: 80, rows: 24 });
	assert.deepEqual(terminalSize({ columns: -1, rows: 0 }), { columns: 80, rows: 24 });
});
