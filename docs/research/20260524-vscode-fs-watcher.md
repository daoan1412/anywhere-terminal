---
topic: vscode-fs-watcher
created-by: research for add-file-tree-fs-watcher VS Code file watcher design
date: 2026-05-24
libraries: [vscode]
used-by: [add-file-tree-fs-watcher]
---

# Research: VS Code file-system watcher APIs

## Answers

1. **API surface**
   - `workspace.createFileSystemWatcher(...)` is the low-level file watcher API for on-disk or provider-backed file changes. It emits `onDidCreate`, `onDidChange`, and `onDidDelete` for filesystem activity.
   - `workspace.onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` are **workspace file-operation** events, not general disk-change events. They fire for user gestures in Explorer and `workspace.applyEdit`, but **not** for external changes made by another app or via `workspace.fs`.
   - Practical split: use `createFileSystemWatcher` for external FS sync; use `onDid*Files` only if you need to react to VS Code-initiated file ops.

2. **Glob patterns**
   - Yes, `createFileSystemWatcher` can watch **outside workspace folders** when you pass a `RelativePattern` whose base is a `Uri` or absolute path. A plain string glob is workspace-scoped and ignores paths outside the workspace.
   - `RelativePattern(base, pattern)` is the right tool for arbitrary directories. The docs explicitly prefer `WorkspaceFolder` inside the workspace, and `Uri`/string for paths outside it.
   - `*` matches direct children only. `**` matches any number of path segments, including none. For a single directory’s direct children, use `new RelativePattern(dirUri, '*')`. For recursive subtree watching, use `new RelativePattern(dirUri, '**/*')` (or similar recursive glob).
   - No official hard max watcher count was found. In practice the limit is OS/file-handle driven; on Linux, large recursive trees can hit inotify limits.

3. **Event semantics**
   - VS Code does **not** document built-in debounce/coalescing for `FileSystemWatcher` events. Assume bursts are possible and debounce client-side.
   - Rename: `workspace.onDidRenameFiles` is a separate workspace-edit event, but it does **not** fire for external `mv`/rename-on-disk operations. For external renames, expect `onDidDelete` + `onDidCreate` (or `onDidChange` in some cases) from `FileSystemWatcher`, not a dedicated rename event.
   - `files.watcherExclude` can suppress watch activity. The internals docs say uncorrelated recursive watchers inherit watcher excludes, and the runtime/watch APIs explicitly say excludes should be derived from `files.watcherExclude`. For a file tree that tries to reflect the real filesystem, the safest assumption is that watcher-excluded paths may not generate events.

4. **Lifecycle**
   - Yes, disposers must be called explicitly. `FileSystemWatcher` extends `Disposable`, and the API docs say the returned watcher “must be disposed when no longer needed.”
   - A dynamic add/remove model is normal: keep a map keyed by watched directory/root, create watchers on expand, dispose on collapse, and reuse a single refresh/debounce pipeline.
   - OSS pattern: markdown preview, TS, and other extensions create per-root watchers and store them so they can be torn down when the tree/view changes.

5. **Throttling / coalescing**
   - For “many files dropped at once,” debounce the tree refresh rather than refreshing per event. Common practice is a trailing-edge debounce keyed by watched root or parent directory.
   - Refreshing the **immediate parent** is usually enough for a collapsed directory refresh; walk ancestors only if your tree caches parent aggregates (counts, badges, nested collapse state) that can change from descendant edits.
   - If you need to absorb unzip/extract bursts, a short trailing debounce plus a second “settle” pass is a common pattern.

6. **Alternatives**
   - Lower-level `fs.watch` / `chokidar` gives more control, but it bypasses VS Code’s file-service semantics and is a worse fit for remote/virtual filesystems. VS Code’s docs explicitly prefer workspace file watching over node equivalents.
   - VS Code’s own watcher internals use different backends: recursive watching uses ParcelWatcher; non-recursive uses NodeJSWatcherLibrary. Public docs do not identify a separate Explorer-specific watcher; Explorer ultimately rides on the same file service/file watcher stack.

