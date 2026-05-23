# file-tree-git-decorations Specification
## Requirements

### Requirement: FileEntry carries gitStatus and gitRevision

The `FileEntry` shape in `src/types/messages.ts` MUST gain two optional fields:

```ts
gitStatus?: GitStatus;
gitRevision?: number;
```

`gitStatus` is omitted (not `null`) when the file has no decorated status. `gitRevision` is always present whenever the host has a working provider (used by the webview to defeat snapshot/delta ordering races — every status apply on the webview side is guarded by revision comparison). The `GitStatus` type MUST be imported from a single shared location used by both host and webview.

### Requirement: FileNode caches gitStatus and is mutated via a single transition function

The webview `FileNode` interface in `src/webview/fileTree/IFileSystemProvider.ts` MUST add `gitStatus?: GitStatus`. Folder nodes MUST also expose `dirtyDescendantCount?: number`.

All writes to `FileNode.gitStatus` MUST go through a single private function `applyStatusTransition(node, next, revision)` on `FileSystemDataSource`. This function MUST be the only writer of `gitStatus` and the only mutator of `dirtyDescendantCount`. Direct field assignment from snapshot handling, delta handling, or pending-status draining is forbidden. The transition function MUST:

1. Compare `revision` against `revisionByPath.get(node.absPath)`; no-op if `revision <= stored`.
2. Read `prev = node.gitStatus`, compute `prevDirty = isDirtyForPropagation(prev)`, `nextDirty = isDirtyForPropagation(next)`.
3. Assign `node.gitStatus = next` and update `revisionByPath`.
4. If `prevDirty !== nextDirty`, walk ancestor folders and adjust `dirtyDescendantCount` by `+1` (clean→dirty) or `-1` (dirty→clean).
5. Emit a repaint for the node and any ancestor whose dirty count crossed zero.

`isDirtyForPropagation(status)` returns `true` for `modified | added | renamed | untracked | conflicted` and `false` for `undefined | deleted | ignored`.

### Requirement: Row CSS class mapping

`ReadOnlyFileRenderer.renderElement` MUST apply exactly one of the following classes to the row element based on the node's `gitStatus`, removing any previously applied `git-*` class:

| gitStatus | Class |
|---|---|
| `modified` | `git-modified` |
| `added` | `git-added` |
| `deleted` | `git-deleted` |
| `renamed` | `git-renamed` |
| `untracked` | `git-untracked` |
| `conflicted` | `git-conflicted` |
| `ignored` | `git-ignored` |
| `undefined` | _(no `git-*` class)_ |

### Requirement: Badge letter

For files (not folders), the renderer MUST render a single-letter badge in a `<span class="git-badge">` aligned to the right of the row, with text content:

| gitStatus | Badge |
|---|---|
| `modified` | `M` |
| `added` | `A` |
| `deleted` | `D` |
| `renamed` | `R` |
| `untracked` | `U` |
| `conflicted` | `C` |
| `ignored` | _(no badge — color tint only)_ |
| `undefined` | _(span absent)_ |

The badge span MUST be present in the row template (created in `renderTemplate`) and shown/hidden by setting `textContent` + a `is-visible` class — never created/destroyed per render, to honor the existing template-reuse pattern.

### Requirement: Color via CSS variables

The CSS in `fileTreePanel.css` MUST bind row foreground colors to:

| Class | CSS variable |
|---|---|
| `.git-modified` | `var(--vscode-gitDecoration-modifiedResourceForeground)` |
| `.git-added` | `var(--vscode-gitDecoration-addedResourceForeground)` |
| `.git-deleted` | `var(--vscode-gitDecoration-deletedResourceForeground)` (also `text-decoration: line-through`) |
| `.git-renamed` | `var(--vscode-gitDecoration-renamedResourceForeground)` |
| `.git-untracked` | `var(--vscode-gitDecoration-untrackedResourceForeground)` |
| `.git-conflicted` | `var(--vscode-gitDecoration-conflictingResourceForeground)` |
| `.git-ignored` | `var(--vscode-gitDecoration-ignoredResourceForeground)` |

Direct hex colors or `--vscode-list-*` overrides are forbidden — theme switching relies on these variables resolving live.

### Requirement: Parent folder propagation

Each folder `FileNode` MUST maintain `dirtyDescendantCount: number`. The single allowed mutator is `applyStatusTransition` (see § "FileNode caches gitStatus and is mutated via a single transition function"). A folder row MUST render a dirty indicator (badge `•` in the `git-badge` span, plus `git-folder-dirty` class on the row) when `dirtyDescendantCount > 0`. Neither `ignored` nor `deleted` status MUST propagate to ancestors (matches VSCode — `ignored` files don't dirty their parent; `deleted` files no longer "belong" to the folder and so don't dirty it either).

#### Scenario: Folder badge clears when last dirty descendant becomes clean

- **WHEN** the only modified file inside a previously-dirty folder transitions to `gitStatus: undefined`
- **THEN** the folder's `dirtyDescendantCount` reaches 0, the `git-folder-dirty` class is removed, and the badge span is hidden — without re-reading the directory

### Requirement: Pending status for late-arriving directories

When a `GitStatusChanged` delta references a path whose containing directory has not yet been loaded into the `FileSystemDataSource` cache, the data source MUST store an entry `{ status, revision }` in a `pendingStatuses: Map<string, { status: GitStatus | null; revision: number }>` keyed by absolute path. On the next insertion of a `FileNode` matching that path, the cached entry MUST be applied via `applyStatusTransition` and removed from the pending map.

To prevent unbounded growth, the data source MUST:
1. Drop the pending entry when a subsequent delta sets `status: null` for the same path (the status has cleared on the host — no decoration needed).
2. Clear the entire pending map on `WorkspaceRootChanged`.
3. Drop pending entries for paths that are descendants of a closed repository (when a future `RepositoryClosed`-style signal is available); for v1 this is implicit because the next host-side reset on root change handles it.

### Requirement: Migrate is-ignored styling

The existing CSS rules targeting `.is-ignored` in `fileTreePanel.css` MUST be removed. The webview MUST treat an `ignored` entry coming from `gitIgnoreChecker` as `gitStatus: 'ignored'` (the host attaches it during `request-read-directory` response assembly when the entry has `ignored: true` and no higher-severity git status). The `is-ignored` class MUST no longer be applied by `ReadOnlyFileRenderer`.

### Requirement: Flat-list / search mode honors decorations via cache lookup

When the tree is in flat-list mode (search results), each result row MUST apply the `git-*` class and badge by looking up `dataSource.getCachedNode(result.absolutePath)?.gitStatus`. No new IPC field is added to `FileTreeSearchResult` — the webview-side cache is the source. If the lookup returns no cached node (the path was never expanded), the row renders without a badge. Folder dirty propagation MUST be skipped in flat-list mode (search results are file-only) — the renderer treats results as files for badge purposes.

