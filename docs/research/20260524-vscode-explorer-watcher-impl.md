---
topic: vscode-explorer-watcher-impl
created-by: research for add-file-tree-fs-watcher (internal VS Code source reading)
date: 2026-05-24
source-tree: /Users/huybuidac/Projects/ai-oss/vscode
used-by: [add-file-tree-fs-watcher]
---

# Research: VS Code Explorer file-watcher implementation (internal)

Source tree read: `/Users/huybuidac/Projects/ai-oss/vscode` (commit on `main`). All file paths below are absolute inside that tree unless noted.

## TL;DR (design decisions to copy)

- **Watch coarse, react debounced.** VS Code Explorer does NOT create a per-folder watcher when you expand a node. It rides on a single recursive watcher per workspace folder (registered by `WorkspaceWatcher`) and listens to the global `IFileService.onDidFilesChange` stream. Per-node refresh decisions are made by inspecting events against the resolved model.
- **Single trailing debounce around 500 ms** is used at the Explorer layer (`EXPLORER_FILE_CHANGES_REACT_DELAY = 500`) to coalesce bursts and "give our internal events a chance to react first" (i.e. let VS Code-initiated `onDidRunOperation` apply model mutations before the FS-watcher echo lands).
- **VS Code performs two coalescing stages on top of the OS event stream:**
  1. Watcher-side aggregation: a `RunOnceWorker` with delay `FILE_CHANGES_HANDLER_DELAY = 75 ms` (Parcel and NodeJS watchers) plus a `ThrottledWorker` (`throttleDelay: 200 ms`, `maxWorkChunkSize: 500`, `maxBufferedWork: 30000`) before any consumer sees events.
  2. Event-shape dedup: `coalesceEvents()` in `src/vs/platform/files/common/watcher.ts` (lines 342-470) collapses ADD+DELETE, DELETE+ADD→UPDATE, and prunes child-of-deleted-folder DELETEs.
- **Watch requests are deduped by `(resource + options)` hash** with refcounting in `FileService.doWatch` (lines 1218-1249). Multiple Explorer instances or extensions calling `watch()` on the same path produce ONE underlying provider watcher.
- **Recursive vs non-recursive split**: `UniversalWatcher` (`src/vs/platform/files/node/watcher/watcher.ts`) routes `recursive: true` requests to `ParcelWatcher`, `recursive: false` to `NodeJSWatcher` (Node `fs.watch`). Non-recursive can also be "absorbed" by an existing recursive watcher (the comment at line 42-44 of `watcher.ts` explicitly says "recursive watchers first... to step in for non-recursive watch requests, thus reducing watcher duplication").
- **Explorer refresh scope is parent-level**, not ancestor walk: `onDidRunOperation` calls `view.refresh(shouldDeepRefresh, parent)` for CREATE/MOVE/DELETE. The `shouldDeepRefresh` flag is only `true` when `explorer.fileNesting` is enabled.
- **Excludes and rename**: `files.watcherExclude` → `IWatchOptions.excludes` is forwarded to the provider; excluded paths emit no events. External rename arrives as DELETE+ADD; same-folder case-only renames are explicitly preserved (see `EventCoalescer.processEvent`, line 403-405).

## 1. Explorer view watcher wiring

**Key files:**
- `src/vs/workbench/contrib/files/browser/explorerService.ts` (479 lines, see esp. 35, 65-112, 345-441)
- `src/vs/workbench/contrib/files/browser/workspaceWatcher.ts` (212 lines)
- `src/vs/workbench/contrib/files/browser/views/explorerView.ts` (esp. 717-729 `refresh()`)

### Where the recursive watcher is registered

`WorkspaceWatcher.watchWorkspace` (`workspaceWatcher.ts:133-180`) is the only place Explorer's tree contents come from. For every workspace folder:

```ts
disposables.add(this.fileService.watch(pathToWatch, { recursive: true, excludes }));
```

`excludes` is derived directly from `files.watcherExclude` (lines 136-144). `files.watcherInclude` is appended (lines 152-172). The whole set is rebuilt on `onDidChangeWorkbenchState` and any `files.watcherExclude` / `files.watcherInclude` config change (line 67-71).

