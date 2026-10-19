/**
 * Compact footer.
 *
 * One row locates the session (path, branch, live mic, streaming rate) and, on
 * demand or when something needs attention: a second row for extension
 * statuses this footer does not draw itself. Rows are fitted by shrinking and
 * dropping whole segments, so a narrow terminal never clips mid-token.
 *
 * Rendering is synchronous and reads cached values; the only timer runs while a
 * response is streaming, to animate the rate. The component is installed with
 * an ownership token: shutdown clears the footer only if nobody replaced it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	buildRows,
	joinSegments,
	parseMcpStatus,
	readSignals,
	segmentParts,
	tokenLine,
} from "./footer-model.mjs";
import { bound, sanitize } from "./text.mjs";

type Severity = "text" | "dim" | "accent" | "success" | "warning" | "error" | "muted";
type SegmentPart = { text: string; severity?: Severity };
type Segment = { id: string; severity: Severity; parts?: SegmentPart[] };

type FooterMode = "auto" | "always" | "never";

type FooterStatuses = { get(key: string): string | undefined; keys?: () => Iterable<string> };

type FooterDataLike = {
	getGitBranch?: () => string | null;
	getExtensionStatuses?: () => FooterStatuses;
	onBranchChange?: (callback: () => void) => () => void;
};

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

/** Statuses this footer draws itself; repeating them as foreign text would duplicate them. */
const CONSUMED_KEYS = new Set(["mcp", "ayla-voice"]);

const TICK_MS = 250;
const PROBE_WIDTH = 120;

function isMode(value: string): value is FooterMode {
	return value === "auto" || value === "always" || value === "never";
}

