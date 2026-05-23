# Proposal: port-vscode-async-data-tree

> **Historical note**: this change started as "full AsyncDataTree port" (per change-id). Gate 1 discovery refined to **C-trim**: vendor only `vs/base/browser/ui/list/` and build a thin generic `Tree<T>` wrapper on top. ID retained for archive continuity.

## Why

The webview currently shows only terminals. We want an embedded read-only file explorer alongside the terminal so users can browse the workspace without context-switching, and drag files into the active terminal to insert their path. Vendoring VS Code's `listWidget` gives us VS Code-grade virtual scrolling and keyboard handling at a fraction of the cost of the full Explorer port, while leaving the door open for future write-mode features (rename, internal drag-drop, decorations) via a generic `Tree<T>` interface.

## Appetite

**L** (≤2w) — sized for ~8 working days. Vendoring + path-alias plumbing is front-loaded; UI/RPC/integration is incremental.

## Scope

### In scope

- Vendor `vs/base/browser/ui/list/` (7 files) + minimum-required `vs/base/browser/` and `vs/base/common/` transitive deps + `vs/nls.ts` stub
- Add tsconfig `paths` + esbuild `alias` mapping `vs/*` → `src/vendor/vscode/*`
- License compliance: per-file Microsoft MIT header preserved + `THIRD_PARTY_NOTICES.md`
- Generic `Tree<T>` wrapper (~300 LOC) on top of listWidget — indented flat-list rendering, expand/collapse, keyboard nav, ARIA
- Pluggable `ITreeDataSource<T>` + `ITreeRenderer<T>` interfaces mirroring AsyncDataTree's shape (future swap)
- Extension-host → webview RPC: `RequestReadDirectory` / `ReadDirectoryResponse` message types
- Read-only `IFileSystemProvider` interface with read methods only (interface designed to extend with rename/delete later)
- `FileTreePanel` webview component — composes Tree + data source + read-only renderer
- Adaptive layout via existing `ResizeCoordinator` — panel appears **below** tabs in sidebar shape, **right** of terminal in panel shape
- Toggle command `anywhereTerminal.toggleFileTree` + title-bar button icon
- State persistence: open/closed flag + expanded paths via `WebviewStateStore`
- Drag-out: tree rows are `draggable`; drop on terminal pane inserts file path (re-uses existing `DragDropHandler` pattern)
- Folder layout under `src/vendor/vscode/` mirrors upstream paths so adding more vendored widgets (inputbox for rename, contextview for menus) later is mechanical
- Chevron icons via 2 inline SVG sprites in vendored CSS — Codicon font NOT vendored

### Out of scope

- Inline rename (file rename UI in tree)
- Internal drag-drop (reorder/move within tree)
- File create / delete / cut / copy / paste
- Context menus
- File decorations (git status badges, error badges)
- Multi-root workspace folder switching UI (read from `vscode.workspace.workspaceFolders[0]` only — single root)
- File-system watching with auto-refresh (manual refresh button OK; live watch deferred)
- `.gitignore` / `files.exclude` filtering
- Find / filter widget in tree
- File-icon theme integration (use generic 📄 📁 placeholders or simple two-icon set)
- Tree state sync across reload events that change workspace root
- AsyncDataTree itself, `abstractTree.ts`, find/inputbox/contextview/hover/actionbar widgets (deferred to follow-up changes when rename/decorations are added)

## Capabilities

1. **vscode-list-widget-vendor** — vendor the `list/` widget + base deps + build-config plumbing + license attribution
2. **file-tree-widget** — generic `Tree<T>` wrapper + pluggable data source/renderer interfaces (the foundation that survives future feature additions)
3. **file-tree-rpc** — typed webview ↔ extension messages for reading workspace directory contents
4. **file-tree-panel** — webview UI: panel container, adaptive layout binding, toggle command, state persistence, theming
5. **file-tree-drag-to-terminal** — drag a file row, drop on a terminal pane, insert path at cursor

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — new panel, new toggle command, new drag interaction.
- **E2E required?** NOT REQUIRED — project has no E2E framework per `asimov/project.md` (E2E: N/A). Verification via Vitest unit tests + manual VS Code dev-host run.
- **Justification**: E2E would need a new infrastructure investment far beyond the change appetite; manual verification of the toggle + tree expand + drag-into-terminal flow in the dev host is the established pattern for this codebase.

## Risk Level

**MEDIUM** — vendoring + path-alias setup carries integration risk (silent build breakage if tsconfig/esbuild don't match), bundle size pressure (currently 2.74 MB against 3 MB ceiling), and the Tree<T> wrapper is novel code that needs careful keyboard/ARIA testing. Mitigated by: incremental vendoring with a build smoke after each phase, bundle-size measurement gate, unit tests on Tree<T>.