The Explorer does NOT add additional watchers when folders are expanded.

### How the Explorer reacts to events

`ExplorerService` constructor (`explorerService.ts:65-112`):

```ts
private static readonly EXPLORER_FILE_CHANGES_REACT_DELAY = 500;
// "delay in ms to react to file changes to give our internal events a chance to react first"

this.onFileChangesScheduler = new RunOnceScheduler(async () => {
  const events = this.fileChangeEvents;
  this.fileChangeEvents = [];
  // ...decide whether to refresh based on resolved model...
  if (shouldRefresh) await this.refresh(false);
}, 500);

this.fileService.onDidFilesChange(e => {
  this.fileChangeEvents.push(e);
  if (this.editable) return; // ignore while rename inline-input is open
  if (!this.onFileChangesScheduler.isScheduled()) this.onFileChangesScheduler.schedule();
});
```

`RunOnceScheduler.schedule()` is trailing-edge: it sets a single `setTimeout(500)` and is a no-op if already scheduled. All events arriving inside the 500 ms window are batched into `fileChangeEvents` and inspected together.

### Refresh-scope decision

In the scheduler callback (`explorerService.ts:69-95`):

- Filter to `[DELETED]` (and `[UPDATED]` only when sort order is `Modified`).
- `doesFileEventAffect(...)` (lines 506-521) recurses through **already-visible, resolved** children only; returns `true` if any visible child matches the events. Hidden / collapsed-but-not-resolved subtrees are skipped — VS Code never refreshes what it has not yet rendered.
- For ADDED events (lines 84-95): for each `rawAdded` resource, find the parent in the model; if the parent is resolved but the model has no child of that name → refresh.
- If nothing in the visible model is affected → no refresh fires.

When a refresh is needed it is currently a full `this.refresh(false)` (top-level model `forgetChildren()` + `view.refresh(true)`, see `refresh()` at lines 324-341). The granular per-parent refresh path is only used for **VS Code-initiated** operations via `onDidRunOperation` (lines 345-441): CREATE/COPY → `view.refresh(shouldDeepRefresh, parent)`, MOVE → rename in place or refresh old+new parent, DELETE → remove child from parent model then `view.refresh(shouldDeepRefresh, parent)`. So external FS-watcher events trigger a coarser refresh than internal UI-driven operations.

### Window-focus recovery

`explorerService.ts:133-137`: `hostService.onDidChangeFocus(hasFocus => hasFocus && this.refresh(false))` — when the window regains focus, refresh unconditionally. Comment: "compensate for missing file events #126817". Useful pattern for our webview when it regains visibility.

## 2. `IFileService.watch` contract

**Key file:** `src/vs/platform/files/common/files.ts`, `src/vs/platform/files/common/fileService.ts`.

### Signature (files.ts:255-264)

```ts
createWatcher(resource: URI, options: IWatchOptionsWithoutCorrelation & { recursive: false }): IFileSystemWatcher;
watch(resource: URI, options?: IWatchOptionsWithoutCorrelation): IDisposable;
```

`IWatchOptionsWithoutCorrelation` (files.ts:526-560):
- `recursive: boolean`
- `excludes: string[]` — glob patterns or paths, resolved against the watched folder.
- `includes?: Array<string | IRelativePattern>` — if absent, all paths qualify.
- `filter?: FileChangeFilter` — bitmask `ADDED | UPDATED | DELETED` (files.ts:572-576).

`IWatchOptionsWithCorrelation` adds `correlationId: number`. The correlated path (`createWatcher`) returns `IFileSystemWatcher { onDidChange: Event<FileChangesEvent>; dispose }` — events flow **only** to that watcher and do NOT appear in the global `onDidFilesChange` stream.

### Event payload (files.ts:986-1170)

```ts
interface IFileChange {
  type: FileChangeType;   // 0=UPDATED, 1=ADDED, 2=DELETED
  readonly resource: URI;
  readonly cId?: number;  // correlation id
}

class FileChangesEvent {
  rawAdded: URI[]; rawUpdated: URI[]; rawDeleted: URI[];
  contains(resource, ...types): boolean;   // direct match (+ parent for DELETE)
  affects(resource, ...types): boolean;    // match this or any descendant
  gotAdded() / gotUpdated() / gotDeleted();
  correlates(correlationId): boolean;
}
```