export default function aylaFooter(pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;
	let footerData: FooterDataLike | undefined;
	let tui: TUI | undefined;
	let theme: ThemeLike | undefined;
	let unsubscribeBranch: (() => void) | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	let mode: FooterMode = "auto";
	let installed = false;
	let disposed = false;
	let lastProbe = "";
	let working = { active: false, tokensPerSecond: 0 };
	let streamChars = 0;
	let streamStartedAt = 0;

	const stopTick = () => {
		if (tick) clearInterval(tick);
		tick = undefined;
	};

	/** The timer is only legitimate while our component is still the live footer. */
	const owned = () =>
		installed && !disposed && Boolean(tui) && current?.mode === "tui" && Boolean(footerData);

	const startTick = () => {
		if (tick || !owned()) return;
		tick = setInterval(() => {
			const seconds = (Date.now() - streamStartedAt) / 1000;
			if (seconds > 0.5) working = { active: true, tokensPerSecond: streamChars / 4 / seconds };
			tui?.requestRender();
		}, TICK_MS);
		tick.unref?.();
	};

	const tokenStats = () => {
		const context = current;
		if (!context) return { input: 0, output: 0, cost: 0, cacheHit: 0 };
		let entries: unknown[] = [];
		try {
			// Active branch only: abandoned branches are not current usage.
			entries = context.sessionManager.getBranch();
		} catch {
			entries = [];
		}
		let input = 0;
		let output = 0;
		let cost = 0;
		let last: UsageLike | undefined;
		for (const entry of entries) {
			const message = (entry as { type?: string; message?: { role?: string; usage?: UsageLike } })?.message;
			if ((entry as { type?: string })?.type !== "message" || message?.role !== "assistant") continue;
			const usage = message.usage;
			if (!usage) continue;
			input += Number(usage.input) || 0;
			output += Number(usage.output) || 0;
			cost += Number(usage.cost?.total) || 0;
			last = usage;
		}
		let cacheHit = 0;
		if (last) {
			const read = Number(last.cacheRead) || 0;
			const fresh = Number(last.input) || 0;
			if (read + fresh > 0) cacheHit = read / (read + fresh);
		}
		return { input, output, cost, cacheHit };
	};

	const extraStatuses = (statuses: FooterStatuses | undefined) => {
		if (!statuses) return [];
		const out: { key: string; text: string }[] = [];
		const keys =
			typeof statuses.keys === "function"
				? [...statuses.keys()]
				: [...CONSUMED_KEYS].filter((key) => typeof statuses.get(key) === "string");
		for (const key of keys) {
			if (CONSUMED_KEYS.has(key)) continue;
			const text = sanitize(statuses.get(key), 60);
			if (text) out.push({ key, text });
		}
		return out;
	};

	const collect = () => {
		const context = current;
		if (!context) return undefined;
		const signals = readSignals();
		const statuses = footerData?.getExtensionStatuses?.();
		return {
			cwd: context.sessionManager?.getCwd?.() ?? context.cwd,
			branch: footerData?.getGitBranch?.() ?? null,
			working,
			voice: signals.voice,
			mcp: parseMcpStatus(statuses),
			extras: extraStatuses(statuses),
			mode,
		};
	};

	const paint = (rows: Segment[][]) =>
		rows.map((row: Segment[]) =>
			row
				.map((item: Segment) =>
					(segmentParts(item) as SegmentPart[])
						.map((part: SegmentPart) => {
							const severity = part.severity ?? item.severity ?? "text";
							const text = part.text;
							if (severity === "error" || severity === "warning") {
								return theme!.bold(theme!.fg(severity, text));
							}
							return theme!.fg(severity, text);
						})
						.join(""),
				)
				.join(theme!.fg("dim", "   ")),
		);

	const renderOnce = (width: number): string[] => {
		try {
			const state = collect();
			if (!state) return [];
			const painted = paint(buildRows(state, width, { mode }).rows as Segment[][]);
			return painted.map((line) => bound(line, width)).filter((line) => line.length > 0);
		} catch {
			const fallback = theme?.fg("dim", "footer unavailable") ?? "footer unavailable";
			const bounded = bound(fallback, width);
			return bounded ? [bounded] : [];
		}
	};

	const probe = (): string => {
		try {
			const state = collect();
			if (!state) return "";
			const rows = buildRows(state, PROBE_WIDTH, { mode }).rows;
			return `${rows.length}|${rows.map((row) => joinSegments(row)).join("\n")}`;
		} catch {
			return "";
		}
	};

	/** Re-render only when the plain content would differ; keeps idle CPU flat. */
	const refresh = () => {
		const next = probe();
		if (next === lastProbe) return;
		lastProbe = next;
		tui?.requestRender();
	};

	const detail = (): string => {
		const state = collect();
		if (!state) return "footer state unavailable";
		const lines: string[] = [];
		lines.push(`mode: ${mode} rows=${buildRows(state, PROBE_WIDTH, { mode }).rows.length}`);
		lines.push(`cwd: ${state.cwd ?? "?"}`);
		lines.push(`branch: ${state.branch ?? "none"}`);
		lines.push(`tokens: ${tokenLine(tokenStats())}`);
		const voice = state.voice as { state?: string; microphone?: string; task?: string; level?: number } | null;
		lines.push(
			`voice: ${voice?.state ?? "off"}${voice ? ` mic ${voice.microphone ?? "?"}` : ""}${
				voice?.task ? ` task ${voice.task}` : ""
			}${Number.isFinite(voice?.level) ? ` level ${Number(voice!.level).toFixed(2)}` : ""}`,
		);
		lines.push(`mcp: ${state.mcp ? `${state.mcp.connected}/${state.mcp.total}` : "unknown"}`);
		for (const extra of state.extras) lines.push(`${extra.key}: ${extra.text}`);
		return lines.join("\n");
	};

	const install = (context: ExtensionContext) => {
		if (!context.hasUI || installed) return;
		installed = true;
		disposed = false;
		context.ui.setFooter((tuiRef, themeRef, data) => {
			tui = tuiRef;
			theme = themeRef as ThemeLike;
			footerData = data as FooterDataLike;
			lastProbe = "";
			try {
				unsubscribeBranch = footerData.onBranchChange?.(() => {
					lastProbe = "";
					tui?.requestRender();
				});
			} catch {
				unsubscribeBranch = undefined;
			}
			return {
				invalidate() {},
				render: (width: number) => renderOnce(width),
				dispose() {
					disposed = true;
					stopTick();
					unsubscribeBranch?.();
					unsubscribeBranch = undefined;
					tui = undefined;
					footerData = undefined;
				},
			} satisfies Component & { dispose(): void };
		});
	};

	pi.registerCommand("ayla-footer", {
		description: "Compact footer: /ayla-footer auto|always|never|status",
		handler: async (args, context) => {
			current = context;
			const action = args.trim().toLowerCase() || "status";
			if (isMode(action)) {
				mode = action;
				lastProbe = "";
				tui?.requestRender();
				context.ui.notify(`Footer mode: ${mode}`, "info");
				return;
			}
			if (action === "status") {
				context.ui.notify(detail(), "info");
				return;
			}
			throw new Error("usage: /ayla-footer auto|always|never|status");
		},
	});

	pi.on("session_start", async (_event, context) => {
		current = context;
		if (context.mode !== "tui") return;
		install(context);
	});

	pi.on("agent_start", async (_event, context) => {
		current = context;
		working = { active: true, tokensPerSecond: 0 };
		streamChars = 0;
		streamStartedAt = Date.now();
		if (owned()) startTick();
		refresh();
	});

	pi.on("message_update", async (event, context) => {
		current = context;
		const update = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
		if (!update) return;
		if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
		streamChars += String(update.delta ?? "").length;
	});

	pi.on("turn_end", async (_event, context) => {
		current = context;
		refresh();
	});

	pi.on("agent_settled", async (_event, context) => {
		current = context;
		working = { active: false, tokensPerSecond: 0 };
		stopTick();
		refresh();
	});

	pi.on("session_shutdown", async (_event, context) => {
		current = undefined;
		stopTick();
		lastProbe = "";
		working = { active: false, tokensPerSecond: 0 };
		// Ownership token: only clear a footer that is still ours. If another
		// extension installed one later, our dispose() already ran and this is a
		// no-op, so its footer is never blanked.
		if (!installed || disposed) return;
		installed = false;
		if (!context.hasUI) return;
		try {
			context.ui.setFooter(undefined);
		} catch {
			// UI already torn down.
		}
	});
}
