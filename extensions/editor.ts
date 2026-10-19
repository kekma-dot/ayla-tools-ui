/**
 * Ayla UI editor chrome.
 *
 * Draws the framed prompt (left rail plus a status strip) by extending the
 * public `CustomEditor`: text editing, paste, autocomplete, IME cursor
 * placement, history, keybindings and mouse geometry all stay the host's.
 *
 * The extension installs the factory only when no other extension owns the
 * editor. A foreign editor keeps its buffer, its submit handler and its keys;
 * `/ayla-ui` still opens the HUD because that path is a public overlay.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type {
	EditorComponent,
	EditorTheme,
	TUI,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { glamBox } from "./editor-box.ts";
import { createHudController } from "./hud.ts";

/** Same shape the host accepts in `ctx.ui.setEditorComponent`. */
type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

/** Columns the frame adds to the left of the editor's own content. */
const CHROME_X = 2;
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

export class AylaEditor extends CustomEditor {
	private readonly openHud: (ctx: ExtensionContext) => void;
	private readonly context: () => ExtensionContext;
	private inBracketedPaste = false;
	private hiddenBelow = 0;
	private framed = false;
	private lastBottomBorder: string | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		openHud: (ctx: ExtensionContext) => void,
		context: () => ExtensionContext,
	) {
		super(tui, theme, keybindings);
		this.openHud = openHud;
		this.context = context;
	}

	private ctx(): ExtensionContext {
		return this.context();
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.hiddenBelow = hiddenLineCount;
		const line = super.renderBottomBorder(width, hiddenLineCount);
		this.lastBottomBorder = line;
		return line;
	}

	public render(width: number): string[] {
		const total = Math.max(0, Math.floor(width));
		this.framed = total >= 16;
		if (!this.framed) return super.render(total);
		this.lastBottomBorder = undefined;
		const inner = super.render(total - 2);
		if (inner.length < 2) {
			this.framed = false;
			return inner;
		}
		const index = this.lastBottomBorder ? inner.lastIndexOf(this.lastBottomBorder) : -1;
		const ctx = this.ctx();
		const usage = (() => {
			try {
				return ctx.getContextUsage?.();
			} catch {
				return undefined;
			}
		})();
		const theme = ctx?.ui?.theme ?? PLAIN_THEME;
		const border = (text: string) =>
			typeof this.borderColor === "function" ? this.borderColor(text) : text;
		return glamBox(
			inner,
			total,
			theme,
			border,
			{
				thinking: ctx?.thinkingLevel,
				model: ctx?.model?.id,
				contextPercent: usage?.percent ?? undefined,
				hiddenBottom: this.hiddenBelow,
			},
			index === -1 ? inner.length - 1 : index,
		);
	}

	/** The frame shifts content two columns right; keep the editor's own hit-testing exact. */
	public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.framed) return super.handleMouse(event);
		if (event.x < CHROME_X) return undefined;
		return super.handleMouse({ ...event, x: event.x - CHROME_X, width: Math.max(1, event.width - CHROME_X) });
	}

	private autocompleteVisible(): boolean {
		const probe = (this as unknown as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete;
		return typeof probe === "function" ? Boolean(probe.call(this)) : false;
	}

	public handleInput(data: string): void {
		if (data.includes("\x1b[200~")) this.inBracketedPaste = true;
		if (data.includes("\x1b[201~")) this.inBracketedPaste = false;
		const empty = this.getText().trim() === "";
		if (
			!this.inBracketedPaste &&
			empty &&
			!this.autocompleteVisible() &&
			(matchesKey(data, "tab") || data === "\t")
		) {
			this.openHud(this.ctx());
			return;
		}
		super.handleInput(data);
	}
}

export default function aylaEditor(pi: ExtensionAPI) {
	const hud = createHudController(pi);
	let latest: ExtensionContext | undefined;
	let installedFactory: EditorFactory | undefined;
	let installedOn: ExtensionContext | undefined;

	pi.registerCommand("ayla-ui", {
		description: "Local session HUD: session, models and tools (/ayla-ui session|models|tools)",
		handler: async (args, ctx) => {
			latest = ctx;
			await hud.open(ctx, args.trim());
		},
	});

	// Context snapshots are cheap; keep the freshest one so the status strip and
	// the HUD show the model and thinking level the user just switched to.
	const remember = (_event: unknown, ctx: ExtensionContext) => {
		latest = ctx;
	};
	pi.on("agent_start", remember);
	pi.on("turn_end", remember);
	pi.on("agent_settled", remember);
	pi.on("model_select", remember);
	pi.on("thinking_level_select", remember);

	pi.on("session_start", async (_event, ctx) => {
		latest = ctx;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (ctx.ui.getEditorComponent()) return; // another extension owns the prompt
		const context = () => latest ?? ctx;
		const factory: EditorFactory = (tui, theme, keybindings): EditorComponent =>
			new AylaEditor(tui, theme, keybindings, (active) => {
				void hud.open(active, "session").catch(() => {
					if (installedFactory !== factory) return;
					try {
						latest?.ui.notify("Could not open Ayla UI. Use /ayla-ui to try again.", "warning");
					} catch { /* Session UI may already be gone. */ }
				});
			}, context);
		installedFactory = factory;
		installedOn = ctx;
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_shutdown", async () => {
		hud.dispose();
		const factory = installedFactory;
		const owner = installedOn;
		installedFactory = undefined;
		installedOn = undefined;
		latest = undefined;
		if (!factory || !owner) return;
		// Only restore when the factory is still ours: a later owner must survive.
		if (owner.ui.getEditorComponent() !== factory) return;
		try {
			owner.ui.setEditorComponent(undefined);
		} catch {
			// UI already torn down; nothing to restore.
		}
	});
}
