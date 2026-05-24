## 1. Message contract

- [x] 1_1 Add four FS-changes message types to `src/types/messages.ts`
  - **Deps**: none
  - **Refs**: specs/file-tree-rpc/spec.md#requirement-requestsubscribefschanges-message-type; specs/file-tree-rpc/spec.md#requirement-requestunsubscribefschanges-message-type; specs/file-tree-rpc/spec.md#requirement-fschangesinvalidated-message-type; specs/file-tree-rpc/spec.md#requirement-fsrehydrate-message-type; design.md D4
  - **Scope**: src/types/messages.ts
  - **Acceptance**:
    - Outcome: Type-check passes; `RequestSubscribeFsChangesMessage`, `RequestUnsubscribeFsChangesMessage`, `FsChangesInvalidatedMessage`, `FsRehydrateMessage` exported and added to the relevant discriminated unions (`WebViewToExtensionMessage` for the first two; the extension→webview union shared with `WorkspaceRootChangedMessage` for the latter two — find the existing union and extend it)
    - Verify: none — types-only, validated by 1_3 and later tasks compiling
  - **Plan**:
    1. Find the existing `WebViewToExtensionMessage` and extension→webview unions by grepping for `WorkspaceRootChangedMessage` and `GitStatusChangedMessage` membership.
    2. Add the four interfaces (exact shapes from design.md § Interfaces) above the union declarations.
    3. Add each new interface to the matching union (host-bound vs webview-bound).
    4. Run `pnpm run check-types` and fix any places that exhaustive-switch over the unions.

## 2. WatcherPool