`onDidFilesChange` (files.ts:91-95) carries `FileChangesEvent` — a **batch** of changes per emit. Single-change emits are rare; the watcher layer always aggregates first.

### Dedup of watch requests (fileService.ts:1218-1249)

```ts
private readonly activeWatchers = new Map<number /* hash(resource+options) */,
  { disposable: IDisposable; count: number }>();

private async doWatch(resource: URI, options: IWatchOptions): Promise<IDisposable> {
  const watchHash = hash([providerExtUri.getComparisonKey(resource), options]);
  let watcher = this.activeWatchers.get(watchHash);
  if (!watcher) {
    watcher = { count: 0, disposable: provider.watch(resource, options) };
    this.activeWatchers.set(watchHash, watcher);
  }
  watcher.count += 1;
  return toDisposable(() => {
    watcher.count--;
    if (watcher.count === 0) { dispose(watcher.disposable); this.activeWatchers.delete(watchHash); }
  });
}
```

**Implication for our extension:** if FileTreeHost A and FileTreeHost B both ask `workspace.fs` to watch `/foo/bar` with identical options, VS Code's file service is refcounted and creates one underlying provider watcher. **However** `workspace.createFileSystemWatcher` (the EXTENSION API) goes through the extension host bridge and ultimately calls `mainThreadFileSystemEventService` which calls `IFileService.createWatcher` (correlated). Two extension-side watchers with the same `RelativePattern` will produce two correlated requests with DIFFERENT correlationIds — they still hash differently because correlationId is in `options`, so **dedup at the file-service layer is on options including correlationId** = no dedup across our N hosts. Recommendation: dedup ourselves (see §5).

### Correlation routing (fileService.ts:1149-1213, 60-76)

```ts
provider.onDidChangeFile(changes => {
  const event = new FileChangesEvent(changes, !this.isPathCaseSensitive(provider));
  this.internalOnDidFilesChange.fire(event);                       // all events
  if (!event.hasCorrelation()) this._onDidUncorrelatedFilesChange.fire(event);  // global only if NOT correlated
});
```

Correlated watchers exist precisely so an extension can watch a path WITHOUT spraying events into Explorer / search / etc. This is the foundation we should use.

## 3. Internal watcher implementations

**Key files:**
- `src/vs/platform/files/node/watcher/watcher.ts` (top-level `UniversalWatcher`)
- `src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts`
- `src/vs/platform/files/node/watcher/nodejs/nodejsWatcherLib.ts`
- `src/vs/platform/files/node/watcher/baseWatcher.ts`
- `src/vs/platform/files/common/watcher.ts` (`coalesceEvents`, `EventCoalescer`)

### Recursive vs non-recursive selection (watcher.ts:38-64)

```ts
async watch(requests: IUniversalWatchRequest[]): Promise<void> {
  // Watch recursively first to give recursive watchers a chance
  // to step in for non-recursive watch requests, thus reducing
  // watcher duplication.
  await this.recursiveWatcher.watch(requests.filter(r => isRecursiveWatchRequest(r)));
  await this.nonRecursiveWatcher.watch(requests.filter(r => !isRecursiveWatchRequest(r)));
}
```

- `ParcelWatcher` for recursive (native fsevents / inotify / Windows ReadDirectoryChangesW via Parcel).
- `NodeJSWatcher` / `NodeJSFileWatcherLibrary` for non-recursive (`fs.watch`).
- A non-recursive request whose path falls inside an active recursive watcher's tree is "subscribed" to that recursive watcher rather than spawning a separate `fs.watch` (the `IRecursiveWatcherWithSubscribe.subscribe()` API, `common/watcher.ts:139-151`).

### Watcher-side coalescing constants

