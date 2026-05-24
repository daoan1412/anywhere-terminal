## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: File system provider interface (webview side)

The system SHALL define an `IFileSystemProvider` interface in webview code with read-only methods `readDirectory(path: string): Promise<FileEntry[]>` and `stat(path: string): Promise<FileStat>`, AND with subscription-management methods `subscribeFsChanges(path: string): void` and `unsubscribeFsChanges(paths: string[]): void` (both fire-and-forget — the data source emits these as side effects of cache lifecycle, not as user actions). The interface SHALL be designed so that adding write methods (`rename`, `delete`, `create`) in a future change extends rather than replaces this interface.
