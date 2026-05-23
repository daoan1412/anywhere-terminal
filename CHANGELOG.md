# Changelog

All notable changes to **AnyWhere Terminal** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] — 2026-05-23

### Fixed

- **Cmd+Backspace / Ctrl+Backspace (kill-line) now works regardless of focus.** The shortcut was previously only routed through xterm.js's `attachCustomKeyEventHandler`, which only fires when xterm's hidden textarea has DOM focus. With the file tree open, clicking the tree shifted focus away from xterm, so `Cmd+Delete` in the terminal area became a no-op. Routed at the document-capture level alongside `Cmd+Left/Right` (start/end of line) and `Option+Left/Right` (word jump) so it reaches the active pane regardless of which sibling element holds focus.

### Changed

- **File-tree header root row** — uses the actual workspace folder name (no more `ALL-CAPS` text-transform, `0.05em` letter-spacing, or 11px font-size). The heading now reads as a normal folder name.
- **File-tree row indentation** matches VS Code Explorer's stepping: `paddingLeft = 20 + depth * 20px`. Step is `chevron-width (16) + flex gap (4) = 20px`, so a child row's leading glyph (chevron or file icon) sits roughly under its parent row's name first letter. Top-level rows sit just inside the header root name.

## [0.11.0] — 2026-05-23

### Added

- **Embedded File Tree panel.** Browse the workspace alongside the terminal without context-switching. Available in the sidebar, panel, and editor host — each location remembers its own open/closed state, position, and size independently. Defaults to visible on first install so the feature is discoverable.
- **Four positions per location** — `top`, `bottom`, `left`, `right`. Drag the resize sash on the edge facing the terminal to adjust; size is persisted per location. A move button in the header rotates through positions for the active host.
- **Toggle commands** — `AnyWhere Terminal: Toggle File Tree` (active focus) plus per-host variants `…Toggle File Tree (Sidebar)` / `…(Panel)` so commands routed from outside the webview land in the right place even when the user is focused elsewhere.
- **Reveal in File Tree** — command on terminal context (formerly "Reveal Working Directory in File Explorer"). Resolves the target via the extension-side cwd (OS process table), webview-side OSC 7 cwd, then last-known workspace root.
- **Drag a file row, drop on a terminal pane** — inserts the file's path at the cursor with shell-appropriate quoting. Re-uses the existing terminal drop handler.
- **VSCode-grade virtual scrolling and keyboard handling.** Powered by a vendored `vs/base/browser/ui/list/` (listWidget) under `src/vendor/vscode/` and a thin generic `Tree<T>` wrapper. Supports expand/collapse, arrow-key navigation, type-ahead, and WAI-ARIA Tree pattern (`role="tree"`, `aria-expanded`, `treeitem`).
- **`.gitignore` filtering** — directories and files ignored by git are hidden from the tree. Uses `git check-ignore -z --stdin` for batched NUL-delimited queries; falls back gracefully when git is unavailable.
- **Header with root folder + actions.** The header shows the workspace root name (click to expand/collapse) with a close button on the far right and the move button next to it. Root row is hidden from the virtual list so the header doubles as the root affordance.
- **Codicon-style chevron icons** via 2 inline SVG sprites. Codicon font is NOT vendored — bundle stays lean.

### Internals

