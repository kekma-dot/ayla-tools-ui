/**
 * Model picker overlay.
 *
 * A search field and a list, both host widgets (`Input` and `SelectList` from
 * the TUI), so typing, paste, IME, mouse hover/click and the "no match" state
 * behave like the rest of Pi. Key handling goes through the `KeybindingsManager`
 * the host injects, so a user's own select bindings work here too.
 *
 * The panel is sized from the live terminal on every render: it never asks for
 * more columns than the window has, and the visible list shrinks when the
 * terminal does. `/model` stays the host's command; this is `/ayla-model` and it
 * rebinds no key.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { Input, SelectList } from "@earendil-works/pi-tui";
import type {
	Component,
	SelectItem,
	SelectListTheme,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fit, sanitize, terminalSize } from "./text.mjs";

type AnyModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

const MAX_WIDTH = 72;
const RECENT_LIMIT = 5;
const LIST_TOP = 3;
const MAX_VISIBLE = 12;

export const modelKey = (model: AnyModel): string => `${model.provider}/${model.id}`;

function contextSize(size: number | undefined): string {
	const value = Number(size);
	if (!Number.isFinite(value) || value <= 0) return "";
	return value >= 1000 ? `${Math.round(value / 1000)}k ctx` : `${value} ctx`;
}

export function matchesQuery(haystack: string, query: string): boolean {
	const text = haystack.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((part) => text.includes(part));
}

export type PickerModel = {
	value: string;
	label: string;
	description: string;
	model: AnyModel;
};

/** Sanitise everything that came from the registry before it reaches a terminal. */
export function toPickerModels(
	models: AnyModel[],
	providerLabel: (provider: string) => string,
	currentKey = "",
): PickerModel[] {
	return models.map((model) => {
		const name = sanitize(model.name || model.id, 48) || "unnamed model";
		const provider = sanitize(model.provider, 24) || "unknown";
		const label = modelKey(model) === currentKey ? `● ${name}` : name;
		const meta = [sanitize(providerLabel(model.provider) || provider, 24), contextSize(model.contextWindow)]
			.filter(Boolean)
			.join(" · ");
		return { value: modelKey(model), label, description: meta, model };
	});
}

function listTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.bold(theme.fg("accent", text)),
		description: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

export class ModelPicker implements Component {
	private theme: Theme;
	private all: PickerModel[];
	private recent: string[];
	private keybindings: KeybindingsManager | undefined;
	private select: (value: string | null) => void;
	private input: Input;
	private list: SelectList;
	private items: SelectItem[] = [];
	private query = "";
	private visibleRows: number;
	private renderedListLines = 0;
	private _focused = false;
	private term: () => { columns: number; rows: number };

	constructor(
		theme: Theme,
		models: PickerModel[],
		recent: string[],
		select: (value: string | null) => void,
		keybindings?: KeybindingsManager,
		term: () => { columns: number; rows: number } = terminalSize,
	) {
		this.theme = theme;
		this.all = models;
		this.recent = recent;
		this.select = select;
		this.keybindings = keybindings;
		this.term = term;
		this.visibleRows = pickerLayout(this.term()).maxVisible;
		this.input = new Input({ prompt: "▎ ", placeholder: "Search models" });
		this.list = this.buildList();
	}