**`ParcelWatcher` (parcel/parcelWatcher.ts:170-188):**
```ts
private static readonly FILE_CHANGES_HANDLER_DELAY = 75;  // RunOnceWorker batch window
private readonly throttledFileChangesEmitter = new ThrottledWorker<IFileChange>({
  maxWorkChunkSize: 500,    // up to 500 changes at once...
  throttleDelay: 200,       // ...rest 200ms between chunks...
  maxBufferedWork: 30000    // ...cap memory at 30000 buffered events
}, events => this._onDidChangeFile.fire(events));
```

**`NodeJSFileWatcherLibrary` (nodejs/nodejsWatcherLib.ts:28-51):**
```ts
private static readonly FILE_DELETE_HANDLER_DELAY = 100;   // delete confirmation delay
private static readonly FILE_CHANGES_HANDLER_DELAY = 75;
private readonly throttledFileChangesEmitter = new ThrottledWorker<IFileChange>(
  { maxWorkChunkSize: 500, throttleDelay: 200, maxBufferedWork: 30000 },
  events => this._onDidChangeFile.fire(events)
);
private readonly fileChangesAggregator = new RunOnceWorker<IFileChange>(
  events => this.handleFileChanges(events),
  NodeJSFileWatcherLibrary.FILE_CHANGES_HANDLER_DELAY  // 75
);
```

So the data path per OS event is roughly: native event → 75 ms aggregator → `coalesceEvents()` → throttler (200 ms / 500-chunks) → `_onDidChangeFile.fire(events)`.

The 100 ms delete delay (`FILE_DELETE_HANDLER_DELAY`) is specifically to distinguish "rename via delete+add" from real deletion when only the Node API surfaces.

### `coalesceEvents` semantics (`common/watcher.ts:342-470`)

Key shape rules from `EventCoalescer.processEvent`:
- Key uses lowercase fsPath off Linux (`isLinux` check) for case-insensitive collapse.
- ADD then DELETE for same key → both dropped (transient).
- DELETE then ADD → collapsed to UPDATE.
- ADD then UPDATE → keep ADD.
- Same key but DIFFERENT fsPath (only possible on case-insensitive FS) for ADD or DELETE → KEEP BOTH (this preserves case-rename detection).

And `coalesce()` final pass: "remove all DELETE events whose parent folder is also DELETEd" — so a single `rm -rf` of a folder yields ONE delete event for the folder, not 10 000 for its contents.

### Limits & errors

`AbstractWatcherClient.canRestart` (`common/watcher.ts:241-265`): on `ENOSPC` or `EMFILE` it **stops** trying to restart. `WorkspaceWatcher.onDidWatchError` (`workspaceWatcher.ts:73-131`) surfaces `ENOSPC` via a sticky notification with a link to inotify-limit docs. Generic `EUNKNOWN` prompts reload; `ETERM` only logs telemetry. Max restarts otherwise: 5 (`AbstractWatcherClient.MAX_RESTARTS = 5`).

No documented cap on number of `watch()` requests — handles are the limit.

## 4. Bundled extension patterns

### `extensions/markdown-language-features/src/client/fileWatchingManager.ts`

Maps `id → (watcher, parent-dir watchers[])`, plus a separate refcounted `_dirWatchers: ResourceMap`.

```ts
create(id, uri, watchParentDirs, listeners) {
  if (!vscode.workspace.fs.isWritableFileSystem(uri.scheme)) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(uri, '*'),
    !listeners.create, !listeners.change, !listeners.delete  // ignore flags
  );
  // ...
  if (watchParentDirs && uri.scheme !== Schemes.untitled) {
    for (let dirUri = Utils.dirname(uri); dirUri.path.length > 1; dirUri = Utils.dirname(dirUri)) {
      let parentDirWatcher = this._dirWatchers.get(dirUri);
      if (!parentDirWatcher) {
        const glob = new vscode.RelativePattern(Utils.dirname(dirUri), Utils.basename(dirUri));
        const parentWatcher = vscode.workspace.createFileSystemWatcher(glob, !listeners.create, true, !listeners.delete);
        parentDirWatcher = { refCount: 0, watcher: parentWatcher };
        this._dirWatchers.set(dirUri, parentDirWatcher);
      }
      parentDirWatcher.refCount++;
      // ...wire up listeners and push disposables
    }
  }
}

delete(id) { /* refcount-- on parent dir watchers, dispose when 0 */ }
```

