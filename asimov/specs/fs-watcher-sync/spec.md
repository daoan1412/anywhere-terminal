# fs-watcher-sync Specification
## Requirements

### Requirement: FileSystemDataSource subscribes on fresh directory cache

When `FileSystemDataSource.getChildren(element)` first inserts a `FileNode` of `kind === 'directory'` into `nodeCache` (the freshly-cached branch already used for git-status pending drain), the data source SHALL post a `RequestSubscribeFsChangesMessage` carrying the directory's absolute path AND the current `rootGeneration`. Re-encounter of an already-cached directory SHALL NOT re-subscribe. The root path itself (the path used as `workspaceRoot` / `setRoot`) SHALL also be subscribed once when first read.

### Requirement: FileSystemDataSource unsubscribes on eviction

`FileSystemDataSource.evictSubtree(rootPath)` SHALL post `RequestUnsubscribeFsChangesMessage` for every evicted absolute path whose cached node was a directory (including the eviction root itself when it is a directory). `handleRootChanged` SHALL post `RequestUnsubscribeFsChangesMessage` for every directory path present in `nodeCache` before clearing the cache. `dispose()` SHALL post one bulk unsubscribe for every subscribed path.

### Requirement: Subscription tracking is generation-pinned

Subscribe / unsubscribe messages SHALL be discarded by the host when their `rootGeneration` does not match the current host-side value. The data source SHALL NOT re-send subscriptions when `rootGeneration` advances — re-subscription is the natural consequence of `handleRootChanged` clearing the cache and the next `getChildren` re-populating it.

### Requirement: Apply fs-changes-invalidated

On receipt of `FsChangesInvalidatedMessage` carrying `{ parent: absPath, rootGeneration }`, `FileSystemDataSource` SHALL no-op when `rootGeneration` does not match `currentRootGeneration`. When the generation matches, the data source SHALL delegate to a panel-injected callback `onDirectoryInvalidated(absPath: string)` — NOT pre-filter on `nodeCache.get(absPath)`. The panel implementation of this callback (see `Requirement: Webview-side refresh routing`) is responsible for resolving `absPath` to the correct tree node, including the special case where `absPath === currentRootPath` (the root node is NOT in `nodeCache` — see design.md D4a).

#### Scenario: Invalidate hits an evicted directory

- **WHEN** an `fs-changes-invalidated` for path `P` arrives after `P` has already been evicted from `nodeCache` (race against `evictSubtree`)
- **THEN** the data source still calls `onDirectoryInvalidated(P)`; the panel's implementation SHALL silently no-op when `P` is neither the root nor a cached directory — no `Tree.refresh` call, no warning log — because the host's unsubscribe will reach the pool shortly and the post-eviction `getChildren` will resubscribe if `P` is loaded again

### Requirement: Apply fs-rehydrate

On receipt of `FsRehydrateMessage` (no payload beyond `rootGeneration`), the data source SHALL no-op on generation mismatch. On match, the data source SHALL invoke a panel-injected callback `onRehydrate()`. The panel implementation SHALL refresh the synthetic root node PLUS every currently-EXPANDED directory node — NOT every cached directory. `Tree.refresh` is NOT a no-op on collapsed cached nodes (see design.md D7 and `Tree.ts:622-638`); refreshing every cached directory would issue one `request-read-directory` RPC per cached entry with no UI benefit for collapsed ones.

### Requirement: Webview-side refresh routing

`FileTreePanel` SHALL be the single owner of `Tree<FileNode>` access; `FileSystemDataSource` SHALL NOT hold a direct reference to `Tree`. The panel SHALL inject two callbacks into the data source at construction:

- `onDirectoryInvalidated(absPath: string): void` — resolves `absPath` to a tree node by checking `absPath === currentRootPath` FIRST (refresh the synthetic root); else `dataSource.getCachedNode(absPath)` and refresh that node if it exists and is a directory; else no-op. The panel SHALL ALSO forward the same `absPath` to `FileTreeSearchController.onFsInvalidated(absPath)` (see `Requirement: Search controller cache invalidation on fs changes`).
- `onRehydrate(): void` — refreshes the synthetic root node, then iterates the tree's expand-state accessor and refreshes each currently-expanded directory node (deduplicated against the root). The panel SHALL ALSO call `FileTreeSearchController.onRehydrate()`.

### Requirement: Search controller cache invalidation on fs changes

`FileTreeSearchController` SHALL expose two new public methods that DO NOT depend on `Tree` and DO NOT trigger any refresh of the non-search view:

- `onFsInvalidated(absPath: string): void` — if `this.cache === null`, no-op. Else if `this.cache.scope === absPath` OR `absPath` is a path-separator-rooted descendant of `this.cache.scope` (i.e. starts with `this.cache.scope + path.sep`), the controller SHALL set `this.cache = null`. After cache invalidation, when `this.isActive()` is true, the controller SHALL call `scheduleEnumeration()` so the next render reflects fresh disk state without a keystroke. Paths outside the current cache scope SHALL be ignored without touching `this.cache`.
- `onRehydrate(): void` — if `this.cache === null`, no-op. Else SHALL set `this.cache = null`. When `this.isActive()` is true, SHALL call `scheduleEnumeration()`.

These methods SHALL be wired by `FileTreePanel` as part of the same `onDirectoryInvalidated` / `onRehydrate` callbacks that drive the tree refresh; the controller SHALL NOT subscribe to messages directly. Existing search-cache invalidation triggers (`onWorkspaceRootChanged`, scope mismatch in `enter`, 60s TTL) SHALL remain unchanged — these new methods are additive.

#### Scenario: Search cache invalidates when file created under scope

- **WHEN** the user has search active in scope `/foo`, the cache holds 1000 enumerated paths, and `onFsInvalidated('/foo/bar')` is called (a new file was created in `/foo/bar`)
- **THEN** `this.cache` is set to `null` and a debounced enumeration is scheduled so the user sees fresh results on the next render tick

#### Scenario: Search cache survives fs change outside scope

- **WHEN** the user has search active in scope `/foo`, the cache is fresh, and `onFsInvalidated('/baz/qux')` is called (a change in an unrelated tree branch)
- **THEN** `this.cache` is unchanged and no enumeration is scheduled — the cache scope is not affected by the change

#### Scenario: Search cache invalidates on rehydrate even when search bar closed

- **WHEN** the user opened search in `/foo`, closed it (cache retained per existing `exit()` contract), and a window-focus rising edge fires `onRehydrate()` 5 seconds later
- **THEN** `this.cache` is dropped immediately so a re-entry within the 60s TTL window will re-enumerate (no stale results from before sleep/wake). Because `isActive()` is false, no enumeration fires until the user re-enters search.

