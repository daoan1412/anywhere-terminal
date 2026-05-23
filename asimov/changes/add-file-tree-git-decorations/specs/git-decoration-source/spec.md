## ADDED Requirements

### Requirement: Soft dependency on built-in git

The extension MUST NOT declare `vscode.git` as a hard `extensionDependencies` entry (VS Code refuses to activate a dependent extension when any listed dependency is disabled — would regress the existing "terminal works without git" guarantee). The `GitDecorationProvider`'s acquisition lifecycle (see § "Git API acquisition lifecycle") is the sole integration point; the extension MUST function (terminal, file tree, search) when the built-in git extension is disabled, uninstalled, or fails to activate.

### Requirement: Git API acquisition lifecycle

The `GitDecorationProvider` MUST handle the full activation lifecycle of the built-in git extension:

1. If `vscode.extensions.getExtension('vscode.git')` returns `undefined`, the provider MUST subscribe to `vscode.extensions.onDidChange` and retry acquisition on every change until the extension appears or the provider is disposed.
2. The provider MUST `await ext.activate()` and call `exports.getAPI(1)`.
3. If `gitExtension.enabled === false` (user set `git.enabled: false`), the provider MUST subscribe to `gitExtension.onDidChangeEnablement` and stay in no-op mode until enablement flips to `true`.
4. If `api.state === 'uninitialized'`, the provider MUST subscribe to `api.onDidChangeState` and defer repository registration until `state === 'initialized'`.
5. Any throw from `activate()` or `getAPI(1)` MUST be caught, logged once at WARN level, and result in permanent no-op (no further retries).
6. Every retry / state subscription MUST be disposed on the first successful acquisition AND on `provider.dispose()`.

### Requirement: Status enum and precedence (approximation)

The host MUST expose the status union type as:

```ts
type GitStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'ignored';
```

The status returned for a given path MUST be the highest-severity status among working-tree, index, and merge changes, applying the precedence: `conflicted > deleted > modified > renamed > added > untracked > ignored`. This is an **approximation** of VSCode's behavior: out-of-scope `Status` enum values from the git extension API (`TYPE_CHANGED`, `COPIED`, `INTENT_TO_ADD`, `INTENT_TO_RENAME`, submodule statuses) MUST map deterministically to the nearest of the seven values above (specifically: `TYPE_CHANGED → modified`, `COPIED → added`, `INTENT_TO_ADD → added`, `INTENT_TO_RENAME → renamed`, any submodule status → `modified`). Staged vs unstaged are not distinguished by color — the highest-severity rule above wins.

### Requirement: Per-repository status maps

The provider MUST maintain one internal status map per `Repository`, keyed by `repository.rootUri.fsPath`. For every `Repository` returned by `gitApi.repositories` and for every repository emitted by `gitApi.onDidOpenRepository`, the provider MUST subscribe to `repository.state.onDidChange` and (re)build that repository's status map from the four change arrays (`workingTreeChanges`, `indexChanges`, `mergeChanges`, `untrackedChanges`).

When a repository is closed (`gitApi.onDidCloseRepository`), the provider MUST dispose its subscription AND drop the entire per-repo map by key. The provider MUST NOT use `absPath.startsWith(rootUri.fsPath)` to identify entries to remove — string-prefix matching would incorrectly delete entries belonging to sibling repositories with overlapping prefixes (e.g., `/work/repo-foo` when `/work/repo` closes).

### Requirement: Workspace-folder emission filter

Before emitting a delta to the webview, the provider MUST drop any change whose absolute path is not under at least one of the currently open `vscode.workspace.workspaceFolders` (path-boundary containment, NOT string-prefix — `/work/repo-foo/x` is NOT under `/work/repo`). When no workspace folder is open, the filter MUST be a no-op (lets every path through — the tree can re-root anywhere in terminal-adjacent mode). The intent is two-fold: (a) bound webview-side `pendingStatuses` growth so it cannot accumulate entries for auto-detected non-workspace repos (`git.autoRepositoryDetection`), and (b) keep the path-info leak envelope no wider than what the existing `request-read-directory` flow already exposes.

### Requirement: Revision counter

The provider MUST maintain a monotonic `revision: number` counter that increments by 1 on every status mutation (per emitted delta, not per individual path). `getStatus(absPath)` MUST return `{ status: GitStatus | undefined, revision: number }` where `revision` is the revision at which `status` was last set for that path (or the current global revision if the path has never been decorated). `currentRevision()` MUST return the current global revision. Snapshots assembled by the host (see § "Status snapshot on directory read") and delta emissions (see § "Incremental change message") MUST stamp every entry with its corresponding revision.

### Requirement: Status snapshot on directory read

When the host answers a `request-read-directory` RPC, each `FileEntry` in the response MUST carry the current `gitStatus` AND `gitRevision` values from `provider.getStatus(entry.path)`. `gitStatus` is omitted when undefined; `gitRevision` is always present (`= currentRevision()` when the path has no decoration). The lookup MUST use the entry's absolute path; relative-path comparison is forbidden because it breaks for symlinks and multi-root workspaces.

### Requirement: Incremental change message

The host MUST emit a `GitStatusChanged` message to the webview after a debounce of 100 ms following the last `onDidChange` event. The message payload MUST be:

```ts
interface GitStatusChangedMessage {
  type: 'git-status-changed';
  rootGeneration: number;
  revision: number;
  changes: ReadonlyArray<{ path: string; status: GitStatus | null }>;
}
```

where `path` is absolute; `status: null` means "no longer decorated" (file became clean / status entry removed); `revision` is the provider's revision at the moment the batch was emitted (all changes in one batch share one revision). The `changes` array MUST be the **delta** since the last emitted message — unchanged paths are not included.

#### Scenario: Multiple bursts coalesce into one message

- **WHEN** the git extension emits `onDidChange` three times within the 100 ms debounce window
- **THEN** the host emits exactly one `GitStatusChanged` message containing the merged delta after the window elapses, with the most recent status value per path

### Requirement: Workspace-root invalidation

Every `GitStatusChanged` message MUST carry the current `rootGeneration` from `WorkspaceRootManager`. When the workspace root changes, the host MUST clear its in-memory status map before emitting the next `WorkspaceRootChanged` so the webview never sees stale status from a previous root.

### Requirement: Disposal

The provider MUST expose a `dispose()` method that disposes all repository subscriptions and the `extensions.onDidChange` retry subscription. `dispose()` MUST be idempotent.