7. **References / examples**
   - Well-known OSS examples that watch arbitrary directories with `RelativePattern(Uri.file(...), ...)`:
     - `microsoft/vscode/extensions/terminal-suggest/src/terminalSuggestMain.ts` — `new RelativePattern(vscode.Uri.file(dir), '*')`
     - `aws/aws-toolkit-vscode/packages/core/src/codewhispererChat/controllers/chat/controller.ts` — watches a user prompts directory outside the workspace with `RelativePattern(Uri.file(getUserPromptsDirectory()), ...)`
     - `Shopify/ruby-lsp/vscode/src/workspace.ts` — per-root watcher management with `RelativePattern(...)` and debounced follow-up work
   - Official docs / references:
     - VS Code API reference: `workspace.createFileSystemWatcher`, `RelativePattern`, `FileSystemWatcher`
     - VS Code File Watcher Internals wiki
     - VS Code Linux ENOSPC / file-watcher limit docs

## 1. API surface

### Exact signatures
```ts
export function createFileSystemWatcher(
  globPattern: GlobPattern,
  ignoreCreateEvents?: boolean,
  ignoreChangeEvents?: boolean,
  ignoreDeleteEvents?: boolean
): FileSystemWatcher;

export type GlobPattern = string | RelativePattern;

export class RelativePattern {
  constructor(base: WorkspaceFolder | Uri | string, pattern: string);
  baseUri: Uri;
  base: string; // deprecated
  pattern: string;
}

export interface FileSystemWatcher extends Disposable {
  readonly ignoreCreateEvents: boolean;
  readonly ignoreChangeEvents: boolean;
  readonly ignoreDeleteEvents: boolean;
  readonly onDidCreate: Event<Uri>;
  readonly onDidChange: Event<Uri>;
  readonly onDidDelete: Event<Uri>;
}

export const onDidCreateFiles: Event<FileCreateEvent>;
export const onDidDeleteFiles: Event<FileDeleteEvent>;
export const onDidRenameFiles: Event<FileRenameEvent>;
```

### Difference in behavior
- `FileSystemWatcher` is about file-system activity on disk or in providers.
- `onDid*Files` is about workspace file operations (Explorer + `workspace.applyEdit`).
- `onDid*Files` explicitly does **not** fire for external changes.

### Code pattern sketch
```ts
const watcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(vscode.Uri.file(dir), '*')
);
watcher.onDidCreate(refresh);
watcher.onDidChange(refresh);
watcher.onDidDelete(refresh);
```

## 2. Glob patterns

### Outside workspace
- A plain string glob such as `'**/*.js'` is workspace-scoped.
- To watch an arbitrary directory, use `RelativePattern(Uri.file(path), glob)`.
- The docs explicitly show outside-workspace examples with `Uri.file(<path>)`.

### Recursive vs. direct-child behavior
- `*` = direct children only.
- `**` = recursive path segments.
- A tree watching only one directory level should use `RelativePattern(dirUri, '*')`.
- A recursive subtree watcher should use `RelativePattern(dirUri, '**/*')` or `**/*.ext`.

### Code pattern sketch
```ts
// Direct children only
const childWatcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(dirUri, '*')
);

// Recursive
const recursiveWatcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(dirUri, '**/*')
);
```

### Gotchas
- `RelativePattern` base must be absolute and free of `.` / `..`.
- Backslashes are not valid in glob patterns; use `RelativePattern` to normalize path separators.
- No hard watcher-count limit is documented by VS Code.

## 3. Event semantics

### Debounce/coalescing
- There is no official debounce guarantee in the API docs for `FileSystemWatcher`.
- Treat events as a bursty stream and debounce your UI refreshes.
- Some OSS extensions also dedupe via content hashing before doing heavier work.

### Rename behavior
- `workspace.onDidRenameFiles` is a distinct event, but it is **workspace-edit only**.
- External rename-on-disk is not reported as a rename event; handle it as delete/create at the watcher layer.

### `files.watcherExclude`
- The watcher internals docs say recursive watchers inherit watcher excludes, so some paths may never emit events.
- The `watch(uri, { recursive, excludes })` doc in `vscode.d.ts` says excludes are typically derived from `files.watcherExclude` and no event should be emitted for excluded files.
- For the custom tree, the safest design is to expect excluded paths may not update and to document that behavior.

### Code pattern sketch
```ts
const refresh = debounce(() => tree.refresh(), 150);
watcher.onDidCreate(refresh);
watcher.onDidChange(refresh);
watcher.onDidDelete(refresh);
```

## 4. Lifecycle

### Disposers
- `FileSystemWatcher` is `Disposable`; call `dispose()` when the watched subtree is collapsed or removed.
- Failing to dispose can leak listeners and keep backend watch resources alive.

### Dynamic add/remove pattern
- Keep a registry of active watchers per expanded directory.
- Add on expand, remove on collapse.
- Rebuild watchers if the base directory itself changes.

