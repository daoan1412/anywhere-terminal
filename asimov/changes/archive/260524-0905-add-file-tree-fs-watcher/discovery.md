# Discovery: add-file-tree-fs-watcher

## Workstreams

| # | Stream | Method | Output |
|---|--------|--------|--------|
| 1 | Architecture snapshot | finder over current codebase | section "Current state" below |
| 2 | VS Code public-API research | librarian | `docs/research/20260524-vscode-fs-watcher.md` |
| 3 | VS Code internal Explorer reading | general-purpose on local `/Users/huybuidac/Projects/ai-oss/vscode` | `docs/research/20260524-vscode-explorer-watcher-impl.md` |
| 4 | Memory recall | `bun run asm memory search` | no prior fs-watcher decisions; gitDecorationProvider pattern is the closest analogue |

## Current state

### Greenfield — no existing FS watcher

- No `vscode.workspace.createFileSystemWatcher` call anywhere in `src/`
- No `onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` subscription anywhere in the file-tree path
- The only existing workspace event the tree listens to: `onDidChangeWorkspaceFolders` (`src/providers/fileTreeHost.ts:106`) — bumps `rootGeneration` and broadcasts `workspace-root-changed`

### File tree already supports arbitrary roots

Verified by code reading (not future work):

- `src/providers/fileTreeRpcHandler.ts:155-162` — explicit comment: *"We deliberately accept any absolute path the webview asks for — out-of-workspace navigation is supported by design… `workspaceRoot` is no longer a containment gate."*
- `src/webview/fileTree/FileTreePanel.ts:323` `setRoot(absPath)` — tears down + remounts tree at any path
- `src/webview/fileTree/FileTreePanel.ts:233` `revealPath(absPath)` — calls `setRoot` when target is outside current root
- `src/webview/fileTree/FileTreeController.ts:179` `handleReveal` — routes arbitrary `absPath` through

### Provider topology

- **Singleton**: `GitDecorationProvider` constructed once in `src/extension.ts:33`, shared across all providers
- **Per-provider host**: `FileTreeHost` instantiated per `TerminalViewProvider` (sidebar, panel) and per `TerminalEditorProvider` (one per editor panel)
- **Concurrent count**: ≥3 (sidebar + panel + N editor panels)
- **Implication for watcher pool**: a process-level pool wired in `extension.ts` (like `GitDecorationProvider`) lets all hosts share a single physical watcher per directory

### Webview-side cache model (relevant invariants)

`src/webview/fileTree/FileSystemDataSource.ts`:

- `nodeCache: Map<absPath, FileNode>` — identity-stable; mutated in-place by `getChildren`
- `childrenByParent: Map<absPath, Set<absPath>>` — reverse index for `evictSubtree`
- `pendingStatuses: Map<absPath, {status, revision}>` — git deltas waiting for their dir to load (drained on first `getChildren` for that path)
- `Tree.refresh(element)` (`src/webview/fileTree/Tree.ts:622`) drops `children`+`childrenPromise` and re-runs `loadChildren` → re-RPC

### Existing message/RPC pipeline (to reuse)

- Extension → webview: `git-status-changed`, `workspace-root-changed`, `reveal-in-file-tree`
- Webview → extension: `request-read-directory`, `request-file-tree-search`, `cancel-file-tree-search`, `request-set-file-tree-position`
- `rootGeneration` gating + `requestId` correlation: already established
- Path stamping on read: `handleRequestReadDirectory` already attaches `gitStatus` + `gitRevision` per entry → re-reading a directory after an FS change automatically gets fresh git status

## Key findings (from research)

### VS Code Explorer architecture

`docs/research/20260524-vscode-explorer-watcher-impl.md`:

- Explorer does **not** create per-folder watchers. It relies on a single recursive workspace watcher (`WorkspaceWatcher.watchWorkspace`) and listens to `IFileService.onDidFilesChange` globally — with `EXPLORER_FILE_CHANGES_REACT_DELAY = 500 ms` scheduler
- Three internal coalesce layers already inside `vscode.FileSystemWatcher`: aggregator (75 ms), `coalesceEvents()` (collapses ADD+DELETE / DELETE+ADD→UPDATE / prunes child-of-deleted), throttled worker (200 ms / 500-event chunks)
- **Cross-extension dedup**: `FileService.doWatch` refcounts identical `(resource + options)` — BUT `workspace.createFileSystemWatcher` from extensions gets a fresh `correlationId` per call, so identical paths from different extensions do NOT dedupe at the file-service level. **We need our own pool.**

