## ADDED Requirements

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