**Patterns to copy:**
1. **Refcounted shared dir-watcher pool** keyed by URI string — exactly what we need for multi-FileTreeHost dedup.
2. Skip non-writable schemes (`workspace.fs.isWritableFileSystem(uri.scheme)`).
3. Use the ignore-flags constructor (`ignoreCreate, ignoreChange, ignoreDelete`) instead of subscribing to events you don't need — fewer event-loop wakeups.
4. **No debounce inside this manager.** The callers debounce (the markdown language server protocol round-trip is its own throttle).

### `extensions/typescript-language-features/src/tsServer/fileWatchingManager.ts`

Nearly identical structure. Differences:
- Adds `isRecursive` param → uses `'**'` glob when recursive, `'*'` otherwise (line 57): `new vscode.RelativePattern(uri, isRecursive ? '**' : '*')`.
- Logs every create/delete (the tsserver protocol needs traceability).
- Stat-checks parent-create events to confirm the actual file appeared (lines 80-91).

### `extensions/terminal-suggest/src/terminalSuggestMain.ts` (line 373)

Demonstrates outside-workspace watching with the simplest possible pattern:
```ts
for (const dir of pathDirectories) {
  if (activeWatchers.has(dir)) continue;          // simple Set-based dedup
  const stat = await fs.promises.stat(dir);       // pre-check it's a dir
  if (!stat.isDirectory()) continue;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(dir), '*')
  );
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(handleChange),
    watcher.onDidChange(handleChange),
    watcher.onDidDelete(handleChange)
  );
  activeWatchers.add(dir);
}
```

`handleChange` is debounced externally. The pattern shape `RelativePattern(Uri.file(absPath), '*')` is the canonical way to watch direct children of an arbitrary outside-workspace directory.

## 5. Recommendations for anywhere-terminal

### Scope: per-expanded-folder, NOT recursive at root

**VS Code Explorer uses a single recursive watcher per workspace folder.** We CAN'T copy that directly because:
- Our tree browses arbitrary directories the user picks at runtime (not workspace folders).
- A recursive watcher on `/` or `~` is catastrophic.
- Users explicitly expand subdirectories they care about — that gives us a natural watch set.

**Recommendation: ONE non-recursive watcher (`RelativePattern(dirUri, '*')`) per EXPANDED directory**, shared (refcounted) across all FileTreeHost instances. Reasons:
1. Non-recursive `fs.watch` is cheap and avoids inotify recursion blowups.
2. Matches our render granularity — the webview only renders direct children of expanded folders.
3. The markdown / ts extensions both use this pattern.
4. If the user later expands a subfolder, we add a watcher for it; collapse → unref.

Add an upper-bound guard: cap at e.g. 200 simultaneously watched directories per host process, then log + stop adding (mirrors how VS Code reacts to ENOSPC by refusing to add more).

### Dedup across FileTreeHost instances

**The extension API does NOT dedup across sibling watchers** (each `createFileSystemWatcher` becomes a separate correlated request in the file service — they hash differently because correlationId is part of the options hash). So:

- Build a **process-level `WatcherPool`** in the extension host, keyed by `dirUri.toString()`.
- Each FileTreeHost calls `pool.acquire(dirUri, onChange)` → returns a `Disposable`. Internally, `pool` creates ONE `vscode.FileSystemWatcher` on first acquire, refcount++ thereafter, dispose on last release.
- Fan out events from the single watcher to all subscribers.

This is exactly the markdown-language-features `_dirWatchers` pattern.

### Debounce window

Three layers exist in VS Code. Translated to our extension:

| Layer | VS Code value | Ours |
|---|---|---|
| Raw event → batched IFileChange[] | 75 ms (`FILE_CHANGES_HANDLER_DELAY`) | hidden inside `vscode.FileSystemWatcher`; already there |
| Throttled emit | 200 ms / 500-chunks | hidden inside `vscode.FileSystemWatcher`; already there |
| UI-layer "react to changes" | **500 ms** (`EXPLORER_FILE_CHANGES_REACT_DELAY`) | **150–250 ms in our webview push** |

