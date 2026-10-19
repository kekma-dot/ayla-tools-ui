/**
 * Pure layout model for the compact footer.
 *
 * No I/O, no theme, no timers: every function is deterministic, so the footer
 * renderer stays a thin wire-up and the row fitting is unit tested. Segments
 * carry a severity token; the renderer maps tokens to `theme.fg(...)`.
 *
 * Signals arrive through the optional shared contract (`./contract.mjs`) so a
 * producer such as a voice extension and this footer agree even when the host
 * loads their modules separately. Nothing here reads the network or the disk.
 */

import { formatCountdown, readSignals, signalStore } from "./contract.mjs";
import { sanitize, shortenPath, visibleWidth } from "./text.mjs";

export { readSignals, signalStore, formatCountdown };

const width = (text) => visibleWidth(String(text ?? ""));

/** Four-step microphone meter; `level` is normalised 0..1 RMS. */
export function levelBar(level, cells = 3) {
	const steps = ["▁", "▃", "▅", "▇"];
	const safe = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
	const count = Math.max(1, Math.min(cells, Math.ceil(safe * steps.length) || 1));
	return steps.slice(0, count).join("");
}

function segment(id, texts, severity, priority, extra = {}) {
	const list = (Array.isArray(texts) ? texts : [texts])
		.map((item) => (typeof item === "string" ? { text: item, parts: [{ text: item, severity }] } : item))
		.filter((item) => item && typeof item.text === "string" && item.text.length > 0);
	return { id, texts: list, level: 0, severity, priority, ...extra };
}

function variant(item) {
	return item.texts[Math.min(item.level, Math.max(0, item.texts.length - 1))];
}

export function segmentText(item) {
	return variant(item)?.text ?? "";
}

export function segmentParts(item) {
	const chosen = variant(item);
	if (!chosen) return [];
	return chosen.parts ?? [{ text: chosen.text, severity: item.severity }];
}

function cwdSegment(state) {
	const branch = sanitize(state.branch ?? "", 24);
	const long = shortenPath(state.cwd, state.home, 26);
	if (!long) return null;
	const short = shortenPath(state.cwd, state.home, 10);
	const texts = branch ? [`${long} ${branch}`, long, short] : [long, short];
	return segment("cwd", texts, "text", 100);
}

/** Optional voice signal, exactly as the producer published it. */
function voiceChip(voice) {
	if (!voice) return null;
	if (voice.blocked) return segment("voice", ["✖ mic blocked", "✖ mic"], "error", 90);
	if (voice.external) {
		const label = sanitize(voice.external.label ?? "", 20);
		return segment("voice", [`mic ▷ ${label || "other session"}`, "mic ▷ other"], "warning", 70);
	}
	const state = String(voice.state ?? "off");
	if (state === "off") return segment("voice", ["mic ○"], "dim", 40);
	if (state === "error") return segment("voice", ["✖ mic error", "✖ mic"], "error", 90);
	if (state === "connecting" || state === "stopping") return segment("voice", ["mic …"], "warning", 75);
	const mic = String(voice.microphone ?? "");
	if (mic === "muted") return segment("voice", ["mic muted", "mic …"], "warning", 75);
	const live = mic === "signal" || mic === "ok";
	return segment("voice", [live ? "mic ●" : "mic ○"], live ? "success" : "dim", 70);
}

function micMeter(voice) {
	if (!voice || String(voice.state) !== "connected" || String(voice.microphone) !== "signal") return null;
	const level = Number(voice.level);
	if (!Number.isFinite(level)) return null;
	return segment("meter", levelBar(level), "success", 40);
}

function workingChip(working) {
	if (!working?.active) return null;
	const rate = Number(working.tokensPerSecond);
	const text = Number.isFinite(rate) && rate > 0 ? `⣷ ${Math.round(rate)} t/s` : "⣷";
	return segment("tps", text, "accent", 65);
}

/** `MCP 4/8` / `MCP 1/8 connecting to x` -> counts; anything else -> null. */
export function parseMcpStatus(statuses) {
	if (!statuses) return null;
	const raw = typeof statuses.get === "function" ? statuses.get("mcp") : statuses;
	const match = /^MCP (\d+)\/(\d+)/i.exec(sanitize(raw, 160));
	if (!match) return null;
	const connected = Number(match[1]);
	const total = Number(match[2]);
	if (!Number.isFinite(connected) || !Number.isFinite(total) || total <= 0) return null;
	return { connected, total };
}

/** Only a total MCP dropout is worth a row of its own; partial state lives in /ayla-footer status. */
function mcpChip(mcp) {
	if (!mcp || mcp.connected > 0 || mcp.total <= 0) return null;
	return segment("mcp", [`✖ mcp 0/${mcp.total}`, "✖ mcp"], "error", 75);
}