### Bundled extension patterns (copy-friendly)

- `extensions/markdown-language-features/src/client/fileWatchingManager.ts` — refcounted `ResourceMap<dirUri, {watcher, refCount}>`
- `extensions/typescript-language-features/src/tsServer/fileWatchingManager.ts` — same pattern
- `extensions/terminal-suggest/src/terminalSuggestMain.ts:373` — canonical `RelativePattern(Uri.file(absPath), '*')` for outside-workspace dirs

### Event semantics

- `vscode.workspace.onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` — only fire for VS Code-initiated ops (Explorer gestures + `workspace.applyEdit`). They do **NOT** fire for external (shell, other apps) changes. **Wrong tool for our use case.**
- `createFileSystemWatcher` is the only API that catches external changes
- External rename is reported as `onDidDelete(old) + onDidCreate(new)`, NOT as a rename event

### Watcher placement

- `RelativePattern(Uri.file(absPath), '*')` watches **only direct children** of `absPath`
- `RelativePattern(Uri.file(absPath), '**/*')` watches the recursive subtree
- Outside-workspace recursive watching is allowed but has known bugs (duplicate events #163352) and ignores `files.watcherExclude` for outside-workspace paths (#223790)

### Window focus re-sync

VS Code's Explorer re-syncs on window focus (`explorerService.ts:133-137`) to catch events dropped during macOS sleep/wake. The comment cites issue #126817.

## Gap analysis

| Need | Have | Gap |
|---|---|---|
| Detect external paste/rename/delete | Git status delta provider catches them, but only for tracked files via `repo.state.onDidChange` | No general-purpose FS watcher; non-git directories never get refresh signals |
| Refresh tree on FS change | `Tree.refresh(node)` exists | Nobody calls it on FS events |
| Watcher lifecycle bound to expanded dirs | `nodeCache` + `childrenByParent` + `evictSubtree` track loaded directories | No subscribe/unsubscribe RPC; host has no signal from webview about which dirs are active |
| Dedup across concurrent FileTreeHost instances | `GitDecorationProvider` singleton precedent | No process-level watcher pool |
| Throttling for bulk drops | `applyGitStatusDelta`'s 100 ms debounce on the git side | VS Code's internal watcher coalescing buys ~75-500 ms; for tree refresh we still want our own per-dir debounce (~150 ms) |
| Arbitrary root support | Already shipped in the read path | Watcher must mirror this — `RelativePattern(Uri.file(root), '*')`, NOT workspace-scoped glob |
| Window focus re-sync | `webviewView.onDidChangeVisibility` only resumes terminal output | No tree refresh on focus |

## Options

### Watcher scope (where do we point watchers?)

| ID | Scope | Pros | Cons |
|----|-------|------|------|
| A1 | **Per-expanded-directory, non-recursive** (`RelativePattern(dirUri, '*')`) — one watcher per loaded directory; refcounted pool dedupes across hosts | Matches our load granularity; outside-workspace safe; inotify pressure scales with what user actually sees; clean eviction on collapse | More disposers to manage; `subscribe/unsubscribe` IPC needed |
| A2 | **Single recursive watcher per FileTreeHost at currentRoot** (`RelativePattern(rootUri, '**/*')`) | Fewer watchers (3 total); no per-dir lifecycle | Outside-workspace recursive is buggy (VS Code #163352 dupes); doesn't honor `files.watcherExclude` for outside-workspace (#223790); a user pointing the tree at `~` will hammer inotify; recursive event paths need extra mapping back to immediate parent |
| A3 | Hybrid — recursive at workspace root; per-dir for outside-workspace navigation | Best of both for in-workspace | Two code paths; switching modes when user nav crosses workspace boundary is complex |

### Lifecycle ownership

| ID | Owner | Pros | Cons |
|----|-------|------|------|
| B1 | **Extension-side `WatcherPool` singleton + per-FileTreeHost subscription map** (mirrors `GitDecorationProvider` topology) | Cross-host dedup; matches existing extension singletons; centralised debounce; centralised limit guard | New IPC: `subscribe-fs` + `unsubscribe-fs` |
| B2 | Pool inside each FileTreeHost (no singleton) | Less moving parts; no cross-host dedup needed if we accept the duplication | 3+ watchers per directory; OS handle waste |
| B3 | Watcher lives implicitly per read (every `request-read-directory` extends its TTL) | No new RPC | Webview can't signal "I've collapsed" so disposal is purely TTL-based — flaky resource lifecycle |

### Webview refresh contract (what does the host push?)

| ID | Push payload | Pros | Cons |
|----|--------------|------|------|
| C1 | **`fs-changes-invalidated`: `{parent: absPath}`** — webview calls `Tree.refresh(parentNode)` which re-RPC reads the dir; existing read path stamps git status | Tiny payload; reuses existing read pipeline; git status auto-fresh; no new mutation paths in `FileSystemDataSource` | One extra RPC round-trip per change burst (negligible after debounce) |
| C2 | Granular delta: `{parent, added: [{path, kind}], deleted: [path], changed: [path]}` — webview mutates `nodeCache` + `childrenByParent` in-place | Zero RPC; instant UI | Doubles surface area; host must re-query `gitDecorationProvider.getStatus(newPath)` and stamp; new mutation writer for `nodeCache` (today only `getChildren` writes); fights existing pending-status drain flow |
| C3 | Just an event; webview alone decides what to do | Most flexible | Needs more webview logic; same RPC round-trip as C1 |

### Debounce

| ID | Strategy | Pros | Cons |
|----|----------|------|------|
| D1 | **Per-directory trailing debounce, 150 ms** | Burst-safe (unzip, git checkout); independent dirs don't block each other | Two timers to manage per dir |
| D2 | Single global trailing debounce | Simpler | One slow dir delays everything |
| D3 | No debounce — rely on VS Code's internal 75-500 ms coalescing | Less code | Still hammers refresh per coalesced batch; doesn't merge across our N hosts |

### Window focus re-sync

| ID | Strategy | Pros | Cons |
|----|----------|------|------|
| E1 | **`vscode.window.onDidChangeWindowState(focused: true)` → host posts `fs-rehydrate` → webview calls `Tree.refresh()` on every currently-mounted directory** | Catches dropped events on sleep/wake; mirrors Explorer | Small refresh burst on focus |
| E2 | None | No extra code | Quietly stale tree after sleep/wake — exactly what spawned this change |

### Recommended combination

**A1 + B1 + C1 + D1 + E1** — VS Code-aligned, simplest mutation surface, scales with user's actual expansion footprint, dedupes across our 3+ host instances.

## Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Watcher resource leak from unmatched subscribe/unsubscribe | MEDIUM | LOW | Host-side per-webview subscription map; force-release on host dispose / `WorkspaceRootChanged`; assert in tests |
| Excessive watcher count if user expands a 1000-folder tree | LOW | LOW | Pool emits a `console.warn` over a soft cap (e.g. 500); surface ENOSPC/EMFILE like `WorkspaceWatcher.onDidWatchError` |
| Race: watcher fires → refresh-hint posted → user collapses dir before refresh runs | LOW | MEDIUM | `Tree.refresh(node)` is a no-op if the node is uncached; existing `stale async result` invariant covers it |
| Windows path-case mismatch in pool key | MEDIUM | LOW | Use `vscode.Uri.file(p).toString()` as map key |
| Stale data on workspace folder change | MEDIUM | LOW | Existing `WorkspaceRootChanged` flow clears `nodeCache` → webview replays subscriptions on first `getChildren` after re-mount; host-side pool is path-keyed, unaffected |
| `files.watcherExclude` not honored for outside-workspace dirs (VS Code #223790) | LOW | MEDIUM | Document as known limitation; v1 does not consult `files.watcherExclude` |
| Webview crash leaves orphan subscriptions | MEDIUM | LOW | `attach()` Disposable cleanup on host dispose releases all subscriptions |

## Open questions

1. **Should we add a hard cap on simultaneous watched dirs?** Recommend soft cap @ 500 with warning + telemetry. Spec it as `MAY` not `SHALL`.
2. **Should `fs-rehydrate` (window focus) refresh only visible rows, or all cached dirs?** Recommend "all cached dirs" — cheap because `Tree.refresh` on a collapsed node is a no-op.
3. **Do we need a separate `fs-changes` RPC for files that changed (modified content), not just added/deleted?** v1 scope says no: file content changes are observed via `fileWillSave` listeners or git status, not by the file tree row itself. The tree row doesn't display mtime, so `*-changes` from the watcher should be **filtered out** (`ignoreChange: true` on the watcher unless we later add a "sort by modified" feature). Spec it.
4. **Do tests run real `createFileSystemWatcher` or mock it?** Mock — existing test pattern (e.g. `gitDecorationProvider.test.ts`) injects the workspace folder event; we add a similar injection point for `createFileSystemWatcher`.
