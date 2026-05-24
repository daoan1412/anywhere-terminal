# AnyWhere Terminal

**Put your terminal anywhere in VS Code or Cursor.** Sidebar, secondary sidebar, bottom panel, or as an editor tab. Split it, tab it, theme it.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code](https://img.shields.io/badge/VS%20Code-1.105%2B-007ACC.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

![AnyWhere Terminal demo](images/demo.png)

## Install

**VS Code** — search `AnyWhere Terminal` in Extensions, or:

```
ext install huybuidac.anywhere-terminal
```

**Cursor** — search `AnyWhere Terminal` (Open VSX).

## Quickstart

1. Click the **AnyWhere Terminal** icon in the Activity Bar — a session starts automatically.
2. Drag the view to **any** sidebar, panel, or editor group.
3. Use the title bar to add tabs or split panes. Right-click for context actions.

## Why

VS Code's built-in terminal is locked to the bottom. AnyWhere Terminal lets you put it anywhere — without losing PTY semantics, WebGL rendering, theming, or clickable links.

## Features

- **Place it anywhere** — Primary Sidebar, Secondary Sidebar, Bottom Panel, or Editor Tab
- **Tabs + split panes** — horizontal/vertical splits with drag-to-resize, recursive
- **Real terminal** — node-pty backed, full shell support, adaptive flow control
- **GPU rendering** — WebGL, smooth on Retina
- **Theme aware** — follows your VS Code theme (dark / light / high contrast)
- **Smart clipboard** — `Cmd+C` / `Cmd+V`, selection-aware, `Ctrl+C` fallback
- **Clickable URLs** — `Cmd+Click` with confirmation
- **Drag & drop paths** — drag from Explorer to insert absolute path

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+\` | Split vertical |
| `Cmd+Shift+\` | Split horizontal |
| `Cmd+C` / `Cmd+V` | Copy / paste |
| `Cmd+K` | Clear terminal |
| `Cmd+Backspace` | Kill input line |
| `Shift+Enter` | Insert newline |

> Replace `Cmd` with `Ctrl` on non-macOS (Windows/Linux support in progress).

Run `Cmd+Shift+P` → `AnyWhere Terminal:` for the full command list.

## Settings

All under `anywhereTerminal.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `shell.macOS` | `""` | Custom shell path. Empty = auto-detect. |
| `shell.args` | `[]` | Custom shell args. Empty = sensible defaults. |
| `scrollback` | `10000` | Scrollback buffer lines. |
| `fontSize` | `0` | `0` = inherit from VS Code. |
| `fontFamily` | `""` | Empty = inherit from VS Code. |
| `cursorBlink` | `true` | Cursor blink. |
| `defaultCwd` | `""` | Empty = workspace root or `$HOME`. |

## Requirements

- VS Code 1.105+ or Cursor 3.2.21+
- macOS (Windows/Linux on the roadmap)

## Contributing

```bash
pnpm install
pnpm run watch        # rebuild on change
pnpm run test:unit    # unit tests
```

Press `F5` in VS Code to launch an Extension Development Host. Issues and PRs welcome at <https://github.com/huybuidac/anywhere-terminal/issues>.

Release process: see [`docs/RELEASING.md`](docs/RELEASING.md).

## License

[MIT](LICENSE) — third-party notices in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
