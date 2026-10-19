/**
 * Pure renderer for the local session HUD.
 *
 * Shows only what the host already knows: session identity, working directory,
 * model and thinking level, context usage, and the tool surface. No backend,
 * no services, no polling — `readLocalSnapshot()` in hud.ts collects it once per
 * open or refresh, and this file turns it into bounded lines.
 *
 * Every line is exactly `width` columns; content is clipped to `height - 6` rows
 * and scrolled with an explicit offset, so the overlay never draws past the
 * terminal.
 */

import { fit, formatTokens, gauge, sanitize, bound } from "./text.mjs";

export const HUD_TABS = [
	{ id: "session", label: "session" },
	{ id: "models", label: "models" },
	{ id: "tools", label: "tools" },
];

export const HUD_HINTS = "1/2/3 tabs · ↑↓ scroll · r refresh · esc close";

export const hudContentRows = (height) => Math.max(1, Math.floor(Number(height) || 0) - 6);

const TAB_ORDER = HUD_TABS.map((tab) => tab.id);

export function normalizeTab(tab) {
	const id = String(tab ?? "").toLowerCase();
	if (TAB_ORDER.includes(id)) return id;
	const index = Number(tab);
	if (Number.isInteger(index) && index >= 1 && index <= HUD_TABS.length) return TAB_ORDER[index - 1];
	return "session";
}

export function nextTab(tab, step) {
	const index = TAB_ORDER.indexOf(normalizeTab(tab));
	const size = TAB_ORDER.length;
	return TAB_ORDER[(((index + step) % size) + size) % size];
}

function modelLine(snapshot) {
	const model = sanitize(snapshot.model, 48);
	const provider = sanitize(snapshot.provider, 24);
	const thinking = sanitize(snapshot.thinking, 12);
	const parts = [model || "no model selected"];
	if (provider) parts.push(provider);
	if (thinking) parts.push(`thinking ${thinking}`);
	return parts.join(" · ");
}

function contextLine(snapshot) {
	const context = snapshot.context;
	if (!context || !Number.isFinite(context.percent)) return "context unknown until the first response";
	const percent = Math.min(100, Math.max(0, context.percent));
	const tokens = Number.isFinite(context.tokens) ? formatTokens(context.tokens) : "?";
	const window = Number.isFinite(context.window) ? formatTokens(context.window) : "?";
	return `${gauge(percent / 100, 10)} ${Math.round(percent)}%  ${tokens}/${window} tokens`;
}

function sessionRows(snapshot) {
	const name = sanitize(snapshot.name, 48) || "unnamed session";
	const id = sanitize(snapshot.id, 48) || "unknown id";
	const cwd = sanitize(snapshot.cwd, 120) || "unknown cwd";
	const active = (snapshot.activeTools ?? []).length;
	return [
		["session", name],
		["id", id],
		["cwd", cwd],
		["model", modelLine(snapshot)],
		["context", contextLine(snapshot)],
		["tools", `${active} active`],
	];
}

function modelsRows(snapshot) {
	const scoped = snapshot.scopedModels ?? [];
	const rows = [["available", `${Number(snapshot.availableModels) || 0} models`]];
	if (scoped.length === 0) {
		rows.push(["scoped", "none — /ayla-ui models and /ayla-model search the full catalogue"]);
		return rows;
	}
	rows.push(["scoped", `${scoped.length} configured`]);
	for (const model of scoped) {
		const label = sanitize(model?.name ?? model?.id, 48) || "?";
		const provider = sanitize(model?.provider, 24);
		const current = model?.current ? "● " : "  ";
		rows.push([`${current}${label}`, provider]);
	}
	return rows;
}

function toolsRows(snapshot) {
	const active = snapshot.activeTools ?? [];
	const all = snapshot.allTools ?? [];
	if (active.length === 0) return [["tools", "none active"]];
	const rows = active.map((name) => ["active", sanitize(name, 32)]);
	const inactive = Math.max(0, all.length - active.length);
	if (inactive > 0) rows.push(["hidden", `${inactive} not active`]);
	return rows;
}

function rowsFor(tab, snapshot) {
	if (tab === "models") return modelsRows(snapshot);
	if (tab === "tools") return toolsRows(snapshot);
	return sessionRows(snapshot);
}

function tabBar(view, theme, innerWidth) {
	const labels = HUD_TABS.map((tab, index) => ` ${index + 1} ${tab.label} `);
	const parts = HUD_TABS.map((tab, index) =>
		tab.id === view.tab
			? theme.fg("accent", theme.bold(labels[index]))
			: theme.fg("dim", labels[index]),
	);
	const used = labels.reduce((total, label) => total + label.length, 0);
	const scroll = view.contentRows < view.totalRows ? `↓${view.totalRows - view.contentRows} ` : "";
	const gap = Math.max(0, innerWidth - used - scroll.length);
	return fit(parts.join("") + " ".repeat(gap) + theme.fg("warning", scroll), innerWidth);
}

export function buildHud(snapshot, view, width, height, theme) {
	const total = Math.max(0, Math.floor(Number(width) || 0));
	const rows = Math.max(1, Math.floor(Number(height) || 0));
	if (total === 0) return [];
	const inner = Math.max(1, total - 2);
	if (total < 12) return [bound(`${normalizeTab(view.tab)} HUD needs 12 columns`, total)];

	const tab = normalizeTab(view.tab);
	const contentBudget = hudContentRows(rows);
	const all = rowsFor(tab, snapshot);
	const totalRows = all.length;
	const maxOffset = Math.max(0, totalRows - contentBudget);
	const offset = Math.max(0, Math.min(maxOffset, Math.floor(Number(view.offset) || 0)));
	const content = all.slice(offset, offset + contentBudget);

	const viewState = { tab, offset, contentRows: content.length, totalRows };
	const lines = [];
	const title = "Ayla UI";
	lines.push(theme.fg("borderAccent", "╭─ ") + theme.bold(theme.fg("accent", title)) + theme.fg("borderAccent", " " + "─".repeat(Math.max(0, inner - title.length - 3)) + "╮"));
	lines.push(theme.fg("borderAccent", "│") + " " + tabBar(viewState, theme, inner - 2) + " " + theme.fg("borderAccent", "│"));
	lines.push(theme.fg("borderAccent", "├" + "─".repeat(inner) + "┤"));

	const labelWidth = 10;
	for (let i = 0; i < contentBudget; i += 1) {
		const row = content[i];
		if (!row) {
			lines.push(theme.fg("borderAccent", "│") + " ".repeat(inner) + theme.fg("borderAccent", "│"));
			continue;
		}
		const [label, value] = row;
		const labelText = fit(theme.fg("dim", label), labelWidth);
		const valueText = bound(theme.fg("text", value), inner - 2 - labelWidth);
		lines.push(theme.fg("borderAccent", "│") + " " + fit(labelText + valueText, inner - 2) + " " + theme.fg("borderAccent", "│"));
	}

	const position = totalRows > contentBudget ? `${offset + 1}-${offset + content.length}/${totalRows} · ` : "";
	lines.push(theme.fg("borderAccent", "│") + " " + fit(theme.fg("dim", position + HUD_HINTS), inner - 2) + " " + theme.fg("borderAccent", "│"));
	lines.push(theme.fg("borderAccent", "╰" + "─".repeat(inner) + "╯"));
	return lines;
}

export function hudMaxOffset(snapshot, tab, height) {
	return Math.max(0, rowsFor(normalizeTab(tab), snapshot).length - hudContentRows(height));
}
