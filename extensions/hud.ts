/**
 * Local session HUD.
 *
 * The overlay is a public `ctx.ui.custom` component, so it also opens when
 * another extension owns the editor: `/ayla-ui` never depends on our chrome.
 * It shows session identity, model, thinking level, context usage and the tool
 * surface, all read synchronously from the host. No timers, no polling, no
 * network, no disk.
 *
 * Lifecycle is owned per extension instance: `createHudController()` keeps a
 * generation counter, so a late `custom()` resolution after shutdown cannot
 * touch a dead session, and two sessions never share an "already open" flag.
 */

import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHud, hudMaxOffset, nextTab, normalizeTab } from "./hud-model.mjs";
import { terminalSize } from "./text.mjs";

type ThemeLike = { fg(color: string, text: string): string; bold(text: string): string };

export type LocalSnapshot = {
	name: string;
	id: string;
	cwd: string;
	model: string;
	provider: string;
	thinking: string;
	context: { tokens: number | null; window: number; percent: number | null } | null;
	activeTools: string[];
	allTools: string[];
	scopedModels: { id: string; name: string; provider: string; current: boolean }[];
	availableModels: number;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

function attempt<T>(read: () => T, fallback: T): T {
	try {
		const value = read();
		return value === undefined || value === null ? fallback : value;
	} catch {
		return fallback;
	}
}

/** Everything the HUD shows, read from the live host context. */
export function readLocalSnapshot(api: ExtensionAPI, ctx: ExtensionContext): LocalSnapshot {
	const usage = attempt(() => ctx.getContextUsage(), undefined);
	const current = ctx.model;
	const currentKey = current ? `${current.provider}/${current.id}` : "";
	const scoped = attempt(() => ctx.scopedModels ?? [], []);
	const scopedModels = scoped.map((entry) => {
		const model = (entry as { model?: { id?: string; name?: string; provider?: string } }).model ?? {};
		const id = str(model.id);
		const provider = str(model.provider);
		return {
			id,
			name: str(model.name) || id,
			provider,
			current: Boolean(currentKey) && `${provider}/${id}` === currentKey,
		};
	});
	const available = attempt(() => ctx.modelRegistry.getAvailable().length, 0);
	const activeTools = attempt(() => list(api.getActiveTools()), []);
	const allTools = attempt(
		() => (api.getAllTools() ?? []).map((tool) => str(tool?.name)).filter(Boolean),
		[],
	);

	return {
		name: attempt(() => str(api.getSessionName()) || str(ctx.sessionManager.getSessionName()), ""),
		id: attempt(() => str(ctx.sessionManager.getSessionId()), ""),
		cwd: str(ctx.cwd),
		model: str(current?.name) || str(current?.id),
		provider: str(current?.provider),
		thinking: str(ctx.thinkingLevel),
		context: usage
			? { tokens: usage.tokens ?? null, window: usage.contextWindow, percent: usage.percent ?? null }
			: null,
		activeTools,
		allTools,
		scopedModels,
		availableModels: Number.isFinite(available) ? Number(available) : 0,
	};
}

/** Terminal rows available to the overlay, bounded so a tiny window still works. */
export function hudHeight(rows = terminalSize().rows): number {
	const value = Number(rows);
	if (!Number.isFinite(value) || value <= 0) return 20;
	return Math.max(8, Math.min(32, Math.floor(value) - 1));
}

export class LocalHudComponent implements Component {
	private api: ExtensionAPI;
	private ctx: ExtensionContext;
	private theme: ThemeLike;
	private keybindings: KeybindingsManager | undefined;
	private close: () => void;
	private snapshot: LocalSnapshot;
	private tab: string;
	private offset = 0;

	constructor(
		api: ExtensionAPI,
		ctx: ExtensionContext,
		theme: ThemeLike,
		keybindings: KeybindingsManager | undefined,
		tab: string,
		close: () => void,
	) {
		this.api = api;
		this.ctx = ctx;
		this.theme = theme;
		this.keybindings = keybindings;
		this.close = close;
		this.tab = normalizeTab(tab);
		this.snapshot = readLocalSnapshot(api, ctx);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return buildHud(this.snapshot, { tab: this.tab, offset: this.offset }, width, hudHeight(), this.theme);
	}

	private matches(data: string, binding: "tui.select.cancel" | "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown"): boolean {
		if (this.keybindings) return this.keybindings.matches(data, binding);
		const fallback = {
			"tui.select.cancel": ["escape", "ctrl+c"],
			"tui.select.up": ["up"],
			"tui.select.down": ["down"],
			"tui.select.pageUp": ["pageUp"],
			"tui.select.pageDown": ["pageDown"],
		}[binding];
		return fallback.some((key) => matchesKey(data, key as Parameters<typeof matchesKey>[1]));
	}

	private scroll(delta: number): void {
		const max = hudMaxOffset(this.snapshot, this.tab, hudHeight());
		this.offset = Math.max(0, Math.min(max, this.offset + delta));
	}

	handleInput(data: string): void {
		if (this.matches(data, "tui.select.cancel") || matchesKey(data, "tab") || matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (matchesKey(data, "1") || matchesKey(data, "2") || matchesKey(data, "3")) {
			this.tab = normalizeTab(data.trim());
			this.offset = 0;
			return;
		}
		if (matchesKey(data, "left")) {
			this.tab = nextTab(this.tab, -1);
			this.offset = 0;
			return;
		}
		if (matchesKey(data, "right")) {
			this.tab = nextTab(this.tab, 1);
			this.offset = 0;
			return;
		}
		if (this.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.scroll(1);
			return;
		}
		if (this.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.scroll(-1);
			return;
		}
		if (this.matches(data, "tui.select.pageDown")) {
			this.scroll(5);
			return;
		}
		if (this.matches(data, "tui.select.pageUp")) {
			this.scroll(-5);
			return;
		}
		if (matchesKey(data, "r")) {
			this.snapshot = readLocalSnapshot(this.api, this.ctx);
			this.offset = Math.min(this.offset, hudMaxOffset(this.snapshot, this.tab, hudHeight()));
		}
	}
}

export type HudController = {
	open(ctx: ExtensionContext, tab?: string): Promise<void>;
	dispose(): void;
	readonly pending: boolean;
};

/** One controller per extension instance; closes custom UI through its completion callback. */
export function createHudController(api: ExtensionAPI): HudController {
	let generation = 0;
	let pending = false;
	let complete: (() => void) | undefined;

	return {
		get pending() {
			return pending;
		},
		async open(ctx: ExtensionContext, tab = "session") {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("Ayla UI HUD needs interactive TUI mode", "warning");
				return;
			}
			if (pending) return;
			const token = generation;
			pending = true;
			let mine: (() => void) | undefined;
			try {
				await ctx.ui.custom<void>(
					(_tui, theme, keybindings, done) => {
						mine = () => done(undefined);
						if (token === generation) complete = mine;
						else mine();
						return new LocalHudComponent(api, ctx, theme as ThemeLike, keybindings, tab, mine);
					},
					{
						overlay: true,
						overlayOptions: () => ({
							width: "88%",
							maxHeight: hudHeight(),
							anchor: "center",
							margin: 1,
						}),
					},
				);
			} finally {
				if (token === generation) {
					pending = false;
					if (complete === mine) complete = undefined;
				}
			}
		},
		dispose() {
			generation += 1;
			pending = false;
			const close = complete;
			complete = undefined;
			try {
				close?.();
			} catch {
				// Overlay already gone with the session.
			}
		},
	};
}