/** Token totals, cost and cache share, for /ayla-footer status only. */
export function tokenLine(tokens = {}) {
	const bits = [`↑${formatTokens(Number(tokens.input) || 0)} ↓${formatTokens(Number(tokens.output) || 0)}`];
	const cost = Number(tokens.cost) || 0;
	const cacheHit = Number(tokens.cacheHit) || 0;
	if (cost > 0) bits.push(`$${cost.toFixed(2)}`);
	if (cacheHit > 0) bits.push(`ch ${Math.round(cacheHit * 100)}%`);
	return bits.join("   ");
}

function formatTokens(count) {
	const value = Number(count);
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function buildRows(state = {}, width = 80, options = {}) {
	const mode = options.mode ?? state.mode ?? "auto";
	const columns = Math.max(0, Math.floor(Number(width) || 0));
	if (columns === 0) return { rows: [[]], mode: "single", events: [], dropped: [], shrunk: [] };

	const voice = voiceChip(state.voice);
	const row1 = [cwdSegment(state)];
	if (voice) row1.push(voice);
	const meter = micMeter(state.voice);
	if (meter) row1.push(meter);
	const working = workingChip(state.working);
	if (working) row1.push(working);
	const mcp = mcpChip(state.mcp);
	if (mcp) row1.push(mcp);

	// Statuses this footer does not draw stay visible: replacing the built-in
	// footer must never silently hide another producer's warning.
	const row2 = [];
	for (const extra of state.extras ?? []) {
		const text = sanitize(extra?.text, 60);
		if (!text) continue;
		row2.push(segment(`extra:${sanitize(extra?.key, 24)}`, text, extra?.severity ?? "muted", 32));
	}

	const events = [];
	if (state.working?.active) events.push("working");
	if (voice && voice.severity !== "success") events.push("voice");
	if (mcp) events.push("mcp");
	if (row2.length > 0) events.push("extra");

	const double = mode === "always" || (mode !== "never" && row2.length > 0 && events.length > 0);
	const dropped = [];
	const shrunk = [];
	const rows = [fitRow(row1.filter(Boolean), columns, dropped, shrunk)];
	if (double) rows.push(fitRow(row2, columns, dropped, shrunk));
	return { rows, mode: double ? "double" : "single", events, dropped, shrunk };
}

function rowWidth(list) {
	return list.map((item) => width(segmentText(item))).reduce((a, b) => a + b, 0) +
		Math.max(0, list.length - 1) * 3;
}

function groupOf(item) {
	return item.group ?? item.id;
}

function lowestPriorityGroup(list) {
	const groups = new Map();
	list.forEach((item, index) => {
		const key = groupOf(item);
		const entry = groups.get(key);
		if (entry) {
			entry.priority = Math.min(entry.priority, item.priority);
			entry.indexes.push(index);
		} else {
			groups.set(key, { key, priority: item.priority, indexes: [index] });
		}
	});
	let worst;
	for (const entry of groups.values()) {
		if (!worst || entry.priority < worst.priority || (entry.priority === worst.priority && entry.indexes[0] > worst.indexes[0])) {
			worst = entry;
		}
	}
	return worst;
}

function fitRow(segments, columns, dropped, shrunk) {
	const list = segments.filter(Boolean);
	if (columns <= 0) {
		for (const item of list) dropped.push(groupOf(item));
		return [];
	}
	while (list.length > 1 && rowWidth(list) > columns) {
		// Compress level by level, least important first.
		let shrinkIndex = -1;
		for (let i = 0; i < list.length; i += 1) {
			if (list[i].level >= list[i].texts.length - 1) continue;
			if (shrinkIndex === -1) {
				shrinkIndex = i;
				continue;
			}
			const candidate = list[i];
			const best = list[shrinkIndex];
			if (candidate.level !== best.level) {
				if (candidate.level < best.level) shrinkIndex = i;
			} else if (candidate.priority < best.priority) {
				shrinkIndex = i;
			}
		}
		if (shrinkIndex !== -1) {
			list[shrinkIndex].level += 1;
			shrunk.push(list[shrinkIndex].id);
			continue;
		}
		const group = lowestPriorityGroup(list);
		if (!group) break;
		dropped.push(group.key);
		for (let i = group.indexes.length - 1; i >= 0; i -= 1) list.splice(group.indexes[i], 1);
	}
	if (list.length === 1 && rowWidth(list) > columns) {
		while (list[0].level < list[0].texts.length - 1 && rowWidth(list) > columns) {
			list[0].level += 1;
			shrunk.push(list[0].id);
		}
		if (rowWidth(list) > columns) {
			dropped.push(groupOf(list[0]));
			list.pop();
		}
	}
	return list;
}

export function joinSegments(segments) {
	return segments.map(segmentText).join(" · ");
}

export function renderPlain(rows) {
	return rows.map((row) => joinSegments(row));
}
