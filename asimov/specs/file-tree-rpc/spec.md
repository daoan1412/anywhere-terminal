# file-tree-rpc Specification
## Requirements

### Requirement: ReadDirectory message types

The system SHALL define typed discriminated-union messages in `src/types/messages.ts` for reading directories: `RequestReadDirectory` (webview → extension; carries `requestId: string`, `path: string`, `rootGeneration: number`), and `ReadDirectoryResponse` (extension → webview; carries `requestId: string`, `rootGeneration: number`, `entries: FileEntry[]` OR `error: ReadDirectoryError`). The `FileEntry` type SHALL contain at minimum `{ name: string, path: string, kind: 'file' | 'directory' }`.

### Requirement: Extension-host read handler

The system SHALL handle `RequestReadDirectory` in the extension host by invoking `vscode.workspace.fs.readDirectory(uri)`, mapping the result to `FileEntry[]`, and posting `ReadDirectoryResponse` back with the current `rootGeneration`. Errors SHALL be caught and returned as `error: { code, message }` rather than thrown.

#### Scenario: Path outside workspace

- **WHEN** the webview requests a directory whose resolved absolute path is not contained in any `vscode.workspace.workspaceFolders[i].uri.fsPath` (or under it)
- **THEN** the extension SHALL respond with `error: { code: 'OUT_OF_WORKSPACE', message: <human text> }` and SHALL NOT read the directory

#### Scenario: Stale request after workspace folder change

- **WHEN** the webview's `rootGeneration` in a request does not match the current host-side generation
- **THEN** the extension SHALL respond with `error: { code: 'STALE_ROOT', message: <human text> }` and the webview SHALL drop the response without applying it

### Requirement: Workspace root generation

The system SHALL maintain a monotonically increasing `rootGeneration: number` on the extension host that increments each time `vscode.workspace.onDidChangeWorkspaceFolders` fires. The current value SHALL be sent to the webview in `InitMessage` (or an equivalent init/sync message) AND on every workspace-folder change via a new `WorkspaceRootChanged` message containing the new root path AND the new generation number.

### Requirement: Webview-side root-change invalidation

The system SHALL clear all pending RPC requests, clear all data-source caches, and re-fetch the tree root on receipt of `WorkspaceRootChanged`. Pending request promises SHALL be rejected with a CancellationError so consumers don't hang.

### Requirement: File system provider interface (webview side)

The system SHALL define an `IFileSystemProvider` interface in webview code with read-only methods `readDirectory(path: string): Promise<FileEntry[]>` and `stat(path: string): Promise<FileStat>`, AND with subscription-management methods `subscribeFsChanges(path: string): void` and `unsubscribeFsChanges(paths: string[]): void` (both fire-and-forget — the data source emits these as side effects of cache lifecycle, not as user actions). The interface SHALL be designed so that adding write methods (`rename`, `delete`, `create`) in a future change extends rather than replaces this interface.

### Requirement: RPC correlation

The system SHALL correlate `RequestReadDirectory` to `ReadDirectoryResponse` by a webview-generated `requestId`. Pending requests SHALL be tracked in a map; on response, the matching pending promise resolves and is removed. Unmatched responses (unknown `requestId` OR mismatched `rootGeneration`) SHALL be logged and dropped without crashing.

### Requirement: Workspace root resolution

The system SHALL treat the first entry of `vscode.workspace.workspaceFolders` as the tree's root. If no workspace folder is open, the tree SHALL display an empty-state message; opening a workspace folder SHALL trigger a generation increment and a `WorkspaceRootChanged` message that the webview uses to refresh the tree.

### Requirement: RequestFileTreeSearch message type (enumeration request)

The system SHALL define `RequestFileTreeSearchMessage` in `src/types/messages.ts` as a webview → extension discriminated-union member with shape: `{ type: 'request-file-tree-search'; requestId: string; rootGeneration: number; scopePath: string; maxResults: number }`. The `scopePath` SHALL be an absolute filesystem path; `maxResults` SHALL default to 2000 and SHALL be in the range `[1, 5000]`. The request SHALL NOT carry a query string — fuzzy filtering is performed client-side over the returned enumeration.

### Requirement: FileTreeSearchResponse message type

The system SHALL define `FileTreeSearchResponseMessage` in `src/types/messages.ts` as an extension → webview discriminated-union member with shape: `{ type: 'file-tree-search-response'; requestId: string; rootGeneration: number; results?: FileTreeSearchResult[]; truncated?: boolean; error?: { code: string; message: string } }`. The `FileTreeSearchResult` SHALL be `{ absolutePath: string; relativePath: string }` where `relativePath` is `path.relative(scopePath, absolutePath)` using forward-slash separators on ALL platforms.

### Requirement: Extension-host enumeration handler

The system SHALL handle `RequestFileTreeSearchMessage` in the extension host by invoking `vscode.workspace.findFiles(new vscode.RelativePattern(scopeUri, '**/*'), undefined, maxResults, cancellationToken)` where `scopeUri = vscode.Uri.file(scopePath)`. The handler SHALL NOT shape the include glob based on user input. Errors SHALL be caught and returned as `error: { code, message }` rather than thrown.

