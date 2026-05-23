## ADDED Requirements

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

The system SHALL define an `IFileSystemProvider` interface in webview code with read-only methods `readDirectory(path: string): Promise<FileEntry[]>` and `stat(path: string): Promise<FileStat>`. The interface SHALL be designed so that adding write methods (`rename`, `delete`, `create`, `watch`) in a future change extends rather than replaces this interface.

### Requirement: RPC correlation

The system SHALL correlate `RequestReadDirectory` to `ReadDirectoryResponse` by a webview-generated `requestId`. Pending requests SHALL be tracked in a map; on response, the matching pending promise resolves and is removed. Unmatched responses (unknown `requestId` OR mismatched `rootGeneration`) SHALL be logged and dropped without crashing.

### Requirement: Workspace root resolution

The system SHALL treat the first entry of `vscode.workspace.workspaceFolders` as the tree's root. If no workspace folder is open, the tree SHALL display an empty-state message; opening a workspace folder SHALL trigger a generation increment and a `WorkspaceRootChanged` message that the webview uses to refresh the tree.
