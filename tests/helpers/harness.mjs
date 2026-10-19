/**
 * Test harness: load the real TypeScript entrypoints through jiti (the loader
 * Pi itself uses) and drive them with a recording `pi` plus a fake context.
 *
 * Nothing here touches the network, the real profile or a terminal.
 */

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(here, "..", "..");
export const entry = (name) => join(packageRoot, "extensions", name);

export const jiti = createJiti(import.meta.url, { moduleCache: false });

export async function load(name) {
	const mod = await jiti.import(entry(name));
	return mod.default ?? mod;
}

export const PLAIN_THEME = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	getColorMode: () => "none",
};

/** Fake TUI good enough for render-only components. */
export function fakeTui() {
	return { requestRender() {}, terminal: { columns: 80, rows: 24 } };
}

/** Recording `pi` API: captures commands, shortcuts and event handlers. */
export function fakePi(overrides = {}) {
	const commands = new Map();
	const shortcuts = new Map();
	const handlers = new Map();

	const api = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(name, options) {
			shortcuts.set(name, options);
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		getActiveTools: () => ["bash", "read"],
		getAllTools: () => [{ name: "bash" }, { name: "read" }, { name: "write" }],
		getSessionName: () => "test session",
		setModel: async () => true,
		...overrides,
	};

	return {
		api,
		commands,
		shortcuts,
		handlers,
		async emit(event, ctx, payload = { type: event }) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

const NO_ENTRIES = [];

/**
 * Fake extension context. `editorFactory`/`footerFactory` are live state, so a
 * test can observe what an extension installed, dispose it, or replace it to
 * imitate another owner.
 */
export function fakeCtx(options = {}) {
	const state = {
		editorFactory: options.editorFactory,
		footerFactory: options.footerFactory,
		footerCleared: 0,
		notifications: [],
		customCalls: 0,
		customOptions: undefined,
		customComponent: undefined,
		customClose: undefined,
		customHandle: undefined,
		overlaysHidden: 0,
	};

	const theme = options.theme ?? PLAIN_THEME;
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? "/work/project",
		sessionManager: {
			getCwd: () => options.cwd ?? "/work/project",
			getSessionId: () => options.sessionId ?? "session-1",
			getSessionName: () => options.sessionName ?? null,
			getEntries: () => options.entries ?? NO_ENTRIES,
			getBranch: () => options.branchEntries ?? NO_ENTRIES,
		},
		model: options.model,
		scopedModels: options.scopedModels ?? [],
		thinkingLevel: options.thinkingLevel,
		modelRegistry: {
			getAvailable: () => options.availableModels ?? [],
			getProviderDisplayName: (provider) => options.providerName ?? provider,
		},
		getContextUsage: () => options.usage,
		ui: {
			theme,
			getEditorComponent: () => state.editorFactory,
			setEditorComponent: (factory) => {
				state.editorFactory = factory;
			},
			setFooter: (factory) => {
				state.footerFactory = factory;
				if (!factory) state.footerCleared += 1;
			},
			notify: (message, type) => state.notifications.push({ message, type }),
			custom: (factory, customOptions) => {
				state.customCalls += 1;
				state.customOptions = customOptions;
				const handle = {
					hide() {
						state.overlaysHidden += 1;
					},
					update() {},
				};
				state.customHandle = handle;
				customOptions?.onHandle?.(handle);
				return new Promise((resolve) => {
					state.customComponent = factory(fakeTui(), theme, options.keybindings, (value) => resolve(value));
					state.customClose = (value) => resolve(value);
				});
			},
		},
	};

	return { ctx, state };
}

/** Render a component at one width and assert the TUI invariant. */
export function assertFits(assert, lines, width, label = "") {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`${label}line wider than ${width} (${visibleWidth(line)}): ${JSON.stringify(stripAnsi(line))}`,
		);
	}
}

export function stripAnsi(text) {
	return String(text).replace(/\x1b\[[0-9:;?]*[ -/]*[@-~]/g, "");
}
