# Proposal: add-file-tree-git-decorations

## Why

The custom webview file tree currently shows only filenames + a dim style for `.gitignore`'d files. Users working in git-tracked workspaces have no signal at-a-glance about which files are modified, added, deleted, or conflicted — they lose information they have in the built-in VS Code Explorer. Mirroring VSCode's decoration UX in our tree closes that gap with no settings to configure.

## Appetite

M (≤3d)

## Scope

### In scope

- Subscribe to the built-in VS Code git extension API (`vscode.extensions.getExtension('vscode.git')` → `getAPI(1)`) and listen to `Repository.state.onDidChange`.
- Maintain a per-workspace `Map<absPath, GitStatus>` covering working-tree, index, merge, and untracked changes.
- Push initial snapshot via the existing `request-read-directory` response (`FileEntry.gitStatus?`), then push incremental deltas via a new `GitStatusChanged` message (debounced 100 ms).
- Webview renders per-row color tint + single-letter badge using `--vscode-gitDecoration-*` CSS variables.
- Parent folders show a dirty dot/badge when any descendant is dirty (refcount on `FileNode`).
- Migrate the existing `.is-ignored` style to use `--vscode-gitDecoration-ignoredResourceForeground` (single source of truth for "ignored").
- Multi-root workspaces: one decoration provider per repository returned by the git extension API.
- Graceful no-op when the built-in git extension is disabled or absent.

### Out of scope

- Showing diff content / inline blame / hover preview of the diff. Decorations only.
- A user-visible setting to toggle decorations (always-on; matches VSCode Explorer default).
- Staging / unstaging / committing from the tree. Read-only display.
- A new "Source Control" view, branch indicator, or repo header chip.
- Submodule-only ranges of behavior beyond what the git extension already exposes.
- Replacing or modifying the existing `gitIgnoreChecker.ts` shell-out — the ignore tint *style* migrates, but ignored detection logic stays as-is.

## Capabilities

1. **git-decoration-source** — extension host subscribes to the built-in git extension API, maintains an in-memory status map per workspace folder, and emits debounced deltas to the webview.
2. **file-tree-git-decorations** — webview file tree applies status-driven CSS classes + badge letters to file rows and propagates dirty state to ancestor folders.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — color tinting, badge letters, and parent-folder dirty indicators in the file tree.
- **E2E required?** NOT REQUIRED — project.md declares E2E as N/A. Manual verification (open a workspace, edit/add/delete files, observe decoration in our tree matches the built-in Explorer) plus unit tests on the pure mapping functions cover the risk.
- **Justification**: this codebase has no E2E harness; the equivalent behavior we're matching is the built-in Explorer's, which is the visual oracle for manual QA. The interesting logic (status precedence, parent propagation, debounce coalescing) is pure and unit-testable.

## Risk Level

MEDIUM — first cross-boundary integration with the built-in git extension; activation race + delta ordering require care; visual change is broadly visible but rollback is a single CSS+class removal.