### OSS pattern sketch
```ts
const watchers = new Map<string, vscode.FileSystemWatcher>();

function watchDir(dir: vscode.Uri) {
  if (watchers.has(dir.toString())) return;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*'));
  watchers.set(dir.toString(), watcher);
}

function unwatchDir(dir: vscode.Uri) {
  watchers.get(dir.toString())?.dispose();
  watchers.delete(dir.toString());
}
```

### OSS examples
- `extensions/markdown-language-features/src/client/fileWatchingManager.ts` in `microsoft/vscode`
- `extensions/typescript-language-features/src/tsServer/fileWatchingManager.ts` in `microsoft/vscode`
- `src/extension.ts` in `aws/aws-toolkit-vscode`

## 5. Throttling / coalescing

### Common patterns
- Single trailing debounce for any event on the same watched root.
- Optional per-root timers if many directories can update independently.
- A “settle” refresh after a burst is often more robust than firing immediately on every event.

### Refresh scope
- Refresh the immediate parent when a child changes and the tree is already expanded at that level.
- Walk ancestors only if parent labels/badges or cached descendant counts depend on the changed subtree.
- For bulk drops (zip/unzip, git checkout, mass rename), prefer refreshing the smallest subtree that can become stale.

### Code pattern sketch
```ts
const queue = new Set<string>();
let timer: NodeJS.Timeout | undefined;

function scheduleRefresh(parentKey: string) {
  queue.add(parentKey);
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const key of queue) refreshSubtree(key);
    queue.clear();
  }, 150);
}
```

## 6. Alternatives

### Node `fs.watch` / chokidar
**Pros**
- More direct control over a raw directory tree.
- Can watch paths VS Code may not model for you.

**Cons**
- Less aligned with VS Code remote/virtual filesystem behavior.
- Bypasses VS Code’s file-service heuristics and excludes.
- Duplicates functionality VS Code already provides.

### VS Code internal file watcher stack
- Public docs indicate recursive watching uses ParcelWatcher and non-recursive uses NodeJSWatcherLibrary.
- This is the preferred route for extension code because it works with VS Code’s broader FS model.

### Code pattern sketch
```ts
// Prefer this in extensions
vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, '*'));

// Only consider raw fs watchers if you must bypass VS Code semantics
fs.watch(dirPath, { recursive: false }, ...);
```

## 7. References

### Official VS Code docs
- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code File Watcher Internals wiki](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals)
- [VS Code File Watcher Issues wiki](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues)
- [VS Code Linux setup / ENOSPC watcher docs](https://code.visualstudio.com/docs/setup/linux)
- [v1.84 release notes](https://code.visualstudio.com/updates/v1_84)
- [v1.75 release notes](https://code.visualstudio.com/updates/v1_75)

### Relevant issues
- [Allow `createFileSystemWatcher` to watch files outside of the workspace #136725](https://github.com/microsoft/vscode/issues/136725)
- [Recursive folder watching outside workspace triggers `onDidChange` twice #163352](https://github.com/microsoft/vscode/issues/163352)
- [`files.watcherExclude` doesn't appear to work for paths outside the workspace #223790](https://github.com/microsoft/vscode/issues/223790)
- [`createFileSystemWatcher` not working correctly with `FOLDER_NAME\\**` #172939](https://github.com/microsoft/vscode/issues/172939)

### OSS examples
- [microsoft/vscode `terminalSuggestMain.ts`](https://github.com/microsoft/vscode/blob/main/extensions/terminal-suggest/src/terminalSuggestMain.ts)
- [aws/aws-toolkit-vscode `controller.ts`](https://github.com/aws/aws-toolkit-vscode/blob/master/packages/core/src/codewhispererChat/controllers/chat/controller.ts)
- [Shopify/ruby-lsp `workspace.ts`](https://github.com/Shopify/ruby-lsp/blob/main/vscode/src/workspace.ts)

## Confidence

**High** — confirmed by the VS Code API declarations, the VS Code file-watcher internals wiki, release notes, and real-world extension usage examples.

## Gaps

- I did not find an official VS Code recommendation for a specific debounce interval.
- I did not find a documented hard maximum watcher count; practical limits are OS- and workspace-size-dependent.
- Public docs do not clearly separate “Explorer internals” from the shared file-service watcher stack, so the best-supported statement is about the shared watcher implementation rather than Explorer alone.
