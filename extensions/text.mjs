/**
 * Text helpers shared by the Ayla UI surfaces.
 *
 * Everything that reaches a terminal goes through here first: display strings
 * come from models, providers, extension statuses and shared signals, so they
 * are untrusted and may carry control bytes or escape sequences.
 *
 * Width measurement and truncation come from the host TUI (`visibleWidth`,
 * `truncateToWidth`) so CJK, emoji, combining marks and APC markers (the IME
 * cursor marker) measure exactly like the rest of Pi.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth };

const ANSI = /\x1b\[[0-9:;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Strip escapes/control bytes, collapse whitespace, cap the run length. */
export function sanitize(value, max = 96) {
	const text = typeof value === "string" ? value : value == null ? "" : String(value);
	const clean = text
		.replace(ANSI, "")
		.replace(CONTROL, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!Number.isFinite(max) || max <= 0) return clean;
	if (visibleWidth(clean) <= max) return clean;
	const cut = truncateToWidth(clean, Math.max(1, Math.floor(max)), "…");
	return visibleWidth(cut) <= max ? cut : truncateToWidth(clean, Math.max(1, Math.floor(max)), "");
}

/** Non-negative integer column budget, or 0 when the value is not usable. */
export function columns(width) {
	const value = Number(width);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * Terminal size with a stable fallback. Read-only: no writes, no polling.
 * Overlays size themselves from this so a narrow or short window never asks for
 * more columns or rows than the terminal has.
 */
export function terminalSize(stream = process.stdout) {
	const width = Number(stream?.columns);
	const height = Number(stream?.rows);
	return {
		columns: Number.isFinite(width) && width > 0 ? Math.floor(width) : 80,
		rows: Number.isFinite(height) && height > 0 ? Math.floor(height) : 24,
	};
}

/** Truncate styled text to `width`; returns "" for a non-positive budget. */
export function bound(styled, width) {
	const w = columns(width);
	if (w <= 0) return "";
	const cut = truncateToWidth(String(styled ?? ""), w, "");
	return visibleWidth(cut) <= w ? cut : "";
}

/** Pad styled text to exactly `width` columns, truncating when it is longer. */
export function fit(styled, width) {
	const w = columns(width);
	if (w <= 0) return "";
	const text = String(styled ?? "");
	const visible = visibleWidth(text);
	const cut = visible === w ? text : visible > w ? truncateToWidth(text, w, "") : text;
	const cutWidth = visibleWidth(cut);
	// A wide character on the boundary can leave one column empty; pad so callers
	// always get an exact block without ever exceeding the budget.
	return cutWidth === w ? cut : cut + " ".repeat(Math.max(0, w - cutWidth));
}

/** `~`-relative path, shortened from the left to fit `max` columns. */
export function shortenPath(value, home = process.env.HOME, max = 28) {
	let path = sanitize(value, 200);
	if (!path) return "";
	if (home && path === home) path = "~";
	else if (home && path.startsWith(`${home}/`)) path = `~${path.slice(home.length)}`;
	if (visibleWidth(path) <= max) return path;
	const parts = path.split("/").filter(Boolean);
	const tail = parts.slice(-1)[0] ?? path;
	const trimmed = `…/${tail}`;
	if (visibleWidth(trimmed) <= max) return trimmed;
	if (visibleWidth(tail) <= max) return tail;
	return truncateToWidth(tail, Math.max(1, max), "…");
}

/** `gpt-5.6-terra` -> `terra`, `k3` -> `k3`. Only shortens a recognised prefix. */
export function shortModel(id) {
	const clean = sanitize(id, 64);
	if (!clean) return "";
	return clean.replace(/^gpt-/, "").replace(/^[\d.]+-/, "") || clean;
}

const THINKING_LABEL = {
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "xhi",
	max: "max",
	off: "",
	none: "",
};

export function shortThinking(level) {
	return THINKING_LABEL[String(level ?? "").toLowerCase()] ?? sanitize(level, 6);
}

export function formatTokens(count) {
	const value = Number(count);
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Bar of `cells` columns; `fraction` is clamped to 0..1. */
export function gauge(fraction, cells = 5, on = "▓", off = "░") {
	const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
	const filled = Math.round(safe * cells);
	return on.repeat(filled) + off.repeat(Math.max(0, cells - filled));
}