- [x] 2_1 Create `src/providers/fsWatcherPool.ts` with `createWatcherPool(options)` factory
  - **Deps**: none
  - **Refs**: specs/fs-watcher-pool/spec.md (all requirements); design.md D1, D2, D3, D5, D7, D8; docs/research/20260524-vscode-explorer-watcher-impl.md § "Three coalesce layers" and § "Bundled extension patterns"
  - **Scope**: src/providers/fsWatcherPool.ts (new file)
  - **Acceptance**:
    - Outcome: Module exports `WatcherPool`, `WatcherPoolOptions`, `createWatcherPool`. `createWatcherPool()` returns an instance satisfying all spec requirements: `subscribe(path, cb)` is refcounted by normalised `vscode.Uri.file(path).toString()` key; first subscriber creates one `createFileSystemWatcher(new RelativePattern(Uri.file(path), '*'), false, true, false)`; events from `onDidCreate`/`onDidDelete` trigger a 150ms trailing debounce; fanout calls every subscriber's `onInvalidate` exactly once per cycle inside `try/catch`; last unsubscribe disposes the watcher and clears the timer; ENOSPC/EMFILE on construction is logged and swallowed; soft cap warning fires exactly once at 500; rising-edge `onDidChangeWindowState` fires `onDidRequestRehydrate`; initial `focused: true` is suppressed (`previousFocused` initialised true); `dispose()` releases everything and makes future subscribes no-op.
    - Verify: none — covered by 2_2
  - **Plan**:
    1. Define `WatcherPoolOptions` (injectable `createFileSystemWatcher` + `onDidChangeWindowState`) and `WatcherPool` interface from design.md.
    2. Internal state: `Map<absPath, { watcher: vscode.FileSystemWatcher, subscribers: Set<() => void>, timer: NodeJS.Timeout | null }>` keyed by RAW `absPath` (no case-folding — design.md Constraint #5); `EventEmitter<void>` for `onDidRequestRehydrate`; counters for soft-cap-warned + `previousFocused` initialised from `options.initialWindowFocused ?? vscode.window.state.focused`.
    3. `subscribe`: get-or-create map entry by `absPath`; on create — try/catch the watcher construction (log on throw, register a `{watcher: noopWatcher, subscribers, timer:null}` sentinel so subscribers still get a Disposable but no events ever fire); wire `onDidCreate`+`onDidDelete` to arm/reset the 150ms `setTimeout` whose handler clears `timer`, snapshots `Array.from(subscribers)`, and iterates with per-callback try/catch + `console.warn`. Add subscriber to set. Return Disposable that removes this subscriber and, if set empties, clears timer + disposes watcher + deletes the map entry.
    4. Subscribe to injected `onDidChangeWindowState`: on each event, if `previousFocused === false && next.focused === true` fire `onDidRequestRehydrate`; always update `previousFocused = next.focused`.
    5. Track soft cap: increment a `everSeenMax` counter on map insertions; when it crosses 500 for the first time emit one `console.warn`.
    6. `dispose`: set a `disposed = true` flag; iterate map disposing watchers + clearing timers; clear map; dispose the window-state subscription; dispose the emitter. `subscribe` after dispose returns a no-op `{ dispose() {} }`.

- [x] 2_2 Unit test `WatcherPool` lifecycle, refcount, debounce, fanout, rehydrate, cap, dispose
  - **Deps**: 2_1
  - **Refs**: specs/fs-watcher-pool/spec.md (all); src/providers/gitDecorationProvider.test.ts (precedent for injected event sources + clock-step pattern using fake timers); design.md D5, D7
  - **Scope**: src/providers/fsWatcherPool.test.ts (new file)
  - **Acceptance**:
    - Outcome: Vitest suite covers — (a) first subscriber for a path creates exactly one watcher; second subscriber reuses it; last unsubscribe disposes it; (b) `onDidCreate`/`onDidDelete` arm 150ms debounce; multiple events in window collapse to one fanout; timer resets on each event; (c) fanout calls every subscriber, and a throwing subscriber does not stop fanout (verify with two subscribers, first throws); (d) ENOSPC thrown from injected `createFileSystemWatcher` is caught and logged via `console.error` spy; subscriber still gets a Disposable; (e) initial focus state from `options.initialWindowFocused: true` + subsequent `focused: true` event → NO rehydrate (no rising edge); (f) initial focus state `false` + first `focused: true` event → exactly one rehydrate; (g) sustained `false → true → false → true` produces exactly two rehydrates (rising edges only); (h) soft cap warning fires exactly once when path count first reaches 500 and never again on subsequent subscribes/unsubscribes; (i) `dispose()` releases all watchers and timers; post-dispose `subscribe()` returns a no-op disposable; (j) **re-root thrash test**: subscribe('/projA') → unsubscribe (refcount=0, watcher disposed) → subscribe('/projA') again within same tick → verify a NEW watcher is created (deterministic — no grace period in v1); (k) watcher created with `RelativePattern(Uri.file(absPath), '*')` and flags `(false, true, false)` — ignoreChange must be true. All tests use `vi.useFakeTimers()` to advance the 150ms debounce deterministically.
    - Verify: unit src/providers/fsWatcherPool.test.ts
  - **Plan**:
    1. Build a `makeFakeWatcher()` factory that returns `{ onDidCreate, onDidChange, onDidDelete }` as `vscode.EventEmitter`-backed `vscode.Event<vscode.Uri>` and a `dispose` spy.
    2. Build a `makeFakeWatcherFactory()` that records the `(globPattern, flags)` calls and returns the fake watcher; exposes `.lastCall` and `.calls`.
    3. Inject `onDidChangeWindowState` as an `EventEmitter`-backed event you fire from each test; inject `initialWindowFocused` per scenario.
    4. Use `vi.useFakeTimers()`; advance with `vi.advanceTimersByTime(150)`.
    5. Write tests for (a)..(k) — 11 tests minimum.
    6. For (j) the re-root thrash test, assert `fakeWatcherFactory.calls.length === 2` after the subscribe→unsubscribe→subscribe sequence (one watcher created, disposed, then a fresh one created).

- [x] 2_3 Wire `WatcherPool` singleton in `src/extension.ts`
  - **Deps**: 2_1
  - **Refs**: design.md D1; src/extension.ts (existing GitDecorationProvider wiring pattern around line 33)
  - **Scope**: src/extension.ts
  - **Acceptance**:
    - Outcome: Exactly one `createWatcherPool()` call in `extension.ts`; the returned instance is pushed into the activation `disposables` array so deactivation triggers `pool.dispose()`; the same instance is passed as the third constructor argument to every `FileTreeHost` instantiation (sidebar `TerminalViewProvider`, panel `TerminalViewProvider`, editor `TerminalEditorProvider`); type-check passes.
    - Verify: none — covered by 4_1 and 4_2 wiring tasks
  - **Plan**:
    1. Locate the `GitDecorationProvider` construction in `extension.ts` (around line 33 per the architecture snapshot).
    2. Construct the pool immediately after: `const fsWatcherPool = createWatcherPool();`
    3. Push the pool into the `context.subscriptions` (or the existing disposables array used for `gitDecorationProvider`).
    4. Update every `new FileTreeHost(gitDecorationProvider)` call site (sidebar + panel + editor) to `new FileTreeHost(gitDecorationProvider, fsWatcherPool)`. The `FileTreeHost` constructor signature change is done in 3_1.

## 3. FileTreeHost host-side dispatch

- [x] 3_1 Extend `FileTreeHost` constructor + `attach()` to handle subscribe/unsubscribe/rehydrate
  - **Deps**: 1_1, 2_1
  - **Refs**: specs/file-tree-rpc/spec.md#requirement-extension-host-subscribe-handler; specs/file-tree-rpc/spec.md#requirement-extension-host-unsubscribe-handler; specs/file-tree-rpc/spec.md#requirement-filetreehost-rehydrate-forwarding; specs/file-tree-rpc/spec.md#requirement-filetreehost-subscription-cleanup-on-dispose; design.md D1, D7
  - **Scope**: src/providers/fileTreeHost.ts
  - **Acceptance**:
    - Outcome: Constructor accepts third `watcherPool: WatcherPool | null = null` argument. `attach()` post type union extended to include `FsChangesInvalidatedMessage | FsRehydrateMessage`. `handleMessage` switch grows two new cases: `'request-subscribe-fs-changes'` (validates `rootGeneration` matches `this.rootGeneration`; on match calls `watcherPool.subscribe(path, () => deps.post({type: 'fs-changes-invalidated', rootGeneration: this.rootGeneration, parent: path}))`; stores the returned Disposable in a per-host `Map<string, vscode.Disposable>`; re-subscribe on existing path is a no-op — early-return if map already has the key) and `'request-unsubscribe-fs-changes'` (validates generation; for each path in `msg.paths`, looks up + disposes + deletes from map). When `watcherPool` is null, both handlers silently no-op (tests without a pool). `attach()` subscribes `watcherPool?.onDidRequestRehydrate(() => deps.post({type: 'fs-rehydrate', rootGeneration: this.rootGeneration}))` (gated by `deps.isReady()`). The cleanup `Disposable` returned by `attach()` disposes every entry in the per-host subscription map AND the rehydrate subscription.
    - Verify: none — covered by 3_2
  - **Plan**:
    1. Add `watcherPool: WatcherPool | null = null` as third constructor arg.
    2. Extend the `post` callback's type union with `FsChangesInvalidatedMessage | FsRehydrateMessage`.
    3. Add `private fsSubscriptions = new Map<string, vscode.Disposable>()` field.
    4. In `attach()`, after the existing `gitDeltaSub`, add `const rehydrateSub = watcherPool?.onDidRequestRehydrate(() => { if (deps.isReady()) deps.post({type: 'fs-rehydrate', rootGeneration: this.rootGeneration}); }) ?? { dispose: () => {} };`.
    5. In `handleMessage`'s switch, add the two new cases per the Outcome.
    6. Extend the cleanup `Disposable.from(...)` to include `rehydrateSub` and a custom `{ dispose: () => { for (const d of this.fsSubscriptions.values()) d.dispose(); this.fsSubscriptions.clear(); } }`.

- [x] 3_2 Unit test `FileTreeHost` subscribe/unsubscribe/rehydrate dispatch + cleanup
  - **Deps**: 3_1, 2_2
  - **Refs**: src/providers/fileTreeHost.test.ts (existing test patterns); specs/file-tree-rpc/spec.md (subscribe-handler, unsubscribe-handler, rehydrate-forwarding, cleanup-on-dispose requirements)
  - **Scope**: src/providers/fileTreeHost.test.ts
  - **Acceptance**:
    - Outcome: New tests added — (a) `request-subscribe-fs-changes` with matching `rootGeneration` calls `watcherPool.subscribe(path, ...)` exactly once; firing the captured callback posts `fs-changes-invalidated {parent, rootGeneration}` via the host's `post`; (b) `request-subscribe-fs-changes` for the same path twice yields exactly one `subscribe` call (idempotent); (c) `request-subscribe-fs-changes` with mismatched `rootGeneration` is dropped (no `subscribe` call, no post); (d) `request-unsubscribe-fs-changes` with bulk `paths` calls `dispose` on each matching map entry and silently ignores unknown paths; (e) `rootGeneration` bump (workspace folder change) invalidates a pending callback — the callback's posted `fs-changes-invalidated` carries the CURRENT `rootGeneration` at post time (verify by changing host generation between subscribe and event fire); (f) rising-edge rehydrate from pool posts `fs-rehydrate` with current rootGeneration only when `isReady()` is true; (g) disposing the host disposes every subscription in the map AND the rehydrate subscription; the map is empty afterwards; (h) when `watcherPool` is null (legacy tests path), subscribe/unsubscribe messages are silently ignored.
    - Verify: unit src/providers/fileTreeHost.test.ts
  - **Plan**:
    1. Mock `WatcherPool` with `vi.fn()` for `subscribe` (returns `{dispose: vi.fn()}`), `dispose`, and an `EventEmitter`-backed `onDidRequestRehydrate`.
    2. Each test builds a host via `new FileTreeHost(null, mockPool)`, calls `attach({isReady: () => true, post: postSpy})`, then drives `handleMessage(...)`.
    3. For (e), bump host generation by firing `onDidChangeWorkspaceFolders` between subscribe + fire — verify the captured callback closes over `this.rootGeneration` LIVE (not the value at subscribe time). The closure-over-`this`.rootGeneration` is the implementation choice in 3_1.

## 4. Webview-side integration

- [x] 4_1 Extend `IFileSystemProvider` with `subscribeFsChanges` + `unsubscribeFsChanges`
  - **Deps**: 1_1
  - **Refs**: specs/file-tree-rpc/spec.md#requirement-file-system-provider-interface-webview-side (MODIFIED)
  - **Scope**: src/webview/fileTree/IFileSystemProvider.ts
  - **Acceptance**:
    - Outcome: Interface gains `subscribeFsChanges(path: string): void` and `unsubscribeFsChanges(paths: string[]): void`. All existing implementations (`FileSystemDataSource`, any test fakes) compile after adding stub no-op methods (real implementation in 4_2; test fakes can keep no-op stubs).
    - Verify: none — type-only; downstream tasks fail to compile if missing
  - **Plan**:
    1. Add the two methods to the interface.
    2. `pnpm run check-types` and add no-op `subscribeFsChanges() {}` + `unsubscribeFsChanges() {}` to every test fake the compiler flags.

- [x] 4_2 `FileSystemDataSource` subscribes on fresh directory cache, unsubscribes on eviction + root change + dispose
  - **Deps**: 4_1, 3_1
  - **Refs**: specs/fs-watcher-sync/spec.md#requirement-filesystemdatasource-subscribes-on-fresh-directory-cache; specs/fs-watcher-sync/spec.md#requirement-filesystemdatasource-unsubscribes-on-eviction; design.md D6
  - **Scope**: src/webview/fileTree/FileSystemDataSource.ts
  - **Acceptance**:
    - Outcome: (a) In `getChildren`, the freshly-cached branch (where `isFreshlyCached = true` per existing code) posts `provider.subscribeFsChanges(e.path)` ONLY when `e.kind === 'directory'`; (b) the workspace root (`workspaceRoot`) is subscribed on its first read — implement by emitting `subscribeFsChanges(path)` once at the start of `getChildren(null)` when `subscribedRoots.has(path) === false`, then adding to a private `subscribedRoots: Set<string>`; cleared by `handleRootChanged`; (c) `evictSubtree(rootPath)` calls `provider.unsubscribeFsChanges(directoryPaths)` for every evicted path whose cached node was a directory (collected during the BFS); (d) `handleRootChanged` collects every directory path in `nodeCache` BEFORE clearing it and posts `provider.unsubscribeFsChanges([...allDirPaths])` as a single bulk message; (e) `dispose()` posts one bulk unsubscribe for every path currently subscribed.
    - Verify: unit src/webview/fileTree/FileSystemDataSource.test.ts (extends existing suite)
  - **Plan**:
    1. Add private field `subscribedRoots: Set<string>` and a small helper `recordSubscribed(path)` to keep the set in sync.
    2. Modify `getChildren` for `element=null` to subscribe the root once (set-membership gate).
    3. Modify the freshly-cached branch (around `FileSystemDataSource.ts:200-215`) to call `this.provider.subscribeFsChanges(e.path)` when `e.kind === 'directory'`; also record in `subscribedRoots`.
    4. Modify `evictSubtree` to collect directory paths in the subtree BFS (use `nodeCache.get(p)?.kind === 'directory'` filter) then post a single `unsubscribeFsChanges(paths)` call.
    5. Modify `handleRootChanged` per (d).
    6. Modify `dispose` per (e).
    7. Extend the test file with cases for each acceptance bullet using the existing harness helpers.

- [x] 4_3 `FileSystemDataSource.handleFsChangesInvalidated` + `handleFsRehydrate` (delegate to panel, do NOT pre-filter on nodeCache)
  - **Deps**: 4_2
  - **Refs**: specs/fs-watcher-sync/spec.md#requirement-apply-fs-changes-invalidated; specs/fs-watcher-sync/spec.md#requirement-apply-fs-rehydrate; design.md D4, D4a, D7
  - **Scope**: src/webview/fileTree/FileSystemDataSource.ts, src/webview/fileTree/FileSystemDataSource.test.ts
  - **Acceptance**:
    - Outcome: New public methods `handleFsChangesInvalidated(msg)` and `handleFsRehydrate(msg)` exist. Both validate `msg.rootGeneration === this.currentRootGeneration` and silently return on mismatch. `handleFsChangesInvalidated` does NOT pre-check `nodeCache`; it delegates to a constructor-injected `onDirectoryInvalidated: (absPath: string) => void` with `msg.parent` (the panel callback handles root-vs-cached resolution per D4a — critical because root is NOT in nodeCache). `handleFsRehydrate` delegates to a separate constructor-injected `onRehydrate: () => void`. The data source also exposes `getCachedNode(absPath: string): FileNode | undefined` (a simple `nodeCache.get(absPath)` accessor) so the panel callback can look up cached non-root directories. Unit tests: (a) generation mismatch on either message is a silent no-op; (b) generation-match `fs-changes-invalidated` always invokes `onDirectoryInvalidated(msg.parent)` exactly once, EVEN when path is uncached (the gate moves to the panel); (c) generation-match `fs-rehydrate` invokes `onRehydrate()` exactly once; (d) `getCachedNode(absPath)` returns the cached node when present, undefined otherwise.
    - Verify: unit src/webview/fileTree/FileSystemDataSource.test.ts
  - **Plan**:
    1. Add constructor options `onDirectoryInvalidated?: (absPath: string) => void` and `onRehydrate?: () => void`; default both to no-ops.
    2. Add `getCachedNode(absPath: string): FileNode | undefined` returning `this.nodeCache.get(absPath)`.
    3. Add `handleFsChangesInvalidated(msg)` per acceptance — gen-gate then `this.onDirectoryInvalidated(msg.parent)`.
    4. Add `handleFsRehydrate(msg)` per acceptance — gen-gate then `this.onRehydrate()`.
    5. Extend test harness; add 4 tests per acceptance bullets.

- [x] 4_4 `FileTreePanel` wires path-resolving callbacks into `FileSystemDataSource` (with root special-case + expanded-only rehydrate)
  - **Deps**: 4_3
  - **Refs**: specs/fs-watcher-sync/spec.md#requirement-webview-side-refresh-routing; design.md D4a, D7; design.md § Interfaces § "FileTreePanel public surface addition"
  - **Scope**: src/webview/fileTree/FileTreePanel.ts, src/webview/fileTree/FileTreePanel.test.ts
  - **Acceptance**:
    - Outcome: (a) The panel exposes `refreshDirectoryByPath(absPath: string): void` that checks `absPath === this.currentRootPath` FIRST → `this.tree?.refresh(this.rootNode)`; ELSE looks up `this.dataSource.getCachedNode(absPath)` → if it exists and is a directory, `this.tree?.refresh(node)`; ELSE no-op. (b) The panel exposes `refreshRootAndExpandedDirectories(): void` that refreshes the root node, then iterates `tree.expandedNodes` (or the appropriate `Tree` API for currently-expanded items — investigate `src/webview/fileTree/Tree.ts` to find the right accessor; if none exists, add a getter) and refreshes each directory node, deduplicated against the root. (c) Panel construction of `FileSystemDataSource` passes `{onDirectoryInvalidated: (p) => this.refreshDirectoryByPath(p), onRehydrate: () => this.refreshRootAndExpandedDirectories()}`. Tests: (i) invalidate with `parent === currentRootPath` calls `tree.refresh(rootNode)`; (ii) invalidate with a cached non-root directory path calls `tree.refresh(cachedNode)`; (iii) invalidate with an uncached/evicted path no-ops; (iv) rehydrate with root + 3 expanded + 2 collapsed-but-cached dirs calls `tree.refresh` exactly 4 times (root + 3 expanded, NOT the 2 collapsed); (v) rehydrate dedup: if root is also "expanded" in the tree's accessor, refresh is still called only once on it.
    - Verify: unit src/webview/fileTree/FileTreePanel.test.ts
  - **Plan**:
    1. Identify or add a `tree.expandedNodes` accessor in `Tree.ts` — if none exists, add a `public getExpandedElements(): T[]` method that returns elements where `node.expanded === true` (this is a small new public surface; document in tasks 4_4 plan, not a separate task).
    2. Implement `refreshDirectoryByPath(absPath)` per Outcome (a).
    3. Implement `refreshRootAndExpandedDirectories()` per Outcome (b) — Set-based dedup against the root path.
    4. Wire callbacks at `FileSystemDataSource` construction site per Outcome (c).
    5. Add tests (i)–(v); spy on `tree.refresh`; for (iv) use harness helpers to populate cache + drive expand state.

- [x] 4_5 `FileTreeController` routes new messages to `FileSystemDataSource` via panel
  - **Deps**: 4_3, 4_4
  - **Refs**: src/webview/fileTree/FileTreeController.ts:158-165 (existing `git-status-changed` routing pattern)
  - **Scope**: src/webview/fileTree/FileTreeController.ts, src/webview/fileTree/FileTreeController.test.ts
  - **Acceptance**:
    - Outcome: Controller's message-router switch grows two new cases: `'fs-changes-invalidated'` → calls `panel.dataSource.handleFsChangesInvalidated(msg)`; `'fs-rehydrate'` → calls `panel.dataSource.handleFsRehydrate(msg)`. Both gated on `panel != null` and (for backwards-safety) `panel.rootGeneration === msg.rootGeneration` — though the data source itself also validates, the panel-level gate matches the existing `git-status-changed` pattern. Test: post each message via the controller; assert the matching data-source method was invoked with the message.
    - Verify: unit src/webview/fileTree/FileTreeController.test.ts
  - **Plan**:
    1. Locate the existing `'git-status-changed'` case (line 158-165 per architecture snapshot).
    2. Add two adjacent cases per the Outcome.
    3. Mirror the existing test pattern.

- [x] 4_6 `FileSystemDataSource` request methods forward to underlying RPC channel
  - **NOTE**: Implementation landed alongside 4_1 (the interface methods need concrete impls for the class to satisfy `IFileSystemProvider`). The post-message shapes are verified by 4_2's subscribe-lifecycle tests.
  - **Deps**: 4_2, 1_1
  - **Refs**: src/webview/fileTree/FileSystemDataSource.ts (existing `readDirectory` posts via the same channel)
  - **Scope**: src/webview/fileTree/FileSystemDataSource.ts (concrete impl of the interface methods on the production data source, NOT the interface itself which 4_1 covers)
  - **Acceptance**:
    - Outcome: `FileSystemDataSource.subscribeFsChanges(path)` posts `{type: 'request-subscribe-fs-changes', rootGeneration: this.currentRootGeneration, path}` via the same `postMessage` injection that `readDirectory` uses. `unsubscribeFsChanges(paths)` posts the bulk message similarly. Both are fire-and-forget; no correlation; no promise.
    - Verify: unit src/webview/fileTree/FileSystemDataSource.test.ts (verify the posted message shapes — the existing test harness already captures `postMessage` calls)
  - **Plan**:
    1. Implement the two methods as direct `this.postMessage({...})` calls.
    2. Add 2 small tests asserting the posted message shape.

- [x] 4_7 `FileTreeSearchController.onFsInvalidated` + `onRehydrate` + panel wiring
  - **Deps**: 4_4
  - **Refs**: specs/fs-watcher-sync/spec.md#requirement-search-controller-cache-invalidation-on-fs-changes; specs/fs-watcher-sync/spec.md#requirement-webview-side-refresh-routing; design.md D9
  - **Scope**: src/webview/fileTree/search/FileTreeSearchController.ts, src/webview/fileTree/search/__tests__/FileTreeSearchController.test.ts, src/webview/fileTree/FileTreePanel.ts
  - **Acceptance**:
    - Outcome:
      - (controller) Two new public methods exist on `FileTreeSearchController`:
        - `onFsInvalidated(absPath: string): void` — if `this.cache === null` no-op; else if `this.cache.scope === absPath` OR `absPath.startsWith(this.cache.scope + path.sep)` (use `node:path` `sep` matching the existing imports — controller is webview-side so `posix` separator is fine because all FileTree paths are already `/`-normalised; if `path.sep` is not imported, use a string literal `/` constant defined locally with a short comment), set `this.cache = null` and — when `this.isActive()` — call `this.scheduleEnumeration()`; else no-op.
        - `onRehydrate(): void` — if `this.cache === null` no-op; else set `this.cache = null` and — when `this.isActive()` — call `this.scheduleEnumeration()`.
      - (panel) The existing `onDirectoryInvalidated` / `onRehydrate` callbacks passed to `FileSystemDataSource` (wired in 4_4) are extended to ALSO call `this.searchController?.onFsInvalidated(absPath)` / `this.searchController?.onRehydrate()`. If `searchController` is null (not yet lazily created — see `FileTreePanel.ts:836`), the call is silently skipped (the controller has no cache yet, so no invalidation is needed).
    - Verify: unit src/webview/fileTree/search/__tests__/FileTreeSearchController.test.ts (5 new tests) + src/webview/fileTree/FileTreePanel.test.ts (1 panel-wiring test)
  - **Plan**:
    1. Controller — add `onFsInvalidated(absPath: string): void`. Guard with `if (!this.cache) return;`. Compute `const scope = this.cache.scope; const isUnder = absPath === scope || absPath.startsWith(scope.endsWith('/') ? scope : scope + '/');` (handle the trailing-slash case for trees rooted at `/`). If `isUnder` is false, return. Else `this.cache = null;` then `if (this.isActive()) this.scheduleEnumeration();`.
    2. Controller — add `onRehydrate(): void`. Guard with `if (!this.cache) return;` then `this.cache = null; if (this.isActive()) this.scheduleEnumeration();`.
    3. Tests (controller) — 5 tests using the existing test harness in `FileTreeSearchController.test.ts`:
       - (a) `onFsInvalidated(scope)` with fresh cache → cache cleared + `scheduleEnumeration` debounce fires after 200 ms → `post` called with `request-file-tree-search`
       - (b) `onFsInvalidated(scope + '/sub/file.md')` → cache cleared + enumeration scheduled
       - (c) `onFsInvalidated('/unrelated/path')` → cache untouched, no enumeration scheduled, no `post` call
       - (d) `onFsInvalidated(scope)` while `isActive() === false` (search bar closed but cache retained per `exit()` semantics) → cache cleared, NO enumeration scheduled — re-entry via `enter()` does the enumeration via the existing `cacheIsFresh()` gate
       - (e) `onRehydrate()` with fresh cache + active search → cache cleared + enumeration scheduled; `onRehydrate()` with no cache → silent no-op
    4. Panel — modify the construction site of `FileSystemDataSource` callbacks (added in 4_4) to fan out to the search controller. Use the `this.searchController?.onFsInvalidated(absPath)` / `this.searchController?.onRehydrate()` pattern; do NOT eagerly create the controller (its lazy-creation via `getOrCreateSearchController()` is intentional — controller is null until first search-bar open).
    5. Panel test — 1 test: simulate `onDirectoryInvalidated('/foo')` → assert mocked search controller's `onFsInvalidated` was called with `'/foo'` (when controller exists); separately assert no throw when controller is null.

## 6. Folder dirty badge color (D10)

- [x] 6_1 Extend `FileNode` with `dirtyDescendantCountsByStatus`; `applyStatusTransition` maintains per-kind buckets
  - **Deps**: 4_3 (so this builds on the live fs-watcher refresh path)
  - **Refs**: specs/folder-dirty-color/spec.md#requirement-per-status-descendant-counts-on-filenode; specs/folder-dirty-color/spec.md#requirement-dominant-status-helper; design.md D10
  - **Scope**: src/webview/fileTree/IFileSystemProvider.ts, src/webview/fileTree/FileSystemDataSource.ts, src/webview/fileTree/FileSystemDataSource.test.ts
  - **Acceptance**:
    - Outcome: (a) `FileNode` gains `dirtyDescendantCountsByStatus?: Partial<Record<GitStatus, number>>` (additive; legacy `dirtyDescendantCount` remains as the sum). (b) `applyStatusTransition` becomes the single writer of the bucket map and the sum field together. Transitions: clean→propagating-P → `+1` on bucket P and `+1` on sum; propagating-A→propagating-B (A≠B) → `-1` on A and `+1` on B (sum unchanged); propagating-P→clean → `-1` on P and `-1` on sum. Each bucket clamps at zero; when a bucket reaches zero its key is deleted; when the map becomes empty the field is set to `undefined`. (c) A small helper (exported from the same file or co-located in a new `src/webview/fileTree/folderDirtyState.ts` — keep it close to the data source) returns the highest-severity propagating status currently present in a bucket map, or `undefined` when empty. Severity order: `conflicted > deleted > modified > renamed > added > untracked`. (d) `evictSubtree`'s ancestor decrement loop and `handleRootChanged`'s cache wipe both correctly drain the per-kind buckets to zero (test: invariant after a worst-case clean-up that the bucket map is `undefined` on the surviving ancestor).
    - Verify: unit src/webview/fileTree/FileSystemDataSource.test.ts (extends existing dirtyDescendantCount tests + adds per-kind cases)
  - **Plan**:
    1. Add the field to `FileNode` (interface only; default behavior is "absent").
    2. Refactor `walkAncestorsAndAdjust(absPath, delta)` → `walkAncestorsAndAdjust(absPath, prevStatus, nextStatus, delta)` — `delta` stays the sum delta (+1 / -1 / 0), and a new helper inside the loop adjusts per-kind buckets per the transition table.
    3. Add the dominant-status helper `dominantDirtyStatus(counts: Partial<Record<GitStatus, number>> | undefined): GitStatus | undefined` — pure function, no dependencies. Severity order constant inline.
    4. Audit `applyStatusTransition`'s same-bucket case (`prevStatus === nextStatus`) — short-circuit unchanged (no walk needed; only revision watermark updates).
    5. Extend existing tests to add per-kind assertions where they assert on `dirtyDescendantCount`; add 4 new tests: (i) untracked-only folder ends with `dirtyDescendantCountsByStatus = {untracked: N}`, (ii) mixed kinds — bucket per kind correct, (iii) downgrade — kind drops from map when its bucket hits zero, (iv) evict cleans buckets — surviving ancestor's bucket map is `undefined` after the subtree clears.

- [x] 6_2 Renderer stamps `git-folder-dirty-{status}` + CSS per-kind colors + larger folder dot
  - **Deps**: 6_1
  - **Refs**: specs/folder-dirty-color/spec.md#requirement-renderer-stamps-per-status-class-on-folder-rows; specs/folder-dirty-color/spec.md#requirement-css-per-status-colors-larger-folder-badge; design.md D10
  - **Scope**: src/webview/fileTree/ReadOnlyFileRenderer.ts, src/webview/fileTree/ReadOnlyFileRenderer.test.ts, src/webview/fileTree/fileTreePanel.css
  - **Acceptance**:
    - Outcome: (a) `renderElement` for folder rows computes the dominant status via the 6_1 helper and stamps `git-folder-dirty-{status}` (single class) in addition to the legacy `git-folder-dirty`. When dominant is `undefined`, neither class is stamped. Recycled rows correctly remove stale per-status classes from a prior render (clear ALL `git-folder-dirty-*` variants before stamping the new one). (b) `fileTreePanel.css` gains one color rule per propagating status (`untracked`, `added`, `modified`, `renamed`, `conflicted`) using the matching `--vscode-gitDecoration-*ResourceForeground` variable with documented fallbacks. The generic `.git-folder-dirty .git-badge` color rule (always modified) is removed. (c) Folder dirty dot bumps to `font-size: 14px` via `.file-tree-row.git-folder-dirty .git-badge` (keeps letter badges at 11px since only folder rows carry the class). Tests: (i) folder with `{untracked: 3}` → row class set has `git-folder-dirty-untracked`, no `git-folder-dirty-modified`; (ii) folder with `{untracked: 5, modified: 2, conflicted: 1}` → row class set has ONLY `git-folder-dirty-conflicted` from the per-status family; (iii) recycled row that previously had `git-folder-dirty-modified` and now has `{untracked: 1}` → `git-folder-dirty-modified` is removed, `git-folder-dirty-untracked` is added; (iv) folder with no buckets → no `git-folder-dirty-*` class stamped at all.
    - Verify: unit src/webview/fileTree/ReadOnlyFileRenderer.test.ts (extends existing folder badge tests)
  - **Plan**:
    1. In the renderer, replace the single `classList.toggle("git-folder-dirty", ...)` with: (a) clear every `git-folder-dirty-{status}` class first (small constant array of kind names), (b) compute dominant via helper, (c) toggle generic + stamp per-status if defined.
    2. Add CSS rules per the spec table; remove the now-stale generic color rule.
    3. Update existing 2 renderer tests to use the new field shape (`dirtyDescendantCountsByStatus: {untracked: 3}` instead of `dirtyDescendantCount: 3`). Add 4 new tests per Outcome (i)-(iv).

## 5. End-to-end + manual

- [x] 5_1 Manual verification — paste / rename / delete in VS Code Explorer AND outside-workspace dir is reflected (tree + search) + folder badge color matches descendant severity
  - **Deps**: 2_3, 3_2, 4_5, 4_7, 6_2
  - **Refs**: proposal.md § "UI Impact & E2E"; design.md D4a, D7, D9
  - **Scope**: (none — manual only)
  - **Acceptance**:
    - Outcome: With the extension running in the Extension Development Host:
      - **Inside workspace (root-special-case under test):** (a) open the AnyWhere Terminal file tree, paste a new file directly into the CURRENT ROOT folder (the synthetic root node case from D4a) via VS Code Explorer; the file appears in the AnyWhere tree with a `U` (untracked) badge within ~300 ms with no manual re-expand. (b) Expand a subfolder (e.g. `docs/external-research/`), paste into THAT folder; file appears with `U`. (c) Rename a file via VS Code Explorer; old name disappears, new name appears with `U`. (d) Delete a file via VS Code Explorer; row disappears.
      - **Outside workspace (arbitrary-root case — the user's explicit requirement):** (e) use the file tree's existing arbitrary-folder navigation (`setRoot` via reveal or similar) to point the tree at a directory OUTSIDE the workspace — `mktemp -d /tmp/aw-test-XXXX`, populate with a few files, then point the tree there. (f) From a shell outside VS Code, `touch /tmp/aw-test-XXXX/new-file.md`; assert the new file appears in the AnyWhere tree within ~300 ms. (g) `mv /tmp/aw-test-XXXX/new-file.md /tmp/aw-test-XXXX/renamed.md`; assert old disappears, new appears. (h) `rm /tmp/aw-test-XXXX/renamed.md`; assert row disappears.
      - **Search-cache invalidation (D9):** (j) open the AnyWhere search bar pinned to the workspace root; type a query that returns some hits and confirm the result count. Close search. From VS Code Explorer paste a new file `search-test-XXXX.md` into the workspace root. Re-open the search bar within 60 s and type a query that should match the new file (e.g. `search-test`); the new file MUST appear in results. (Without 4_7's fix, this would miss because the search controller would serve its stale 60 s cache.) (k) Repeat (j) for the outside-workspace scope: search active in `/tmp/aw-test-XXXX`, shell-create a new file, re-search → must include new file.
      - **Focus rehydrate:** (i) close the laptop lid for ~30 seconds, modify a file externally (`touch /tmp/aw-test-XXXX/post-sleep.md`), reopen lid; on focus regain, the affected directory refreshes within ~1 second showing the new file. If the search bar was open at sleep, the search results also refresh after focus regain (cache dropped via `FileTreeSearchController.onRehydrate`).
      - **Folder badge color (D10):** (l) point the tree at a repo where some folder (e.g. `docs/`) contains only NEW (untracked) files in git → assert the folder's `•` badge renders in the GREEN untracked color, matching VS Code Explorer. (m) modify a tracked file inside that same folder → assert the badge upgrades to ORANGE modified color (modified outranks untracked in severity). (n) create a merge conflict in a file inside the folder (or simulate with `git update-index --chmod=+x` to dirty an entry, alternatively just observe an existing conflicted file if available) → assert badge upgrades to RED conflicted color. (o) clear the highest-severity descendant (e.g. resolve the conflict, stage the modified file) → badge SHOULD downgrade to the next-highest present severity. (p) badge dot is visibly comparable in size to VS Code Explorer's badge (no longer the tiny 11px dot).
    - Verify: manual paste/rename/delete a file via VS Code Explorer with the AnyWhere tree visible AND outside-workspace shell-driven changes AND search-cache regression checks (j)+(k) AND folder badge color (l)-(p)
  - **Plan**:
    1. `pnpm run package` (or however the project builds the extension); F5 to launch the Extension Development Host.
    2. Walk through checks (a)-(d) inside workspace.
    3. Create temp dir outside workspace; point tree there; walk through (e)-(h).
    4. Search-cache checks (j)-(k): each must use the SAME search-bar session (do not switch scope or close-and-reopen-the-extension between paste and re-search) so the 60 s cache window is actually in scope of the test.
    5. Run focus-rehydrate check (i) if time permits (laptop lid optional — alternative: cmd-tab away for 30s then back, simulating focus loss).
    6. Record pass/fail per check in workflow.md Revision Log; any failure blocks 5_1 completion.