	/** Focusable: host focus drives the Input's physical cursor and IME marker. */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = Boolean(value);
		this.input.focused = this._focused;
	}

	private ordered(): PickerModel[] {
		const filtered = this.all.filter((item) =>
			matchesQuery(`${item.label} ${item.value} ${item.description}`, this.query),
		);
		if (this.query) return filtered;
		const recent = this.recent
			.map((key) => filtered.find((item) => item.value === key))
			.filter((item): item is PickerModel => Boolean(item));
		const rest = filtered.filter((item) => !this.recent.includes(item.value));
		return [...recent, ...rest];
	}

	private buildList(keep?: string): SelectList {
		this.items = this.ordered().map((item) => ({
			value: item.value,
			label: item.label,
			description: item.description,
		}));
		const list = new SelectList(this.items, this.visibleRows, listTheme(this.theme));
		list.onSelect = (item) => this.select(item.value);
		list.onCancel = () => this.select(null);
		if (keep) {
			const index = this.items.findIndex((item) => item.value === keep);
			if (index >= 0) list.setSelectedIndex(index);
		}
		return list;
	}

	private selectedValue(): string | null {
		return this.list.getSelectedItem()?.value ?? null;
	}

	private pickSelected(): void {
		const value = this.selectedValue();
		if (value) this.select(value);
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		const current = this.selectedValue();
		const index = current ? this.items.findIndex((item) => item.value === current) : 0;
		const next = Math.max(0, Math.min(this.items.length - 1, (index < 0 ? 0 : index) + delta));
		this.list.setSelectedIndex(next);
	}

	/** Recompute the visible window from the live terminal; rebuild only when it changed. */
	private syncLayout(): void {
		const rows = pickerLayout(this.term()).maxVisible;
		if (rows === this.visibleRows) return;
		this.visibleRows = rows;
		const keep = this.selectedValue();
		this.list = this.buildList(keep ?? undefined);
	}

	private matches(data: string, binding: "tui.select.cancel" | "tui.select.confirm"): boolean {
		if (this.keybindings) return this.keybindings.matches(data, binding);
		return binding === "tui.select.cancel" ? data === "\x1b" || data === "\x03" : data === "\r" || data === "\n";
	}

	render(width: number): string[] {
		const total = Math.max(0, Math.floor(Number(width) || 0));
		if (total <= 0) return [];
		this.syncLayout();
		const header = fit(this.theme.fg("accent", this.theme.bold("Select model")) + this.theme.fg("dim", "  esc"), total);
		const search = fit(this.input.render(total)[0] ?? "", total);
		const list = this.list.render(total).map((line) => fit(line, total));
		this.renderedListLines = list.length;
		const hint = fit(this.theme.fg("dim", "enter select · ↑↓ move · type filter"), total);
		return [header, search, "", ...list, "", hint];
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const row = event.y - LIST_TOP;
		if (row < 0 || row >= this.renderedListLines) return undefined;
		return this.list.handleMouse({ ...event, y: row });
	}

	handleInput(data: string): void {
		if (this.matches(data, "tui.select.cancel")) {
			this.select(null);
			return;
		}
		if (this.matches(data, "tui.select.confirm")) {
			this.pickSelected();
			return;
		}
		if (this.keybindings?.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (this.keybindings?.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (this.keybindings?.matches(data, "tui.select.pageUp")) {
			this.move(-this.visibleRows);
			return;
		}
		if (this.keybindings?.matches(data, "tui.select.pageDown")) {
			this.move(this.visibleRows);
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (after !== before) {
			this.query = after;
			this.list = this.buildList();
		}
	}
}

/** Panel size: never wider or taller than the window it opens in. */
export function pickerLayout(term = terminalSize()) {
	// Honest bounds: never wider than the window, however narrow it is.
	const width = Math.max(1, Math.min(MAX_WIDTH, term.columns - 2));
	const maxVisible = Math.max(1, Math.min(MAX_VISIBLE, term.rows - 10));
	return { width, maxVisible, maxHeight: Math.max(1, Math.min(maxVisible + 6, term.rows)) };
}

export default function aylaModelPicker(pi: ExtensionAPI) {
	// Recent picks belong to this extension instance, not to the process.
	const recent: string[] = [];
	let generation = 0;

	pi.registerCommand("ayla-model", {
		description: "Model picker overlay (search, recent, provider meta)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("Ayla model picker needs interactive TUI mode", "warning");
				return;
			}
			const currentKey = ctx.model ? modelKey(ctx.model) : "";
			let models: PickerModel[] = [];
			try {
				models = toPickerModels(
					ctx.modelRegistry.getAvailable(),
					(provider) => ctx.modelRegistry.getProviderDisplayName(provider),
					currentKey,
				);
			} catch {
				models = [];
			}
			if (models.length === 0) {
				ctx.ui.notify("No models available for this login", "warning");
				return;
			}
			const token = generation;
			const picked = await ctx.ui.custom<string | null>(
				(_tui, theme, keybindings, done) =>
					new ModelPicker(theme, models, recent, (value) => done(value), keybindings),
				{
					overlay: true,
					overlayOptions: () => {
						const live = pickerLayout();
						return { width: live.width, maxHeight: live.maxHeight, anchor: "center", margin: 1 };
					},
				},
			);
			// A session shutdown or a reload invalidates this resolution.
			if (token !== generation) return;
			if (!picked) return;
			const chosen = models.find((item) => item.value === picked);
			if (!chosen) return;
			const changed = await pi.setModel(chosen.model);
			if (token !== generation) return;
			if (!changed) {
				ctx.ui.notify(`No credentials for ${sanitize(chosen.model.provider, 24)}`, "error");
				return;
			}
			const index = recent.indexOf(picked);
			if (index >= 0) recent.splice(index, 1);
			recent.unshift(picked);
			recent.length = Math.min(recent.length, RECENT_LIMIT);
			ctx.ui.notify(
				`${sanitize(chosen.model.name || chosen.model.id, 48)} · ${sanitize(chosen.model.provider, 24)}`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		generation += 1;
	});
}
