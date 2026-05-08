# AnyWhere Terminal

Break free from the bottom panel! Put your terminal anywhere in VS Code: **Primary Sidebar**, **Secondary Sidebar**, or **Editor area**.

## Features

- **Sidebar Terminal** — Run a fully functional terminal right in the Primary Sidebar
- **Multiple Tabs** — Create, switch, and close multiple terminal sessions per view
- **Theme Integration** — Automatically matches your VS Code color theme (dark, light, high contrast)
- **Clipboard Support** — Cmd+C / Cmd+V (macOS) for copy and paste
- **Flow Control** — Handles heavy output without freezing (backpressure management)
- **WebGL Rendering** — GPU-accelerated terminal rendering for smooth performance
- **Clickable URLs** — Links in terminal output are automatically clickable

## Usage

1. Install the extension
2. Click the **Terminal** icon in the Activity Bar (left sidebar)
3. A terminal session starts automatically

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+C` | Copy selection (or send SIGINT if no selection) |
| `Cmd+V` | Paste from clipboard |
| `Cmd+K` | Clear terminal |
| `Cmd+A` | Select all |
| `Ctrl+C` | Send SIGINT to running process |

## Requirements

- VS Code 1.105.0 or later
- Cursor 3.2.21 or later (VS Code baseline 1.105.1)
- macOS (Windows/Linux support planned)

## Cursor Installation

Cursor uses Open VSX as its default extension source. Install AnyWhere Terminal from Open VSX when available, or use the packaged VSIX fallback.

### VSIX fallback

1. Build the package with `pnpm run vsix`.
2. In Cursor, open Extensions.
3. Drag the generated `anywhere-terminal-*.vsix` file into the Extensions view, or choose **Install from VSIX...** if available.

### Cursor smoke check

After installing in Cursor 3.2.21 or later:

1. Open the AnyWhere Terminal sidebar view and confirm a shell prompt appears.
2. Run `echo cursor-smoke` and confirm the output appears in the terminal.
3. Run **AnyWhere Terminal: New Terminal in Editor** from the command palette and confirm the editor terminal opens.
4. If install succeeds but terminal creation fails, capture the error and check whether Cursor's bundled `node-pty` path differs from VS Code's app-root layout.

## Known Limitations

- Currently optimized for macOS only
- Single view location (Primary Sidebar) in Phase 1

## License

[MIT](LICENSE)
