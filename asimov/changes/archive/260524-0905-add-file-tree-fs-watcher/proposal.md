# Proposal: add-file-tree-fs-watcher

## Why

The AnyWhere Terminal file tree does not detect external filesystem changes (paste / rename / delete done in VS Code Explorer or any non-extension tool). New files never appear without a manual collapse-and-re-expand; renamed and deleted files leave stale rows. This also breaks the git decoration pipeline for new untracked files in already-loaded directories, because deltas land in `pendingStatuses` and never drain until the directory is re-read.

## Appetite

**M** (≤3d). Greenfield work — no existing watcher, no existing pool, no existing FS-change RPC — but the surrounding pieces (RPC handler accepting arbitrary paths, `Tree.refresh`, identity-stable `nodeCache`, refcount precedent from `GitDecorationProvider`) are all in place.

## Scope

### In scope

- Process-level `WatcherPool` singleton (mirrors `GitDecorationProvider` topology) that owns at most one `vscode.FileSystemWatcher` per absolute directory path, with refcounted subscribe / unsubscribe and per-directory trailing debounce
- Four new IPC message types: `request-subscribe-fs-changes`, `request-unsubscribe-fs-changes` (webview → extension); `fs-changes-invalidated`, `fs-rehydrate` (extension → webview)
- `FileSystemDataSource` lifecycle integration: subscribe when a directory is freshly cached; unsubscribe on `evictSubtree` and on `WorkspaceRootChanged`
- On `fs-changes-invalidated`, the webview calls `Tree.refresh(parentNode)` — re-runs the existing `request-read-directory` RPC so git status is freshly stamped via the existing path
- Window-focus re-sync: `vscode.window.onDidChangeWindowState({focused: true})` → host posts `fs-rehydrate` → webview refreshes every currently-mounted directory
- Watcher targets ONLY direct children (`RelativePattern(Uri.file(absPath), '*')`, non-recursive) with `ignoreChange: true` (the tree row does not display mtime; modify-without-create-or-delete is irrelevant)
- Works for arbitrary directories (not just `vscode.workspace.workspaceFolders[0]`), aligned with the existing `setRoot`/`revealPath` capability
- Unit tests via injected fake watcher factory (mock `createFileSystemWatcher`); no real-FS tests in this change

### Out of scope

- Honoring `files.watcherExclude` (VS Code itself does not honor it for outside-workspace dirs — see #223790; documented as known limitation)
- Granular delta events (per-file added/deleted payload) — reserved for a possible v2 if the refresh round-trip becomes a measurable bottleneck
- Watching for content-only changes (mtime, hash) — the tree row has no UI surface for it
- Recursive watching at the tree root — recursive outside-workspace has known VS Code bugs (#163352) and ignores excludes
- Cross-workspace pool sharing with other extensions — not possible at the `createFileSystemWatcher` boundary

## Capabilities

1. **fs-watcher-pool** — new capability: process-level singleton `WatcherPool` providing refcounted `subscribe(absPath, onInvalidate)` over `vscode.FileSystemWatcher`, with per-directory debounce, soft watcher count cap, and ENOSPC/EMFILE surfacing.
2. **fs-watcher-sync** — new capability: webview-side `FileSystemDataSource` integration that subscribes on cache insert, unsubscribes on eviction / root change, applies `fs-changes-invalidated` by calling `Tree.refresh(parent)`, and handles `fs-rehydrate` window-focus broadcasts.
3. **file-tree-rpc** — MODIFIED: extend the discriminated union with `RequestSubscribeFsChanges`, `RequestUnsubscribeFsChanges`, `FsChangesInvalidated`, `FsRehydrate`; extend the `IFileSystemProvider` contract per its existing extension comment.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — paste / rename / delete done in VS Code Explorer (or by an external tool) is now reflected in the file tree without manual re-expansion, with git status decoration freshly stamped on the new rows
- **E2E required?** NOT REQUIRED — the project's `Commands` table marks E2E as N/A and this change does not introduce a new user-facing surface that warrants standing up an E2E rig. Behavior is verified by unit tests + a manual check (paste a file in VS Code Explorer, observe the AnyWhere Terminal tree updates within ~200 ms)
- **Justification**: the project has no existing E2E infrastructure; adding it for a single feature is not warranted by the appetite. The mocked-watcher unit tests cover lifecycle, debounce, refcount, and the IPC round-trip; the manual check validates the end-to-end glue once.

## Risk Level

**MEDIUM** — touches a cross-boundary IPC (new RPC), introduces a new disposable resource (FS watchers), and runs in N+ concurrent `FileTreeHost` instances. Mitigated by the singleton refcounted pool, mocked-watcher unit coverage, and force-release on host disposal.