- New `src/vendor/vscode/` tree mirroring upstream paths for future vendored widgets (inputbox, contextview, hover). Per-file Microsoft MIT headers preserved; full attribution in `THIRD_PARTY_NOTICES.md`.
- New `Tree<T>` wrapper with pluggable `ITreeDataSource<T>` + `ITreeRenderer<T>` interfaces mirroring AsyncDataTree's shape, so a future swap to the upstream async tree is a drop-in replacement.
- Extension ↔ webview RPC: `RequestReadDirectory` / `ReadDirectoryResponse` typed messages, batched per-request with `crypto.randomUUID()` IDs.
- Identity-stable `FileNode` cache in `FileSystemDataSource` — collapse + re-expand without re-fetch, with stale-async drop semantics on workspace root change.
- `FileTreeHost` companion object shared by the three terminal view providers (sidebar/panel/editor) — owns `rootGeneration`, workspace-folder change subscription, and the message-router fan-out.
- `FileTreeController` encapsulates webview-side bootstrap + the 5 router handlers (`readDirectoryResponse`, `workspaceRootChanged`, `toggle`, `setPosition`, `reveal`). `main.ts` constructs one controller per webview.
- `FileTreeSash` extracted from the panel — owns pointer capture, orientation math, and `--file-tree-size` updates.
- One-shot WebviewState migration from the legacy `fileTree` slot to per-location `fileTreeByLocation.sidebar` — runs synchronously on first `getState()`.

### Security

- OSC 7 cwd capture path is hardened: 16 KB encoded cap, 4 KB decoded cap, control-byte rejection, absolute-path check, and `(deleted)` suffix rejection.
- `git check-ignore` is invoked with `-z --stdin` (NUL-delimited stdin/stdout) — paths containing newlines or shell metacharacters cannot escape the protocol.



### Added

- **Tab rename.** Give any terminal tab a meaningful name via double-click on the tab label (inline input), right-click → `Rename Tab…`, command palette `AnyWhere Terminal: Rename Tab`, or `F2` when a terminal webview is focused. The custom name persists across window reloads (workspace-scoped). Clear the name (empty input) to revert to the live process title. OSC title updates continue to track the shell process but are subordinated to the custom name when one is set. Rename applies to root tabs only; split-pane process names are suppressed while a custom root name is active.

### Fixed

- **Hover preview markdown spacing** — the popup now matches VSCode's `.monaco-hover` compact margins. Previously, `white-space: pre` and browser-default heading/paragraph margins produced very airy popups (e.g. for `.reviews/round-1.md`). Switched to `white-space: normal; word-wrap: break-word` and applied VSCode's style budget: uniform `margin: 8px 0` for block elements, scaled-down heading sizes (h1 1.4em → h6 1em), tight `padding-left: 20px` on lists, and first/last-child margin resets. Fenced code blocks keep `white-space: pre` so long lines still scroll horizontally.
- **Hover preview "File not found" for paths wrapped by Claude Code / Codex CLI** — AI CLI tools emit their own `\n` + indent for continuation (not terminal soft-wrap), so `isWrapped` stays false and xterm pads the trailing cells with spaces. The prior heuristic required row 1 to fill the full column width, which never held for these CLIs. The path-join logic now uses last-token analysis (trailing non-whitespace must look like a tool-call prefix or contain an absolute-path root) and handles three continuation shapes: `"none"` (no join), `"marker"` (preserves whitespace seam for `· lines` regex), and `"in-path"` (strips row-1 trailing padding and row-2 leading indent).

## [0.10.0] — 2026-05-22

### Added

- **Hover preview for file paths in the terminal.** Hover over any clickable path and a 300 ms debounced popup shows the file's content with syntax highlighting (Shiki) and markdown rendering (markdown-it). Code is rendered with line numbers; the active line scrolls into view and gets a highlight bar when the path carries a line suffix.
- **Line-target suffixes recognised in the popup and on click**: `path:42`, `path:42:7`, `path(42,7)`, `path#L42`, `path:42-58` (line range), and Claude CLI's `Read(/abs/path · lines 180-299)` pattern. The popup scrolls the first line of the range to the centre.
- **Soft-wrap reassembly** — when a path wraps across terminal rows (e.g. `Read(...)` with a long absolute path), the link provider now joins the continuation rows so the hover and click resolve to the full path instead of just the visible fragment. Capped at 8 rows / 3000 characters and gated to tool-call prefixes or absolute-path tokens so unrelated full-width rows are never glued together.
- **"Open" button in the popup header.** Click to open the file in an editor tab — same flow as clicking the underlined path in the terminal.
- **Selectable popup content.** Text cursor inside the body; you can drag-select and copy out of the preview. Line numbers stay non-selectable so copy is clean.
- **Trust-policy gate with `Press Cmd / Ctrl to preview` override.** Dotfiles (`.env`, `.bashrc`), known-sensitive folders (`.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.config`, `node_modules`, `.terraform`, `.terraform.d`, `.npm`, `.gem`, `.azure`, `.bluemix`, `.helm`), and files outside the workspace are blocked from auto-preview. Pressing Cmd (macOS) or Ctrl (Win/Linux) during the hover overrides the block for that one file.
- New settings:
  - `anywhereTerminal.hoverPreview.delay` (default `300` ms, range 100–2000) — debounce before the popup fetches the file.
  - `anywhereTerminal.hoverPreview.blockSensitive` (default `true`, `scope: "application"`) — turn the trust policy on/off. Application-scoped so a hostile workspace cannot flip it via `.vscode/settings.json`.