We can be tighter than Explorer because:
- Our tree is smaller and has no FileNesting/Search/Outline competing for the event stream.
- The Explorer's 500 ms exists mostly to let `onDidRunOperation` win the race against the external echo for VS Code-initiated ops. We don't have that race for now (we don't have an `onDidRunOperation` equivalent yet). When we add one, we may want to raise to ~300 ms.

**Concrete: 150 ms trailing debounce per watched directory** (one timer per dirUri, not global). Use `RunOnceScheduler`-equivalent (`setTimeout` + clear).

### Push strategy: send the affected dirUri, let the webview decide

VS Code Explorer ultimately calls `tree.updateChildren(parent, recursive, ...)` which re-runs the model resolver for that subtree. The host re-fetches because the model lives host-side.

For us, the model is webview-side (rendered `EntryRow[]`). Options:

- **A. Host pushes "dir X changed"**, webview decides to re-fetch via existing `listDir` IPC. Simpler, lets the webview suppress refresh when X isn't currently visible (scrolled away, search active, etc.).
- **B. Host re-fetches `readdir(X)` and pushes the new entry array.** Saves one round-trip; matches our existing `entries:set` payload.

**Recommendation: B for the common case, with A as a hint when the host can't safely re-fetch** (e.g. the dir got deleted — push a `removed:X` event instead of a `set` with stale parent).

Mirror what `ExplorerService.onDidRunOperation` does (`explorerService.ts:352-441`): for CREATE/MOVE/DELETE it mutates the model in-place AND calls `view.refresh(false, parent)`. We can do the same by sending a typed event `{kind:'fs-changes', parent: dirUri, added?: [...], deleted?: [...]}` so the webview can apply in-place mutations cheaply when small, or replace the entry array when large.

### Filter only events we care about

Use the constructor flags to drop noise:

```ts
const w = workspace.createFileSystemWatcher(
  new RelativePattern(dirUri, '*'),
  /*ignoreCreate*/ false,
  /*ignoreChange*/ true,   // we don't render file content; skip UPDATE noise
  /*ignoreDelete*/ false
);
```

If the user enables sort-by-modified later, flip `ignoreChange` to `false` (mirrors Explorer's `if (sortOrder === Modified) types.push(UPDATED)` logic at `explorerService.ts:71-73`).

### Recovery: re-sync on focus

Copy `ExplorerService`'s window-focus refresh (`explorerService.ts:133-137`). When our webview becomes visible (panel show, editor activation), re-fetch all currently-visible expanded directories once. This covers the dropped-event case that the inotify/fsevents backends are known to have under load.

### Skip non-writable / virtual schemes

Per markdown extension (line 32): `if (!vscode.workspace.fs.isWritableFileSystem(uri.scheme)) return;`. For our extension we currently only browse local `file:` URIs, but worth adding the guard for future remote support.

### Inline-edit gate

`ExplorerService` skips the scheduler entirely when an inline rename input is open (`explorerService.ts:106-108`). We should do the same when a rename/new-file inline input is active in our tree, or events will overwrite the user's in-progress entry.

## Gaps

- I did not measure actual event latency on macOS / Linux / Windows; the 75 ms + 200 ms numbers are configured budgets, not observed latency.
- I did not enumerate `files.watcherExclude` defaults; for the recommendation here we don't need them, but if we ever surface a "respect VS Code's watcherExclude" toggle we should re-read `src/vs/workbench/contrib/files/browser/files.contribution.ts`.
- I did not trace the extension-host bridge (`mainThreadFileSystemEventService` / `extHostFileSystemEventService`) end-to-end, so I cannot prove that `workspace.createFileSystemWatcher` requests are NOT deduped across extension instances. The conclusion (no dedup across our N FileTreeHosts) is inferred from FileService's hash including `correlationId` (which the extension host assigns per request). If dedup is needed for performance, a dedicated bridge-side test would confirm.
- I did not look at the polling fallback path (used only for WSL1 — `pollingInterval`); irrelevant for our use case.
