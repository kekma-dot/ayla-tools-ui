[English](README.md) · [Русский](README.ru.md)

![Ayla UI banner illustration](assets/banner.png)

# Ayla UI

A framed input editor, compact footer, model picker and local session panel for [Pi](https://pi.dev). Install it on its own or alongside [Ayla Compact](https://github.com/kekma-dot/ayla-tools-compact) for compact tool output.

## Install

Requires Node.js 22.19+ and Pi. The tested Pi baseline is 1.3.0; this is a beta.

Run in your terminal:

```bash
pi install git:github.com/kekma-dot/ayla-tools-ui
```

Restart Pi after installation. Git installation is supported; the package is not published to npm.

## Use

The editor and footer appear automatically in interactive Pi. The editor shows the current model, thinking level and context usage when available. Normal input, multiline editing and autocomplete stay in Pi.

Inside Pi:

```text
/ayla-ui
/ayla-model
/ayla-footer status
```

Tab on an empty prompt also opens the session panel. Use `1`/`2`/`3` to switch its session, models and tools tabs, `r` to refresh and Escape to close. The footer accepts `/ayla-footer auto|always|never` to control its extra status row for this session.

The session panel shows local session information. The model picker uses the models available in your existing Pi configuration; it does not add providers or supply credentials. The built-in `/model` command and model shortcuts remain available.

## Choose components

The editor and footer occupy shared Pi UI surfaces. If another extension supplies its own editor, Ayla leaves it in place. Footer selection depends on extension load order: choose one footer extension rather than expecting them to merge.

To load just the model picker, replace the package entry in your Pi agent directory's `settings.json` with:

```json
{
  "packages": [
    {
      "source": "git:github.com/kekma-dot/ayla-tools-ui",
      "extensions": ["-extensions/editor.ts", "-extensions/footer.ts"]
    }
  ]
}
```

Merge this entry into your existing `packages` list; do not replace your other packages. `"extensions": []` disables all Ayla UI components. Restart Pi after changing resources.

Do not install this package alongside another copy of the same Ayla editor/footer.

## Data and compatibility

Ayla UI reads session and model metadata already available inside Pi and renders it locally. It makes no network requests, starts no services, and writes no configuration files. Switching a model changes the active model in Pi as requested; subsequent prompts use that provider as usual.

Custom terminal components run in interactive TUI mode only. RPC, JSON and print modes do not receive the terminal UI. Windows is not yet qualified. No personal backend or other Ayla package is required.

The banner is an illustration, not a screenshot. Code is [MIT licensed](LICENSE); bundled notices are in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

## Remove

```bash
pi remove git:github.com/kekma-dot/ayla-tools-ui
```

Restart Pi to return to its normal editor and footer.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the source layout and checks. Changes to this repository do not automatically replace a separately maintained profile copy.