### Security

- Trust bases are `initialCwd + workspaceFolders` only. Shell-emitted OSC 7 / OSC 633 cwd is NEVER used as a trust base — a hostile process emitting `cwd=/` cannot silently disable the override gate.
- Memory-bounded reads via `node:fs/promises.open()` + a pre-allocated 1 MB buffer. Even if a file is swapped under us between `stat` and read (TOCTOU), the buffer caps total bytes — large files surface as `too-large` rather than blowing up the extension host.
- Symlinks pointing into the workspace are treated as out-of-workspace (`requires-confirmation`) because the lexical path doesn't tell us where the target lives.
- The webview-side override gesture requires both an active `requires-confirmation` state AND a fresh `Meta` / `Control` key press — incidental modifier-held keystrokes (Cmd+C, Cmd+Tab) no longer trigger a re-fetch with `override: true`.
- Markdown rendering runs with `html: false, linkify: false, validateLink: () => false` (no inline HTML, no auto-linkification, no link clicks from inside the preview).
- IPC payloads are validated: paths > 4096 chars, NUL bytes, non-string fields, and oversized `sessionId` / `requestId` are rejected before the resolver runs.

## [0.9.1] — 2026-05-21

### Fixed

- **Clickable path opens the right file when the shell has `cd`'d into the same directory the path is named for.** Example: terminal cwd is `/some/.../a`, output line contains `a/file.md`. Previously the resolver joined them into `/some/.../a/a/file.md` (which didn't exist) and surfaced "File not found". The resolver now fans each cwd source into multiple candidates via VS Code's reverse-segment match algorithm, so both `/some/.../a/a/file.md` and `/some/.../a/file.md` are tried — the second one opens.
- Clicking an absolute path no longer generates a bogus `<cwd>/<full-absolute-path>` concatenation candidate (Node's `path.join` was silently double-rooting the path). Absolute paths now short-circuit to a single candidate.
- Symlinks to directories are correctly treated as directories and fall through instead of being passed to `showTextDocument` (which would error). Uses the `Directory` bit mask rather than strict equality on `FileType`.

### Added

- **Tilde-prefixed paths** (`~/foo.md`) are detected and expanded to the user's home directory.
- **`file://` URIs** (`file:///abs/path.md`, percent-encoded `file:///abs/foo%20bar.md`) are claimed by the terminal detector and decoded via `vscode.Uri.parse`.
- **Wider path detection** — the bare-path regex now accepts `#`, `&`, `=`, `%`, `:`, backslashes, and non-ASCII Unicode (CJK, accents, etc.). Quoted forms continue to capture paths with spaces or parentheses. Two new noise filters reject `<identifier>=<value>` (e.g. `Version=1.2.3.4`) and bare `<package>@<version>` specs (e.g. `react@18.2.0`); patch-file names like `react@18.2.0.patch` are preserved.
- **Workspace basename fallback** for `findFiles` — when a clicked path like `a/file.md` doesn't match the workspace glob, the resolver retries with just `file.md` and filters results that end with `/a/file.md`. Both searches share one 2-second timeout budget.

### Security

- `file://` URIs with a non-empty authority are rejected. Without this guard, a hostile process writing `file://attacker.example.com/share/x.md` to the terminal would have triggered an SMB connection (and potentially leaked NTLM credentials) on click via the Windows UNC path that `vscode.Uri.parse` produces.
- Decoded `fsPath` is screened for embedded NUL bytes so log diagnostics always match what `fs.stat` actually opens.

## [0.9.0] — 2026-05-21

### Added

- **Clickable file paths in terminal output** — detected paths (`src/foo.ts:42:7`, Python tracebacks, Windows `C:\path`, etc.) are underlined and open in VS Code on click, jumping to the parsed line/column. Modal confirm before opening files outside the workspace.
- Relative paths resolve even when the shell has `cd`'d into a subdirectory. The resolver reads the live cwd from the OS process table (Linux/macOS) and OSC 7 / OSC 633 reports, falling back to a workspace search with QuickPick disambiguation when multiple files match.
- New setting `anywhereTerminal.fileSearch.maxResults` (default `50`) caps the QuickPick list for monorepos with many duplicate filenames.

### Security

- Shell-reported cwd is treated as a resolution hint only, never as a trust base — the out-of-workspace confirm modal cannot be bypassed by hostile terminal output.

## [0.8.0] — 2026-05-11

### Removed

- Plain-click cursor positioning (added in 0.6.1) is removed. The custom hijack handler emitted arrow-key escape sequences whenever the user clicked, which leaked raw `^[[D` / `^[[C` characters into the terminal whenever the shell was not at a readline prompt — most reproducibly during shell startup, after switching panel tabs, in the middle of long-running commands, and on multi-line input. Without shell integration (OSC 133/633) there is no reliable signal for "shell is at a prompt", so the heuristic guards (idle window, first-input gate, wrapped-input range) could not close every case. `Alt+Click` (Option+Click on macOS) continues to move the cursor via xterm.js's built-in `altClickMovesCursor` default.

## [0.6.2] — 2026-05-11

### Changed

- Updated marketplace description and keywords for clearer discovery (mentions split panes, tabs, theming, WebGL, Cursor).

## [0.6.1] — 2026-05-10

### Added

- Click cursor positioning in the terminal pane (`ClickCursorHandler`) — click in the terminal to move the shell cursor. (Removed in 0.8.0 — see entry above.)

## [0.6.0] — 2026-05-09

### Added

- Cursor IDE integration — the extension now installs and runs against Cursor 3.2.21+ (VS Code 1.105.1 baseline). Includes host-compatibility spec and discovery docs.
- Asimov core skill set, MCP server configurations, and updated environment settings (preceding commit, shipped together with 0.6.0).

## [0.5.0] — 2026-05-07

### Added

- Bundled `asm` binary for build/test tooling.

### Changed

- Tab bar layout is now responsive — tabs collapse and overflow gracefully on narrow views.

## [0.4.0] — 2026-05-06

### Added

- Confirmation prompt before opening URLs from terminal output.

### Fixed

- `Cmd+Click` on URLs now opens links in the default browser instead of inside the editor.
- `Shift+Enter` and macOS line/word navigation keys (`Cmd+←/→`, `Option+←/→`, `Cmd+Backspace`) are intercepted correctly and forwarded to the shell.

## [0.3.2] — 2026-03-22

Release-only bump — same code as 0.3.1.

## [0.3.1] — 2026-03-09 → 2026-03-20

### Added

- Insert file path into the terminal via the Explorer right-click menu, plus `Shift+drag` from the Explorer.
- `Cmd+Backspace` (macOS) / `Ctrl+Backspace` shortcut to kill the input line (sends `Ctrl+U`).

### Changed

- Major refactor of the webview terminal:
  - Extracted `TerminalFactory`, split renderer, and flow control into dedicated modules.
  - Extracted `WebviewStateStore`, `ResizeCoordinator`, `MessageRouter` from `main.ts`.
  - Extracted `ThemeManager`, `BannerService`, `XtermFitService` from `main.ts`.
- Introduced skill locking and comprehensive webview terminal refactoring documentation.

### Fixed

- Acknowledgement routing for backpressure messages.
- Resize timer leaks on rapid pane changes.
- Render service guard for disposed panes.

## [0.3.0] — 2026-03-07

### Added

- Extension settings: `shell.macOS`, `shell.args`, `scrollback`, `fontSize`, `fontFamily`, `cursorBlink`, `defaultCwd`.
- Advanced theme integration that follows VS Code dark / light / high-contrast themes.
- Performance optimization pass: adaptive output buffering, WebGL hardening, overflow protection, per-session memory tracking.
- Right-click context menu inside terminal panes (clear, kill, new, split, close) and Escape key handling.
- Enhanced terminal status feedback and error handling — visible status banners on failure.

### Changed

- Improved context menu command targeting and terminal fitting; removed unused native clipboard commands.

## [0.2.5] — 2026-03-04 → 2026-03-07

### Added

- **Bottom Panel terminal view** — drop-in replacement for the built-in panel terminal.
- **Editor Terminal** — open a terminal as an editor tab via `WebviewPanel`.
- **Session Manager** — central registry coordinating sessions across Sidebar / Panel / Editor.
- **Multi-tab UI** — tab bar, switching, and keyboard shortcuts for multiple sessions per view.
- **Secondary Sidebar** support — move the terminal to the right pane via the command palette.
- **Split panes** — binary split tree, split container UI, drag-to-resize handles, recursive splitting.
- Split commands, keybindings (`Cmd+\`, `Cmd+Shift+\`), and pane focus management.
- Last-pane-close handling and visible separator between split panes.
- View-specific commands for Sidebar vs. Panel (tab bar buttons).
- Context menu actions on split panes: close, split vertical, split horizontal.
- Dynamic terminal location inference and theme application based on host view.
- View lifecycle resilience: terminals survive view collapse/show cycles.

### Changed

- Hide xterm.js native scrollbar in favor of VS Code's scrollbar styling.
- Refined deployment scripts.

### Fixed

- Ghost tabs caused by stale UUIDs after pane close.
- Wrong split-button icons in the title bar.
- Invalid tab restoration on view re-mount.

## [0.2.4] — 2026-03-04

### Changed

- General UI polish across the sidebar webview.

## [0.2.1] — 2026-03-04

Release-only bump (git tag `v0.2.1`).

## [0.2.0] — 2026-03-04

Release-only bump (git tag `v0.2.0`).

## [0.1.1] — 2026-03-04

### Added

- WebGL addon for xterm.js — GPU-accelerated rendering, smooth on Retina displays.
- Deployment scripts (`deploy`, `deploy:vsce`, `deploy:ovsx`, `deploy:patch`, `deploy:minor`).

### Fixed

- Double-input issue caused by duplicate keystroke listeners.

### Changed

- Disabled Biome's `useNamingConvention` lint rule for a more flexible naming style.

## [0.0.1] — 2026-03-03 → 2026-03-04

Initial scaffold — never published, but the foundation for everything that followed.

### Added

- Webview-hosted xterm.js terminal in the **Primary Sidebar** via Activity Bar entry.
- PTY integration through `node-pty` with `PtyManager` and `PtySession` for dynamic process management.
- IPC layer between extension host and webview with output buffering and flow control.
- Clipboard support (`Cmd+C` / `Cmd+V`).
- Project scaffolding: TypeScript, esbuild bundling, Biome linting, Vitest unit tests, VS Code integration tests.
- Initial design and planning documentation.

[v0.2.0]: https://github.com/huybuidac/anywhere-terminal/releases/tag/v0.2.0
[v0.2.1]: https://github.com/huybuidac/anywhere-terminal/releases/tag/v0.2.1
