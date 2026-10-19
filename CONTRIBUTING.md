# Developing Ayla UI

Clone this repository rather than editing Pi's managed installation cache:

```bash
git clone https://github.com/kekma-dot/ayla-tools-ui.git
cd ayla-tools-ui
npm ci --ignore-scripts
npm run check
npm test
pi -e .
```

Use a separate test session without another copy of Ayla UI enabled. The package uses Pi's public SDK and host theme; it has no separate renderer or backend.

## Source layout

- `extensions/editor.ts`: editor ownership, input frame and session panel entry.
- `extensions/footer.ts`: local footer state and rendering.
- `extensions/model-picker.ts`: model selection.
- Helpers under `extensions/` belong to this package, not a shared family framework.
- `tests/`: offline regressions. CI runs Node 24 on macOS and Ubuntu against Pi 1.3.0.

Keep components independently selectable through the Pi resource filters. Keep terminal code out of RPC/headless modes. Never replace another extension's tools, editor buffer, providers or settings just to change appearance.

For UI changes, test narrow and wide widths, CJK/emoji, theme changes, bracketed paste, multiline input, autocomplete and cancellation. Exercise regular and fullscreen Pi in a PTY, then check that typing still works after closing an overlay. A passing string assertion does not establish visual quality or physical IME behavior.

Before proposing a release, run the checks above and `npm pack --dry-run`, inspect the packed files, and test installation in a fresh Pi agent directory. Record the Pi/Node versions actually used. Changing wildcard peer ranges does not establish compatibility with a new Pi version.

User-facing changes need matching English and Russian README edits. Keep documentation about using the tool; omit internal release logs and artwork stories. Preserve attribution when copying code.
