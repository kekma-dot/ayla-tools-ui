/**
 * Input frame: a left rail plus a status strip along the bottom edge.
 *
 * Geometry: the editor is rendered two columns narrower and every assembled
 * line is exactly `width` visible columns, otherwise the TUI would clip the
 * tail. The status strip gives up its parts by priority (context first, then
 * the model name), and styling is applied only after fitting so truncation
 * never lands inside an escape sequence.
 *
 * `bottomIndex` points at the editor's own bottom border inside `inner`: the
 * strip replaces that line, and anything after it (the autocomplete list) stays
 * outside the frame, exactly as the editor laid it out.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { fit, gauge, shortModel, shortThinking } from "./text.mjs";

export type BoxTheme = { fg(color: string, text: string): string; bold(text: string): string };

export type BoxData = {
	thinking?: string;
	model?: string;
	contextPercent?: number | null;
	/** Editor lines hidden below the visible area. */
	hiddenBottom?: number;
};

const GAUGE_CELLS = 5;
const LEFT_GAP = " · ";
const RIGHT_GAP = "  ";

type Part = { side: "left" | "right"; text: string; paint: (text: string) => string; priority: number };

const sumWidth = (parts: Part[]) => parts.reduce((total, part) => total + visibleWidth(part.text), 0);
const gapWidth = (parts: Part[]) =>
	Math.max(0, parts.length - 1) * (parts[0]?.side === "right" ? RIGHT_GAP.length : LEFT_GAP.length);

export function glamBox(
	inner: string[],
	width: number,
	theme: BoxTheme,
	border: (text: string) => string,
	data: BoxData = {},
	bottomIndex = inner.length - 1,
): string[] {
	const total = Math.max(0, Math.floor(width));
	const mid = total - 2;
	if (inner.length < 2 || mid < 14 || bottomIndex < 1 || bottomIndex >= inner.length) return inner;

	const dim = (text: string) => theme.fg("dim", text);
	const parts: Part[] = [];
	const add = (side: Part["side"], text: string | undefined, paint: Part["paint"], priority: number) => {
		if (text) parts.push({ side, text, paint, priority });
	};
	add("left", shortThinking(data.thinking), (text) => theme.fg("accent", theme.bold(text)), 3);
	add("left", shortModel(data.model), dim, 2);
	add("right", data.hiddenBottom ? `↓${data.hiddenBottom}` : undefined, (text) => theme.fg("warning", text), 3);
	add("right", "ctrl+p models", (text) => theme.fg("accent", theme.bold("ctrl+p")) + dim(text.slice(6)), 3);
	if (typeof data.contextPercent === "number" && Number.isFinite(data.contextPercent)) {
		const percent = Math.min(100, Math.max(0, data.contextPercent));
		add("right", `${gauge(percent / 100, GAUGE_CELLS)} ${Math.round(percent)}%`, dim, 1);
	}

	// Keep at least two columns of the frame's fill line.
	while (parts.length > 0 && sumWidth(parts) + gapWidth(parts) + 6 > mid) {
		let worst = 0;
		for (let i = 1; i < parts.length; i += 1) if (parts[i].priority < parts[worst].priority) worst = i;
		parts.splice(worst, 1);
	}

	const left = parts.filter((part) => part.side === "left");
	const right = parts.filter((part) => part.side === "right");
	const used = sumWidth(left) + gapWidth(left) + sumWidth(right) + gapWidth(right);
	const fill = Math.max(0, mid - 2 - used - (left.length ? 1 : 0) - (right.length ? 1 : 0));

	const statusRow =
		border("╰") +
		" " +
		left.map((part) => part.paint(part.text)).join(dim(LEFT_GAP)) +
		(left.length ? " " : "") +
		border("─".repeat(fill)) +
		(right.length ? " " : "") +
		right.map((part) => part.paint(part.text)).join(dim(RIGHT_GAP)) +
		" " +
		border("╯");

	const lines: string[] = [border("╭") + fit(inner[0], mid) + border("╮")];
	for (let i = 1; i < bottomIndex; i += 1) lines.push(border("┃") + " " + fit(inner[i], mid));
	lines.push(visibleWidth(statusRow) <= total ? statusRow : fit(statusRow, total));
	// Autocomplete list and anything else the editor appended after its border.
	for (let i = bottomIndex + 1; i < inner.length; i += 1) lines.push(inner[i]);
	return lines;
}
