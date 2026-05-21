# Proposal: add-clickable-file-paths

## Why

Terminal output frequently contains file paths (compiler errors, test failures, grep results, stack traces) but users must manually copy/paste them to open. Native VS Code terminal underlines and opens these on Cmd/Ctrl+click; AnyWhere Terminal currently underlines only URLs. Closing this gap is a high-value, low-blast-radius parity win.

## Appetite

**M** (≤3d) — parser + link provider + opener + IPC wiring + tests across one webview module and two extension-host providers.

## Scope

### In scope

- Detect file paths in terminal output via xterm.js `registerLinkProvider` (parallel to existing `WebLinksAddon`).
- Underline matches with pointer cursor on hover; activate on Cmd/Ctrl+click (xterm.js default modifier behavior).
- Support the common path + line:col suffix variants: bare path, `path:N`, `path:N:C`, `path(N,C)`, `path(N:C)`, `"path", line N`, `"path", line N, column C`.
- Resolve relative paths against PTY's initial cwd (recorded at session spawn) with workspace-folder fallback.
- Open file at `(line, col)` via `vscode.window.showTextDocument` with `Selection`.
- Show modal confirm dialog when resolved path is outside both PTY cwd and any workspace folder.
- Show error toast when no candidate resolves to an existing file.
- Performance caps: 2000 chars scanned per line, 10 matches per line max.
- Cross-platform: POSIX (`/`) and Windows (`\`) separators via platform-detected regex.
- Unit tests for parser, link provider, and opener.

### Out of scope

- OSC 7 cwd tracking (shell-integration script for live cwd updates). Documented limitation; follow-up if needed.
- Wrapped buffer lines (file path spanning two terminal rows). Documented limitation.
- Multi-line ripgrep-style detection (path on previous line + line:col on next line).
- Quick-pick search fallback when file not found (VSCode-style).
- TTL cache for stat results — not needed because validation is on-click only.
- WSL path translation.
- OSC 8 hyperlinks (separate scope; already handled at xterm.js level).
- Folder opening (only files; directory clicks fall through to error toast).

## Capabilities

1. **terminal-clickable-file-paths** — webview detects file paths in terminal output, underlines them, and emits `openFile` IPC; extension host resolves the path against PTY initial cwd + workspace, validates existence, applies an out-of-workspace confirm, and opens the file at the parsed line/column.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — new underline decoration on terminal file-path text, new cursor:pointer on hover, new modal confirm dialog for out-of-scope paths, new error toast for missing files.
- **E2E required?** NOT REQUIRED.
- **Justification**: Project Commands declare E2E as N/A (`asimov/project.md` §Commands). Unit tests + manual smoke (run extension, paste real `tsc`/`eslint`/`vitest` output, click) cover the surfaces. End-to-end VS Code harness is not configured in this repo.

## Risk Level

**LOW** — purely additive (no existing behavior modified), no new dependencies (xterm.js link API already used by WebLinksAddon), one new IPC message type following an established pattern (`openLink`), and the worst failure mode (false-positive underline or missing-file toast) is non-destructive.
