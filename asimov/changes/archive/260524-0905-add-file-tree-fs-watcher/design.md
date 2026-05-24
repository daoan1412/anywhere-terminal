# Design: add-file-tree-fs-watcher

## Decisions

### D1: Process-level `WatcherPool` singleton mirrors `GitDecorationProvider` topology

A single `WatcherPool` instance is constructed in `src/extension.ts` and injected into every `FileTreeHost` (sidebar, panel, and per-editor) the same way `GitDecorationProvider` is shared today (see `extension.ts:33`). This is the only way to dedupe physical OS watchers across our 3+ concurrent FileTreeHost instances — `workspace.createFileSystemWatcher` from extensions does NOT dedupe at VS Code's file-service layer (see `docs/research/20260524-vscode-explorer-watcher-impl.md` § "Dedup mechanics": correlationId is fresh per call).

**Rejected**: one pool per FileTreeHost. Would create 3× the OS watchers and triple inotify pressure for the common case where sidebar + panel + editor all show overlapping paths.

### D2: Per-expanded-directory non-recursive watcher (`RelativePattern(Uri.file(dir), '*')`)

Each subscribed directory gets its own watcher with glob `*` (direct children only). This matches the read granularity (the tree reads one level at a time) and lets us bind watcher lifecycle to `nodeCache` lifecycle cleanly: insert → subscribe, evict → unsubscribe. Outside-workspace recursive watchers are buggy in VS Code (#163352 duplicate events; #223790 `files.watcherExclude` not honored), and a user pointing the tree at `~` would otherwise trigger an inotify-recursive blowup. This also matches the bundled-extension pattern from `microsoft/vscode/extensions/markdown-language-features/src/client/fileWatchingManager.ts`.

**Rejected**: single recursive watcher per FileTreeHost at `currentRoot`. Cheaper for deep expansions but fails the arbitrary-root constraint (`~` blowup), and has known correctness bugs outside the workspace.

### D3: `ignoreChange: true` on the watcher

The file-tree row displays name + icon + git badge — none of which change on modify-without-create-or-delete. Subscribing to change events would multiply event volume by ~10× during a save burst with no UI benefit. If a future change adds a "sort by modified" or mtime column, lift this flag in that change's spec.

### D4: Refresh contract is `fs-changes-invalidated {parent}` → panel resolves path → `Tree.refresh(node)` re-RPC, NOT a granular delta

When the watcher fires for path `P`, the host posts `{type: 'fs-changes-invalidated', rootGeneration, parent: P}`. The webview routes it to `FileTreePanel.refreshDirectoryByPath(P)` which resolves `P` to a `Tree<FileNode>` node and calls `tree.refresh(node)`. The panel is the resolver because it owns `Tree`; `FileSystemDataSource` only owns `nodeCache` (which contains directory ROW entries — NOT the synthetic root node that `Tree.setInput(rootNode)` holds). This split is load-bearing — see D4a.

`Tree.refresh` re-issues `request-read-directory` through the existing RPC. This reuses the existing pipeline that already stamps `gitStatus` + `gitRevision` per entry (`fileTreeRpcHandler.ts:234-243`); no new mutation writer is added to `FileSystemDataSource`.

**Rejected**: granular `{added: [...], deleted: [...]}` payload. Would require a new mutation writer for `nodeCache` (today only `getChildren` writes), would force the host to re-query `gitDecorationProvider.getStatus(newPath)` for every created file and stamp metadata, and would fight the existing `pendingStatuses` drain contract. Worth ~5 ms saved per refresh — not worth the surface-area doubling.

### D4a: Root path resolution — special case

The current root path (`workspaceRoot` / `setRoot` target) is NOT present in `nodeCache`. `FileSystemDataSource.getChildren(null)` returns the LIST of root children but never inserts a synthetic node for the root itself; the root is created and held by `FileTreePanel.mountTree()` and passed to `Tree.setInput(rootNode)`. Therefore:

- The data source still subscribes the root path on first read (via the `subscribedRoots: Set<string>` mechanism in fs-watcher-sync spec) so the pool watches it.
- `FileTreePanel.refreshDirectoryByPath(absPath)` checks `absPath === currentRootPath` FIRST; if so, refreshes the synthetic root node (`tree.refresh(this.rootNode)`); otherwise looks up `nodeCache.get(absPath)` and refreshes that node if it exists.
- This is the most common watched directory in practice (whatever the user just navigated to) — getting it wrong silently breaks the headline use case (paste a file into the current folder).

### D5: Per-directory trailing debounce at 150 ms

VS Code's internal watcher already has three coalesce layers (aggregator 75 ms, `coalesceEvents`, throttled worker 200 ms / 500-event chunks — see `docs/research/20260524-vscode-explorer-watcher-impl.md` § "Three coalesce layers"). On top of that we add one more 150 ms trailing debounce per path so a burst (unzip, `git checkout`) coalesces into a single `fs-changes-invalidated`. 150 ms is tighter than VS Code Explorer's 500 ms — we lack the `onDidRunOperation` race their delay primarily guards against, and a snappier tree is the explicit user-perceived win.

### D6: Subscribe/unsubscribe driven by `FileSystemDataSource` cache lifecycle, NOT by user expand/collapse

Subscribe fires on the freshly-cached branch of `getChildren` for any directory (`FileSystemDataSource.ts:200-215`). Unsubscribe fires inside `evictSubtree` (`FileSystemDataSource.ts:261-294`) for every removed directory. `Tree.refresh` does NOT evict from the data source — it only invalidates `Tree.nodes[].children` — so a refresh does NOT trigger unsubscribe/resubscribe churn. Collapse in `Tree` also does NOT trigger eviction (`childrenByParent` retention is independent of expansion). The data source's cache IS the subscription set; this keeps a single source of truth.

**Rejected**: subscribe on expand, unsubscribe on collapse. Would mean collapsing a directory drops its watcher, and a watcher-fire while collapsed silently disappears — exactly the failure mode this change is designed to fix.

### D7: Window focus re-sync via `onDidChangeWindowState` rising edge — refresh ROOT + EXPANDED dirs only

The pool subscribes `vscode.window.onDidChangeWindowState`. When `focused` rises from `false` to `true`, the pool fires its own `onDidRequestRehydrate` event. Every `FileTreeHost` forwards this to its webview as `fs-rehydrate`, and the panel refreshes the root node PLUS every currently-expanded directory node — NOT every cached directory.

This is critical: `Tree.refresh` is NOT a no-op on collapsed cached nodes. `Tree.ts:622-638` shows refresh clears `children` and calls `loadChildren` regardless of expansion state. Refreshing 200 cached directories would mean 200 concurrent `request-read-directory` RPCs, with no UI benefit for the collapsed ones (their next expand would re-fetch fresh anyway). Refreshing only what is visible (root + expanded subtrees) bounds the rehydrate cost by what the user actually sees.

The panel iterates `tree.expandedNodes` (or the equivalent expand-state accessor) plus the synthetic root, deduping if necessary. Each is refreshed independently; the existing per-RPC correlation handles concurrency.

The initial event handling: `previousFocused` is initialised from `vscode.window.state.focused` at pool construction (NOT hardcoded `true`). If the window is already focused at activation, the first observed `focused: true` event is a no-op (already focused, no rising edge). If the window is unfocused at activation, the first `focused: true` correctly fires a rehydrate (which is what we want — the user just came back). This mirrors VS Code Explorer's own pattern (`/Users/huybuidac/Projects/ai-oss/vscode/src/vs/workbench/contrib/files/browser/explorerService.ts:133-137`, comment cites issue #126817 — events drop during macOS sleep/wake).

### D8: Soft cap at 500 watched paths

A user expanding 1000+ folders is unusual but possible. The pool emits a single `console.warn` when the count first crosses 500, then continues. No eviction logic in v1 — tracking which path to evict adds complexity for an edge case. ENOSPC/EMFILE from `createFileSystemWatcher` is caught and logged as `console.error`; subscribers still get a (silent) Disposable, and invalidation events for that path simply never arrive (best-effort degradation rather than a crash).

### D9: File-tree search controller piggybacks on the same invalidate + rehydrate signals

`FileTreeSearchController` (`src/webview/fileTree/search/FileTreeSearchController.ts`) owns its own enumeration cache (`CacheEntry` field, 60 s TTL, per-scope) that is independent of `FileSystemDataSource.nodeCache`. Its existing invalidation triggers are workspace-root change, scope change, and TTL expiry — none of which fire when the user pastes a file via VS Code Explorer. Without amendment, a paste followed by a search-bar open within 60 s would serve a stale enumeration that omits the new file.

The fix is two new public methods on the controller — `onFsInvalidated(absPath)` and `onRehydrate()` — wired by `FileTreePanel` into the SAME callbacks that drive `refreshDirectoryByPath` / `refreshRootAndExpandedDirectories`. `onFsInvalidated` drops the cache only when `absPath` falls inside the cache's pinned scope (cheap `startsWith` against `cache.scope + path.sep`, plus the equality case). `onRehydrate` always drops the cache. In both cases, if the search bar is currently active (`isActive()`), `scheduleEnumeration()` is called so the user sees fresh results on the next render tick without a keystroke; if inactive, the next `enter()` will re-enumerate via the existing `cacheIsFresh()` gate.

This keeps `FileTreeSearchController` as the single owner of its cache (no external mutation), and avoids duplicating subscription infrastructure (the panel is already the message routing point for these two callbacks). The alternative — having the search controller subscribe its own scope into `WatcherPool` — was rejected because: (i) the scope is recursive (`**/*`) but our pool only does non-recursive direct-children watching per D2, so the watcher set would not cover deep changes; (ii) the watcher pool already watches every loaded directory under the cached scope through `FileSystemDataSource`'s subscriptions, so the panel-side fanout is free.

**Rejected**: lowering `CACHE_TTL_MS` from 60 s → 5 s. Cheap to implement, but trades a deterministic correctness fix for a probabilistic one (a paste-then-search within 5 s would still miss) and burns enumeration RPCs unnecessarily when nothing has changed.

### D10: Folder dirty badge picks color from highest-severity descendant status

The folder-dirty propagation today (shipped in `add-file-tree-git-decorations`) stores a single integer `dirtyDescendantCount` and always paints the badge with `--vscode-gitDecoration-modifiedResourceForeground` (orange). VS Code Explorer instead picks the badge color from the highest-severity descendant status — a folder full of untracked files renders green (untracked), a folder with one conflict renders red, etc. Without per-status information on the folder node we cannot reproduce that behavior.

This decision extends `FileNode` with `dirtyDescendantCountsByStatus?: Partial<Record<GitStatus, number>>`. `FileSystemDataSource.applyStatusTransition` becomes the single writer, incrementing/decrementing the bucket for the descendant's status whenever propagation state changes. The legacy `dirtyDescendantCount` field is retained as a derived sum (for tests + cheap "any dirty?" checks). The renderer derives the dominant status (highest severity present, severity order matches `gitStatusMapping.ts`: `conflicted > deleted > modified > renamed > added > untracked`) and stamps `git-folder-dirty-{status}`. CSS defines one color rule per kind. The folder dot's font-size bumps from `11px` (sized for letter badges) to `14px` so the badge is visible at a glance, comparable to VS Code Explorer.

**Rejected**: store only a dominant-status field (no per-kind counts). Recomputing the next-highest when a top-severity descendant clears would require an O(N) walk over `nodeCache`. Per-kind counts make the transition O(1) per delta.

**Rejected**: defer the fix to a follow-up change. The user surfaced the symptom directly while testing `add-file-tree-fs-watcher` (newly-created untracked files now refresh into the tree, exposing the wrong color); folding the fix in keeps the headline experience (paste-shows-up-correctly) coherent in one ship.

## Architecture

### Component diagram (text)

```
┌──────────── Extension host ────────────┐    ┌─────── Webview (per host) ───────┐
│                                        │    │                                  │
│  extension.ts                          │    │  FileTreeController              │
│   └─► WatcherPool (singleton)          │    │   ├─► handleFsChangesInvalidated │
│        ├─► vscode.window               │    │   ├─► handleFsRehydrate          │
│        │   .onDidChangeWindowState     │    │   └─► route to FileTreePanel     │
│        │   (rising edge)               │    │                                  │
│        ├─► onDidRequestRehydrate Event │    │  FileTreePanel                   │
│        └─► subscribe(p, cb): Disposable│    │   └─► refreshDirectoryByPath(p)  │
│            └─► RelativePattern(Uri,'*')│    │       └─► Tree.refresh(node)     │
│                                        │    │                                  │
│  FileTreeHost.attach()                 │    │  FileSystemDataSource            │
│   ├─► handleSubscribeMsg → pool.sub    │    │   ├─► getChildren                │
│   ├─► handleUnsubscribeMsg → dispose   │    │   │   └─► (on fresh dir cache)   │
│   ├─► pool.onDidRequestRehydrate       │    │   │       provider.subscribeFs  │
│   │   → post fs-rehydrate              │    │   ├─► evictSubtree               │
│   └─► cleanup: dispose all per-host    │    │   │   └─► provider.unsubscribeFs│
│       Map<path, Disposable>            │    │   ├─► handleFsInvalidated       │
│                                        │    │   │   └─► refreshDirectory      │
└────────────────────────────────────────┘    │   └─► handleFsRehydrate         │
              ▲          │                    │       └─► refresh all cached    │
              │          ▼                    │           directory nodes       │
   request-subscribe-fs-changes               │                                  │
   request-unsubscribe-fs-changes             └──────────────────────────────────┘
              ▲          │
              │          ▼
       fs-changes-invalidated
       fs-rehydrate
```

### Event flow: external paste into `~/docs/external-research/`

1. User pastes `custom-claude.md` into the directory via VS Code Explorer
2. VS Code's underlying file watcher (already running because our pool subscribed to `~/docs/external-research/` when the user expanded it earlier) fires `onDidCreate` on the pool's `FileSystemWatcher`
3. Pool's per-path debounce timer arms for 150 ms; if no further events arrive in that window, fanout happens
4. Each subscribed `FileTreeHost` posts `fs-changes-invalidated {parent: '~/docs/external-research/', rootGeneration: N}` to its webview
5. Webview's `FileTreeController.handleFsChangesInvalidated` validates generation, routes to `FileTreePanel.refreshDirectoryByPath('~/docs/external-research/')`
6. Panel resolves the path to its `Tree<FileNode>` node, calls `tree.refresh(node)`
7. `Tree.refresh` drops `children`+`childrenPromise` and re-runs `loadChildren`, which calls `dataSource.getChildren(node)` → `readDirectory` RPC → host re-reads the directory, stamps `gitStatus: 'untracked'` for the new file via `gitDecorationProvider.getStatus`, posts response
8. New entry appears in tree with `U` badge — same code path as the initial read

### Event flow: window focus after sleep/wake

1. User lays laptop down; FS changes happen externally (cron job moves files, etc.)
2. macOS suspends the process; some `onDidCreate/Delete` events drop on the floor (known VS Code behavior — issue #126817)
3. User reopens lid; `vscode.window.onDidChangeWindowState({focused: true})` fires (after a prior `focused: false`)
4. Pool's rising-edge detector triggers `onDidRequestRehydrate`
5. Every FileTreeHost posts `fs-rehydrate {rootGeneration}` to its webview
6. `FileSystemDataSource.handleFsRehydrate` walks every cached directory and calls `Tree.refresh(node)` on each
7. Every visible row reflects current disk state

## Interfaces

### `WatcherPool` (extension host, new file `src/providers/fsWatcherPool.ts`)

```ts
export interface WatcherPoolOptions {
  createFileSystemWatcher?: typeof vscode.workspace.createFileSystemWatcher;
  onDidChangeWindowState?: vscode.Event<{ focused: boolean }>;
}

export interface WatcherPool {
  /**
   * Refcounted subscription. The returned Disposable removes ONLY this subscriber.
   * When the last subscriber for a path unsubscribes, the underlying FileSystemWatcher
   * is disposed and the debounce timer is cleared.
   */
  subscribe(absPath: string, onInvalidate: () => void): vscode.Disposable;

  /** Rising-edge window-focus event for rehydrate fanout. */
  readonly onDidRequestRehydrate: vscode.Event<void>;

  /** Disposes every active watcher, timer, and subscriber. Idempotent. */
  dispose(): void;
}

export function createWatcherPool(options?: WatcherPoolOptions): WatcherPool;
```

### New IPC message types (added to `src/types/messages.ts`)

```ts
export interface RequestSubscribeFsChangesMessage {
  type: 'request-subscribe-fs-changes';
  rootGeneration: number;
  path: string;
}

export interface RequestUnsubscribeFsChangesMessage {
  type: 'request-unsubscribe-fs-changes';
  rootGeneration: number;
  paths: string[];
}

export interface FsChangesInvalidatedMessage {
  type: 'fs-changes-invalidated';
  rootGeneration: number;
  parent: string;
}

export interface FsRehydrateMessage {
  type: 'fs-rehydrate';
  rootGeneration: number;
}
```

These extend `WebViewToExtensionMessage` (the first two) and the extension→webview union (the latter two — same union as `WorkspaceRootChangedMessage`, `GitStatusChangedMessage`).

### `FileTreeHost` constructor signature extension

```ts
constructor(
  private readonly gitDecorationProvider: GitDecorationProvider | null = null,
  private readonly watcherPool: WatcherPool | null = null, // null = no watcher integration (tests)
) {}
```

### `IFileSystemProvider` extension (webview, `src/webview/fileTree/IFileSystemProvider.ts`)

Adds two methods (fire-and-forget — no response):

```ts
interface IFileSystemProvider {
  readDirectory(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  subscribeFsChanges(path: string): void;
  unsubscribeFsChanges(paths: string[]): void;
}
```

### `FileTreePanel` public surface addition

```ts
class FileTreePanel {
  /**
   * Resolves absPath → tree node and calls tree.refresh(node).
   * - If absPath === currentRootPath: refreshes the synthetic root node held by the panel (NOT in nodeCache — see D4a).
   * - Else: looks up nodeCache.get(absPath) on the data source; if present and is a directory, refreshes it.
   * - Otherwise: no-op (path uncached / evicted / not a directory).
   */
  refreshDirectoryByPath(absPath: string): void;

  /**
   * Refreshes the synthetic root node PLUS every currently-expanded directory node
   * (iterates tree.expandedNodes; dedupes against root). NOT every cached directory —
   * see D7 for why "cached" is the wrong scope.
   */
  refreshRootAndExpandedDirectories(): void;
}
```

## Design Constraints

1. **No real-FS in unit tests** — the project's existing pattern (`gitDecorationProvider.test.ts`) injects fake VS Code event sources; the same approach via `WatcherPoolOptions.createFileSystemWatcher` keeps tests deterministic and CI-fast.
2. **No new dependencies** — `vscode.workspace.createFileSystemWatcher` ships with the VS Code API; we already depend on `vscode`. No chokidar, no `fs.watch`.
3. **Webview cannot import `vscode`** — all VS Code API access lives in `src/providers/`, never in `src/webview/`. The webview talks only via the IPC messages defined above.
4. **`rootGeneration` gating must be honored everywhere** — already the project pattern. Skipping the check in any new handler would re-introduce the cross-workspace-folder race the existing system already defeats.
5. **Map keys for the pool** — use the raw `absPath` string as the map key. `vscode.Uri.file().toString()` does NOT case-fold path segments on Windows or macOS, so it would not actually dedupe `/Users/X/p` vs `/users/x/p`; claiming case-normalization we don't have would be misleading. In practice paths arrive from `vscode.workspace.fs.readDirectory` (extension side), which returns canonical OS casing, so duplicate-case paths are unreachable through normal flow. Documented as v1 limitation: a user-supplied path with non-canonical case (e.g. via a typed `revealPath` from another integration) could create a second redundant watcher — wasteful but not incorrect.

6. **Re-root rapid thrash window** — `/projA → /projB → /projA` within 150 ms could trigger watcher destroy → recreate on the same path, missing OS events in the gap. Acceptable v1 trade-off: workspace-root changes are infrequent; `setRoot` from the user takes >150 ms to be triggered manually; and the window-focus rehydrate (D7) catches up on any drops. Documented in Risk Map.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `WatcherPool.subscribe` | Subscriber callback throws → fanout aborts mid-loop, other subscribers miss the event | Catch per-callback (`try/catch`) inside the fanout loop; `console.warn` and continue (per spec § "Fanout to all subscribers") |
| `FileTreeHost` per-host subscription map | Webview crashes / disposes without sending unsubscribe → pool refcounts leak | `attach()` cleanup Disposable disposes every entry on host disposal (per spec § "FileTreeHost subscription cleanup on dispose") |
| `FileSystemDataSource.evictSubtree` | Race: subscribe-message in-flight when eviction posts unsubscribe → host applies them in posted order → temporary over- or under-subscribe | Per-host map is path-keyed and idempotent; ordering of subscribe-then-unsubscribe for the same path always resolves correctly; out-of-order is impossible because postMessage preserves order per channel |
| `Tree.refresh` on a collapsed node | Refresh on a non-displayed branch could spuriously trigger `dataSource.getChildren` → unwanted RPC | Documented `Tree.refresh` contract: no-op if the node has no displayed children; verified in `Tree.test.ts:301-321` — refresh re-runs only if the parent is currently materialised |
| Per-directory debounce timer | 150 ms is wrong for some workloads (e.g. file is created then immediately deleted within window) | Single trailing edge fires after the last event in the burst; transient creates that are subsequently deleted simply produce a refresh that sees the deletion — convergent behavior, no stale row |
| `WatcherPool.dispose` | Re-subscription after dispose returns a Disposable that does nothing → silent stale tree | Spec requires post-dispose subscribe to return a no-op; in practice `dispose` is called only when the extension is deactivating, so this is acceptable |
| Windows path case in pool map keys | `/Users/X` and `/users/X` create two watchers | `vscode.Uri.file(absPath).toString()` normalisation handles this; verified by `Uri.file` semantics in the VS Code API |
| `onDidChangeWindowState` rising-edge | If pool is constructed while window is unfocused, the first observed `focused: true` could be incorrectly suppressed as "initial" | `previousFocused` initialised from `vscode.window.state.focused` at construction (NOT hardcoded `true`); spec § "Initial focus state mirrors window state" pins this |
| Root-node refresh miss | `fs-changes-invalidated {parent: currentRoot}` would no-op because root is not in `nodeCache` (held by `Tree.setInput`, not `getChildren`) — breaks the headline paste-into-current-folder case | `FileTreePanel.refreshDirectoryByPath` checks `absPath === currentRootPath` FIRST and refreshes the synthetic root node — see D4a; covered by dedicated test in task 4_4 |
| Rehydrate-stampeding-herd | If we refreshed every cached directory on focus rise, 200+ concurrent RPCs could fire | `refreshRootAndExpandedDirectories` refreshes only root + expanded — bounded by what the user sees — see D7; covered by dedicated test in task 4_4 |
| Re-root rapid thrash (`/projA → /projB → /projA` within 150 ms) | Pool destroys watcher on refcount 0, recreates on next subscribe — events in the gap are missed | Documented v1 limitation per Design Constraint #6; window-focus rehydrate (D7) catches up. Test in task 2_2 verifies refcount + dispose behaviour but does NOT add a grace period — accepted trade-off |
| Path map key non-canonical case | User-supplied path with non-canonical case (e.g. `/users/x` vs `/Users/X`) creates duplicate watchers | Documented v1 limitation per Design Constraint #5; in normal flow paths come from `vscode.workspace.fs.readDirectory` which returns canonical casing |
| Soft cap | A 500-folder expansion silently logs a warning the user may not see | Acceptable v1 trade-off — log is for the developer; documented in proposal § "Out of scope" as no hard cap / eviction in v1; test in task 2_2 asserts the soft-cap warning fires exactly once |
| `files.watcherExclude` not honored for outside-workspace dirs (VS Code #223790) | Heavy `node_modules` or `.git` dirs in user-navigated folders generate excess events | Out of scope per proposal; mitigated by the 150 ms debounce coalescing bursts |
| Search controller serves stale enumeration after paste (60 s TTL only) | User pastes a file via VS Code Explorer then opens search bar within 60 s → enumeration cache returns old result without new file | D9: `FileTreeSearchController.onFsInvalidated` / `onRehydrate` wired by panel into the same invalidate + rehydrate signals; drops cache when scope is affected; covered by task 4_7 tests |
| Folder dirty badge color (D10) is wrong: untracked-only folder renders orange instead of green; existing flat-counter data model lacks per-kind information | Symptom user reported directly (`arco-contract/docs` shows orange dot but VS Code Explorer shows green) — wrong color erodes trust in the badge as a signal | D10: extend `FileNode` with `dirtyDescendantCountsByStatus`; `applyStatusTransition` is the single writer (already serializes all transitions); renderer derives dominant status per render; per-status CSS color rules; covered by tasks 6_1 + 6_2 + manual check in 5_1 |