#### Scenario: Truncation reported

- **WHEN** `findFiles` returns exactly `maxResults` items
- **THEN** the response SHALL set `truncated: true`; otherwise `truncated: false`

### Requirement: Scope path validation

The system SHALL respond with `error: { code: 'OUT_OF_WORKSPACE', message: <human text> }` if `scopePath` is not inside any `vscode.workspace.workspaceFolders[i].uri.fsPath`. Symlinks resolved outside the workspace SHALL be treated as out-of-workspace.

### Requirement: Cancellation and token lifecycle

The system SHALL maintain at most ONE in-flight search enumeration at a time per webview. When a new `RequestFileTreeSearch` arrives, the previous request's `CancellationTokenSource` SHALL be cancelled AND the previous response (if still pending) SHALL be discarded WITHOUT posting back to the webview. Every `CancellationTokenSource` created by the handler SHALL be disposed in a `finally` block whether the request completed, was cancelled, or threw.

### Requirement: Stale rootGeneration handling at request entry AND post-findFiles

The system SHALL respond with `error: { code: 'STALE_ROOT', message: <human text> }` when the request's `rootGeneration` does not match the host-side current value at request entry. ADDITIONALLY, after `findFiles` returns, the handler SHALL re-check `rootGeneration` — if it has changed during the enumeration, the response SHALL be discarded (NOT posted back) because the webview already invalidated its cache on the `WorkspaceRootChanged` message.

### Requirement: RequestSubscribeFsChanges message type

The system SHALL define `RequestSubscribeFsChangesMessage` in `src/types/messages.ts` as a webview → extension discriminated-union member with shape:

```ts
{ type: 'request-subscribe-fs-changes'; rootGeneration: number; path: string }
```

`path` SHALL be an absolute filesystem path. The message SHALL be fire-and-forget (no `requestId`, no response).

### Requirement: RequestUnsubscribeFsChanges message type

The system SHALL define `RequestUnsubscribeFsChangesMessage` in `src/types/messages.ts` as a webview → extension discriminated-union member with shape:

```ts
{ type: 'request-unsubscribe-fs-changes'; rootGeneration: number; paths: string[] }
```

`paths` SHALL contain one or more absolute paths (bulk to support cheap `evictSubtree` payloads). The host SHALL silently drop unknown paths (idempotent unsubscribe).

### Requirement: FsChangesInvalidated message type

The system SHALL define `FsChangesInvalidatedMessage` in `src/types/messages.ts` as an extension → webview discriminated-union member with shape:

```ts
{ type: 'fs-changes-invalidated'; rootGeneration: number; parent: string }
```

`parent` SHALL be the absolute path of the watched directory whose contents changed. The payload SHALL NOT include the individual created/deleted file paths — the webview re-reads the directory via the existing `request-read-directory` RPC.

### Requirement: FsRehydrate message type

The system SHALL define `FsRehydrateMessage` in `src/types/messages.ts` as an extension → webview discriminated-union member with shape:

```ts
{ type: 'fs-rehydrate'; rootGeneration: number }
```

It SHALL carry no payload beyond the generation. The webview interprets it as "refresh every currently-cached directory."

### Requirement: Extension-host subscribe handler

The system SHALL handle `RequestSubscribeFsChangesMessage` in the extension host by validating `rootGeneration` (drop on mismatch — no error response), then calling `watcherPool.subscribe(path, onInvalidate)` where `onInvalidate` posts `FsChangesInvalidatedMessage` with the current `rootGeneration` and `parent = path` back to the webview via the host's `safePostMessage` shim. The returned `vscode.Disposable` SHALL be stored in a per-FileTreeHost `Map<path, Disposable>` keyed by absolute path. Re-subscribing the same path SHALL be a no-op (the existing entry stays).

### Requirement: Extension-host unsubscribe handler

The system SHALL handle `RequestUnsubscribeFsChangesMessage` in the extension host by validating `rootGeneration` (drop on mismatch), then for each `p` in `paths` calling `dispose()` on the matching entry in the per-host subscription map and deleting the entry. Unknown paths SHALL be no-ops (no warning log).

### Requirement: FileTreeHost rehydrate forwarding

The system SHALL subscribe `watcherPool.onDidRequestRehydrate` in `FileTreeHost.attach()` and post `FsRehydrateMessage` with the current `rootGeneration` to the webview on every fire (gated by `deps.isReady()`). The subscription SHALL be included in the cleanup `Disposable` returned by `attach()`.

### Requirement: FileTreeHost subscription cleanup on dispose

The cleanup `Disposable` returned by `FileTreeHost.attach()` SHALL dispose every entry in the per-host subscription map AND clear the map. This guarantees that webview disposal (sidebar collapsed, editor panel closed) releases all watcher refcounts the host owned, even if the webview did not send explicit unsubscribe messages first.

