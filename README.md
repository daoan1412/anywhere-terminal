# AnyWhere Terminal

Break free from the bottom panel. Put your terminal **anywhere** in VS Code or Cursor — Primary Sidebar, Secondary Sidebar, bottom Panel, or even as an Editor tab. Split it, tab it, theme it.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code](https://img.shields.io/badge/VS%20Code-1.105%2B-007ACC.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

## Why?

VS Code's built-in terminal lives at the bottom of the screen. That works — until you want it on the side, on a second monitor (via Secondary Sidebar), or as a full-window editor tab. AnyWhere Terminal gives you that flexibility without giving up the things that make a real terminal feel right: PTY, theming, copy/paste, WebGL rendering, and clickable links.

## Features

### Place it anywhere

- **Primary Sidebar** — keep a terminal next to your file tree
- **Secondary Sidebar** — push the terminal to the right pane (great on wide monitors)
- **Bottom Panel** — drop-in replacement for the built-in panel terminal
- **Editor Tab** — open a terminal as an editor tab, full-window if you want

### Multi-pane workflow

- **Tabs** — multiple sessions per view, switch with the tab bar
- **Split Panes** — horizontal and vertical splits with drag-to-resize handles, recursive splitting
- **Context menus** — right-click any pane to clear, kill, split, or close

### Real terminal behavior

- **node-pty backed** — proper TTY semantics, full shell support
- **Adaptive flow control** — handles `cat huge.log` without freezing the UI
- **WebGL rendering** — GPU-accelerated, smooth on Retina displays
- **Theme integration** — automatically follows your VS Code color theme (dark / light / high contrast)
- **Clipboard** — `Cmd+C` / `Cmd+V`, with selection-aware copy and Ctrl+C fallback
- **Clickable URLs** — `Cmd+Click` opens links in your default browser, with a confirmation prompt
- **Drag & drop paths** — drag a file from Explorer into the terminal to insert its path
- **Alt+Click cursor positioning** — hold `Option` (macOS) / `Alt` and click to move the cursor in supported shells (xterm.js built-in)

## Installation

### VS Code Marketplace

```
Extensions → Search "AnyWhere Terminal" → Install
```

Or run from the command palette:

```
ext install huybuidac.anywhere-terminal
```

### Cursor (Open VSX)

Cursor pulls extensions from Open VSX by default — search for **AnyWhere Terminal** there. If you need the latest build, use the VSIX fallback below.

### VSIX (manual)

```bash
pnpm install
pnpm run vsix
```

Then drag `anywhere-terminal-*.vsix` into the Extensions view, or pick **Install from VSIX...** from the `...` menu.

## Usage

1. Click the **AnyWhere Terminal** icon in the Activity Bar — a session starts automatically.
2. Use the title bar buttons to add tabs, split panes, or kill the session.
3. Right-click inside a pane for context actions.
4. Open `Cmd+Shift+P` → search `AnyWhere Terminal:` to see all commands.

### Commands

| Command | Description |
|---------|-------------|
| `AnyWhere Terminal: New Terminal` | Create a new tab in the focused view |
| `AnyWhere Terminal: New Terminal in Editor` | Open a terminal as an editor tab |
| `AnyWhere Terminal: Split Vertical` | Split the active pane vertically |
| `AnyWhere Terminal: Split Horizontal` | Split the active pane horizontally |
| `AnyWhere Terminal: Close Split Pane` | Close the focused split pane |
| `AnyWhere Terminal: Kill Terminal` | Terminate the active session |
| `AnyWhere Terminal: Clear Terminal` | Clear the scrollback buffer |
| `AnyWhere Terminal: Focus Sidebar` | Focus the Primary Sidebar terminal |
| `AnyWhere Terminal: Focus Panel` | Focus the bottom Panel terminal |
| `AnyWhere Terminal: Move to Secondary Sidebar` | Move the terminal to the Secondary Sidebar |
| `Insert Path in AnyWhere Terminal` | (Explorer right-click) inserts the file path |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+\` | Split vertical |
| `Cmd+Shift+\` | Split horizontal |
| `Cmd+C` | Copy selection (sends `Ctrl+C` if no selection) |
| `Cmd+V` | Paste from clipboard |
| `Cmd+K` | Clear terminal |
| `Cmd+A` | Select all |
| `Cmd+Backspace` | Kill input line (sends `Ctrl+U`) |
| `Shift+Enter` | Insert newline without submitting |

> Replace `Cmd` with `Ctrl` on non-macOS — though full Windows/Linux support is still in progress.

### Drag & drop a file path

Drag any file from the VS Code Explorer (hold `Shift` while dragging) onto the terminal to insert its absolute path — useful for `cat`, `code`, build commands, etc.

## Settings

All settings live under `anywhereTerminal.*` in `settings.json`:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shell.macOS` | `string` | `""` | Custom shell path. Empty = auto-detect (`$SHELL` → `zsh` → `bash` → `sh`). |
| `shell.args` | `string[]` | `[]` | Custom shell arguments. Empty = sensible defaults (`--login` for zsh/bash). |
| `scrollback` | `number` | `10000` | Maximum scrollback buffer lines. |
| `fontSize` | `number` | `0` | Pixel size. `0` = inherit from `terminal.integrated.fontSize` → `editor.fontSize` → 14. |
| `fontFamily` | `string` | `""` | Font family. Empty = inherit from VS Code. |
| `cursorBlink` | `boolean` | `true` | Whether the cursor should blink. |
| `defaultCwd` | `string` | `""` | Default working directory. Empty = workspace root or `$HOME`. |

## Requirements

- **VS Code** 1.105.0 or later
- **Cursor** 3.2.21 or later (matches VS Code 1.105.1 baseline)
- **macOS** — Windows and Linux are on the roadmap

## Smoke check (Cursor)

After installing in Cursor:

1. Open the AnyWhere Terminal sidebar — a shell prompt should appear within ~1s.
2. Run `echo cursor-smoke` and confirm output renders.
3. Run **AnyWhere Terminal: New Terminal in Editor** — a terminal should open as an editor tab.
4. If the terminal fails to spawn, check whether Cursor's bundled `node-pty` differs from VS Code's app-root layout and report the error to the issue tracker.

## Known Limitations

- macOS-first; Windows and Linux are untested
- Some shell-specific features (e.g. shell integration / command decorations) are not yet wired up

## Contributing

```bash
pnpm install
pnpm run watch        # rebuilds on change
pnpm run test:unit    # unit tests
pnpm run test         # VS Code integration tests
```

Open the project in VS Code and press `F5` to launch an Extension Development Host.

Bug reports and PRs welcome at <https://github.com/huybuidac/anywhere-terminal/issues>.

## Releasing

Single atomic command — `scripts/release.sh` bumps, verifies, commits, tags, publishes, and pushes. It refuses to run on a dirty tree, on a duplicate tag, or without a matching `CHANGELOG.md` entry, so you can't half-release.

### Steps

1. **Write the CHANGELOG entry first.** Open `CHANGELOG.md` and add a section header with the version you're about to release. The header must match `## [X.Y.Z]` exactly — the script greps for it:

   ```markdown
   ## [0.9.0] — 2026-MM-DD

   ### Added
   - ...

   ### Fixed
   - ...
   ```

2. **Commit anything pending.** The script refuses to run if `git status` is not clean.

   ```bash
   git add -A && git commit -m "feat: ..."
   ```

3. **Run the release.** The version is an explicit argument — no `npm version minor` auto-bump, no surprises.

   ```bash
   pnpm release 0.9.0              # publish to VSCE + Open VSX (default)
   pnpm release 0.9.0 vsce         # publish only to VSCE
   pnpm release 0.9.0 ovsx         # publish only to Open VSX
   ```

   The script will, in order:
   1. Validate the version format and refuse if tag `v0.9.0` already exists.
   2. Verify the CHANGELOG section is present.
   3. Bump `package.json` (only if it isn't already at the target version).
   4. Run `pnpm check-types`, `pnpm test:unit`, `pnpm package`.
   5. Commit `package.json + CHANGELOG.md` as `chore: release v0.9.0` and create the `v0.9.0` tag.
   6. Build the VSIX and publish to the chosen marketplace(s).
   7. Push the release commit and the tag (only after publish succeeds, so a failed publish does not leave a dangling remote tag).

### If something fails mid-release

- Pre-publish failures (typecheck, tests, build) — fix locally and re-run. Nothing was committed yet (the commit happens after build passes).
- Publish failure after commit/tag — the commit and tag exist locally but were not pushed yet. Either re-run the script (it will skip the bump since the version already matches) or `git reset --hard HEAD~1 && git tag -d v0.9.0` to undo and start over.
- Already pushed but only one marketplace published — re-run with the marketplace-specific target (`pnpm release 0.9.0 ovsx`) to fill the gap.

### Don't do this

- Don't manually run `vsce publish` or `ovsx publish` without going through the script — you'll skip the CHANGELOG/tag/commit guarantees.
- Don't manually edit the `version` field in `package.json` and then run the release script unless you pass the exact same version as the argument. The script will detect the mismatch via the CHANGELOG check, but it's clearer to leave the bump to the script.

## License

[MIT](LICENSE)
