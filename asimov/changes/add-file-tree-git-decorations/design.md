# Design: add-file-tree-git-decorations

## Architecture

```
┌──────────────────────────── Extension Host ────────────────────────────┐
│                                                                        │
│  vscode.extensions.getExtension('vscode.git')                          │
│    .activate() → .exports.getAPI(1) ─────────┐                         │
│                                              │                         │
│  ┌────────────────────────────────┐          │                         │
│  │  GitDecorationProvider         │ ◀────────┘                         │
│  │  - api: GitAPI                 │                                    │
│  │  - status: Map<absPath, GS>    │   per-repo onDidChange             │
│  │  - debounce: 100 ms timer      │ ◀────── Repository.state           │
│  │  - rootGeneration              │                                    │
│  └──────────────┬─────────────────┘                                    │
│                 │ emit delta + snapshot                                │
│                 ▼                                                      │
│  ┌────────────────────────────────┐                                    │
│  │  FileTreeHost                  │                                    │
│  │  - attaches gitStatus to       │                                    │
│  │    FileEntry on read-dir       │                                    │
│  │  - forwards GitStatusChanged   │                                    │
│  └──────────────┬─────────────────┘                                    │
└─────────────────┼──────────────────────────────────────────────────────┘
                  │ postMessage (host → webview)
                  ▼
┌──────────────────────────── Webview ───────────────────────────────────┐
│                                                                        │
│  MessageRouter                                                         │
│    ├─ read-directory-response  → FileSystemDataSource.applySnapshot()  │
│    └─ git-status-changed       → FileSystemDataSource.applyDelta()     │
│                                                                        │
│  FileSystemDataSource                                                  │
│    - cache: Map<absPath, FileNode>                                     │
│    - pendingStatuses: Map<absPath, GitStatus|null>                     │
│    - applyDelta() → walk ancestors for dirty refcount → fire repaint   │
│                                                                        │
│  Tree → ReadOnlyFileRenderer                                           │
│    - row.className += git-{status}                                     │
│    - badge.textContent = {M,A,D,R,U,C,•}                               │
│    - CSS uses --vscode-gitDecoration-*ResourceForeground               │
└────────────────────────────────────────────────────────────────────────┘
```

## Decisions

### D1: Consume the built-in `vscode.git` extension API rather than shell-out

Use `vscode.extensions.getExtension('vscode.git').activate().getAPI(1)`. This eliminates ~3× the code we'd need for a porcelain parser, dotgit watcher, multi-root resolver, and submodule discovery. The git extension already coalesces updates and handles all the edge cases (worktrees, submodules, sparse checkouts). `extensionDependencies: ['vscode.git']` ensures ordering. Rejected: porcelain shell-out (more code, slower cold start, double the test surface); hybrid (the fallback only matters for users who explicitly disabled the built-in git extension — those users already accept "no git features").

### D2: Status precedence — single highest-severity status per path (approximation)

A given file can appear in multiple change arrays (indexed AND working-tree modified). Render the worst one. Precedence: `conflicted > deleted > modified > renamed > added > untracked > ignored`. This is an **approximation** of VSCode's behavior, not a 1:1 reproduction. Explicitly out of scope for v1: distinct staged-vs-unstaged colors, `TYPE_CHANGED`, `COPIED`, `INTENT_TO_ADD/RENAME`, and submodule-specific badges (covered by `Status` enum values in `extensions/git/src/api/git.d.ts` but treated by our mapper as the nearest of the seven above — e.g., `TYPE_CHANGED` → `modified`). Acceptable for v1 because the seven covered statuses make up >99 % of real-world file states; full parity can be a follow-up.

### D3: Initial snapshot via `request-read-directory` response, deltas via push message

Two complementary channels: when the webview asks for a directory, attach the current `gitStatus` per entry — no extra round-trip, no flash of un-decorated content. After that, push incremental deltas via a new `GitStatusChanged` message. Rejected: webview-pulls model (requires a new RPC and round-trip on every change — wasteful). Rejected: pure push on directory load (introduces a race: directory rendered before initial status arrives).

### D4: Debounce window of 100 ms

Match the existing auto-reveal debounce in this codebase (single shared cadence). Long enough to coalesce typical multi-file operations (branch switch, `git pull`). Short enough that the user perceives the update as instant. The git extension already debounces its own emissions; our 100 ms is a second-level batcher for the cross-boundary IPC channel.

### D5: Parent dirty propagation via per-folder refcount, not subtree scan

Each folder `FileNode` carries `dirtyDescendantCount: number`. On each status delta, walk **only the ancestor chain** of the affected path (O(depth), depth ≤ ~20 in practice), incrementing/decrementing the counter. A folder is dirty iff `count > 0`. Rejected: VSCode-style ternary-search-tree (overkill for our scale — we already have a complete `FileNode` cache keyed by path); rejected: scan-on-demand subtree walk (O(folder size) per render, repeated for every render of a collapsed folder).

### D6: Neither `ignored` nor `deleted` propagates to parent folders

Match VSCode: `ignored` files do not mark their parent folders dirty, and **neither do `deleted` files** (VSCode sets `propagate: false` on deletions — see `extensions/git/src/repository.ts:306-310`). Rationale: a deleted file no longer "lives" inside the folder, so propagating its dirtiness would mislead. The refcount excludes both `ignored` and `deleted` from the increment. All other non-undefined statuses (modified / added / renamed / untracked / conflicted) propagate.

### D7: Migrate `.is-ignored` styling, keep `.is-ignored` detection

The `gitIgnoreChecker` shell-out stays as the source of "is this file `.gitignore`'d?". The host attaches `gitStatus: 'ignored'` to the `FileEntry` when `ignored: true` AND no higher-severity status exists (e.g., a file matched by `.gitignore` but force-added is treated as `modified`/`added`, not `ignored`). The `.is-ignored` CSS rule is removed in favor of `.git-ignored`. Single source of truth for the "ignored" appearance.

### D8: Single shared `GitStatus` type

Defined once in `src/types/messages.ts` (alongside `FileEntry`), imported by both host (`gitDecorationProvider.ts`) and webview (`IFileSystemProvider.ts`, `ReadOnlyFileRenderer.ts`). No duplication, no drift between sides of the IPC boundary.

### D9: Robust API lifecycle — handle absent, disabled, and uninitialized states

The acquisition flow has four distinct failure modes and one transient state, all handled explicitly:

1. **Extension absent** (`getExtension('vscode.git') === undefined`) — user uninstalled the built-in git extension. Subscribe to `vscode.extensions.onDidChange` and retry acquisition each time the extension set changes (cheap; fires rarely). Dispose the retry subscription on the first successful acquisition.
2. **Extension present but not activated** — `await ext.activate()` resolves to `GitExtension`. Proceed.
3. **Extension activated but `enabled === false`** (user set `git.enabled: false`) — subscribe to `gitExtension.onDidChangeEnablement` and operate in no-op mode until enablement flips true. Dispose subscription on first true.
4. **API present but `api.state === 'uninitialized'`** — subscribe to `api.onDidChangeState` and wait for `'initialized'` before registering repository listeners.
5. **Permanent failure modes** (extension throws on `activate`, `getAPI(1)` rejects) — log once at WARN, give up. No further retries (avoids log spam).

The retry/wait subscriptions are part of `dispose()` cleanup. No banner UI; matches the silent behavior of every other VSCode tree view when git is off. (Rejected the original "single-retry-via-onDidChange" simplification — too narrow; missed enablement and state-machine transitions.)

### D10: Per-path revision counter to defeat snapshot/delta ordering races

**Problem**: the host could read the status map at revision R, build a directory snapshot, then emit a delta at revision R+1, then post the snapshot response. The webview would apply the (newer) delta first, then the (older) snapshot — clobbering the fresh delta on overlapping paths.

**Fix**: every status mutation in `GitDecorationProvider` increments a global `revision: number` counter. The provider exposes `getStatus(path): { status: GitStatus|undefined; revision: number }`. Snapshots send `{gitStatus, gitRevision}` per entry. Deltas send `{path, status, revision}` per change (a single emission's revision is the same for all entries in the batch). The webview keeps `revisionByPath: Map<string, number>` and applies a status update only if `incoming.revision > stored.revision`. Snapshots and deltas pass through the **same** transition function (D11) — never assign `gitStatus` directly.

### D11: Single transition function — snapshot, delta, and pending all use the same path

All status changes (whether from initial snapshot, from a delta, or from a pending-status drain on node insert) route through one private webview function:

```ts
applyStatusTransition(node: FileNode, next: GitStatus | undefined, revision: number): void
//   - if revision <= revisionByPath.get(node.absPath) → no-op
//   - else: read prev = node.gitStatus; compute prevDirty/nextDirty per D6
//          ; update revisionByPath; assign node.gitStatus = next
//          ; if prevDirty !== nextDirty → walk ancestors and ±1 dirtyDescendantCount
```

This guarantees the refcount cannot drift across the three entry paths and is the only writer of `gitStatus` on a `FileNode`. (Rejected the original split where snapshot path directly assigned `gitStatus` — the oracle correctly identified that this bypasses the refcount machinery and would drift on initial loads.)

### D12: Repository-close removal uses path-boundary containment, not `startsWith`

A naive `absPath.startsWith(rootUri.fsPath)` would treat `/work/repo-foo/file` as inside `/work/repo` when `/work/repo` closes. The provider keeps a **per-repository** internal status map (`Map<repoRootKey, Map<absPath, GitStatus>>`) and exposes the merged view. On repo close, drop the entire per-repo sub-map by key. The global map is rebuilt from the union of remaining per-repo maps. This also makes multi-root + nested-repo cases trivially correct (each repo owns its own slice).

### D13: Search-row decoration via cache lookup

`FileTreeSearchResult` already carries `absolutePath`. The webview renderer for search rows looks up `dataSource.getCachedNode(absPath)?.gitStatus` and applies the same `git-*` class + badge. No new IPC field. Folder-dirty propagation is skipped (search results are file-only). If a result references a path with no cached node (it wasn't expanded), the row simply renders without a badge — acceptable for v1; revisit if users report the gap.

## Interfaces

### Shared type — `src/types/messages.ts`

```ts
export type GitStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'ignored';

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  ignored?: boolean;
  gitStatus?: GitStatus;     // ← new
}

export interface GitStatusChangedMessage {
  type: 'git-status-changed';
  rootGeneration: number;
  revision: number;
  changes: ReadonlyArray<{ path: string; status: GitStatus | null }>;
}

export interface FileEntry {
  // ... existing
  gitStatus?: GitStatus;
  gitRevision?: number;   // ← revision at which gitStatus was sampled
}
```

### Extension host — `src/providers/gitDecorationProvider.ts`

```ts
export interface GitDecorationProvider {
  /** Current status + revision for a path. status is undefined if not decorated. */
  getStatus(absPath: string): { status: GitStatus | undefined; revision: number };

  /** Subscribe to incremental deltas. The whole batch shares one revision. */
  onDidChange(
    listener: (delta: { revision: number; changes: ReadonlyArray<{ path: string; status: GitStatus | null }> }) => void
  ): vscode.Disposable;

  /** Reset all internal per-repo maps (called on WorkspaceRootChanged). Emits a delta clearing all decorated paths with a fresh revision. */
  reset(): void;

  /** Snapshot for use when assembling a directory response. Returns the current revision so the caller can stamp every entry. */
  currentRevision(): number;

  dispose(): void;
}

export function createGitDecorationProvider(opts: {
  rootGenerationProvider: () => number;
  logger: Logger;
}): GitDecorationProvider;
```

### Webview — `src/webview/fileTree/IFileSystemProvider.ts`

```ts
export interface FileNode {
  // existing fields...
  ignored?: boolean;
  gitStatus?: GitStatus;          // ← new
  dirtyDescendantCount?: number;  // ← new — folders only
}
```

### Webview — `FileSystemDataSource` additions (shape, not source)

```ts
applyGitStatusDelta(revision: number, changes: ReadonlyArray<{ path: string; status: GitStatus | null }>): void;
//   For each change:
//     - resolve node by absPath; if missing → store {status, revision} in pendingStatuses
//     - else → call applyStatusTransition(node, status, revision)

applyDirectorySnapshot(entries: FileEntry[]): void;
//   For each entry that carries gitStatus / gitRevision:
//     - resolve / create the FileNode
//     - call applyStatusTransition(node, entry.gitStatus, entry.gitRevision)
//   Then drain matching pendingStatuses entries.

// Private — the only writer of node.gitStatus.
applyStatusTransition(node: FileNode, next: GitStatus | undefined, revision: number): void;
//   Implements D10 + D11 exactly.

// On insert of a new node (folder load), drain pendingStatuses[node.absPath] if present.

// On null-status delta entries, also delete the path from pendingStatuses (cleanup — addresses
// oracle finding 7: prevents stale pending entries from accumulating).
```

## Design Constraints

- **`renderTemplate` reuse rule**: the badge `<span>` must be created once in `renderTemplate()` and only its `textContent` + classList toggled in `renderElement()`. Creating per render breaks the recycled-row contract that the vendored listWidget relies on (precedent: `is-ignored` handling at `ReadOnlyFileRenderer.ts:138`).
- **CSS variables only**: theme switching relies on `--vscode-gitDecoration-*` resolving live. No JS theme detection needed beyond what `theme-manager` already provides.
- **`rootGeneration` is mandatory** on every host-pushed message per the file-tree-rpc convention; stale messages are dropped client-side.
- **No new bundle deps** — pure runtime API consumption + ~150 LOC of new code; expected bundle delta < 5 KB.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `GitDecorationProvider` activation | `vscode.extensions.getExtension('vscode.git')` is `undefined` during host activation, especially on a cold extension host | `await ext.activate()`; if still missing subscribe once to `vscode.extensions.onDidChange` and retry; **see D9**. Covered by unit test asserting no-op when API is null. |
| Delta vs snapshot ordering | A `GitStatusChanged` delta arrives for a path whose containing directory hasn't loaded yet (e.g., file outside current expanded subtree gets modified) | `FileSystemDataSource.pendingStatuses` map; applied on next `FileNode` insert; cleared on `WorkspaceRootChanged`. **See spec § "Pending status for late-arriving directories"**. Covered by unit test. |
| Stale `rootGeneration` | Workspace root changes between snapshot and delta — webview applies status from old workspace to new file with same name | Every message carries `rootGeneration`; webview compares against current; mismatched messages are dropped (existing file-tree-rpc machinery). Host calls `provider.reset()` immediately on root change. |
| Parent propagation correctness | Refcount drifts (double-increment, missed-decrement) under burst deltas | Single-source increment: `applyGitStatusDelta` is the only mutator; before-after status comparison drives the +1 / -1 / 0 decision. Unit test with synthetic deltas asserts the count returns to 0 after symmetric add/remove. |
| Multi-root workspaces | Two repos with files at the same relative path — collision on key | All map keys are **absolute** paths (`uri.fsPath`); never relative; never workspace-relative. Validator: type system on `gitDecorationProvider.ts` (key is branded `AbsolutePath`). |
| Existing `.is-ignored` regression | Removing the CSS rule could break unrelated layouts that depend on it | Grep before delete; only `.is-ignored` consumer is the renderer itself (per Discovery). Update `ReadOnlyFileRenderer.test.ts` to assert `git-ignored` is applied instead. |
| Bundle size | Decoration code shipped to all webview instances | New webview code is < 100 LOC pure functions + CSS; budgeted < 5 KB gzip — measured in tasks `7_1`. |
| Performance on giant repos (>10 k files) | Initial snapshot attachment to `request-read-directory` runs a Map lookup per entry — O(n) | Map lookup is O(1); n ≤ visible-folder size (~few hundred typical). Worst case: 100 k entries × O(1) = sub-ms. No mitigation needed — but `applyDelta` ancestor walk is bounded by depth, not breadth, so it stays O(changes × depth). |
| User disabled built-in git extension | Provider gives up cleanly but no UI indicator | INFO log only; no banner. Acceptable: matches the silent behavior of every other VSCode tree view when git is off. **See D9**. |
| Snapshot/delta ordering | Older snapshot arrives after a fresher delta has been applied → clobbers fresh state on overlapping paths | Per-path revision counter (**D10**). Snapshot carries `gitRevision`; delta carries `revision`. Webview rejects any apply where `incoming.revision <= revisionByPath[path]`. Covered by unit test in task 4_2 (snapshot-vs-delta race scenario). |
| Refcount drift across entry points | Snapshot path bypassing the refcount walker would drift the dirty count | Single `applyStatusTransition` writer for all three entry points (snapshot / delta / pending drain) — **D11**. Refactored task 4_1 to use this function from day one. |
| Repo path-prefix collision | `/work/repo` closing would erase entries under `/work/repo-foo` if `startsWith` is used | Per-repository internal map keyed by `rootUri.fsPath` — **D12**. Repo-close drops the whole sub-map; no string-prefix walk needed. |
| `pendingStatuses` unbounded growth | Pending entries for paths the user never expands accumulate indefinitely | (a) Delete on `null` delta entries (status cleared); (b) drop entries whose path is under a closing repo's root; (c) clear on `WorkspaceRootChanged`. Documented in spec § "Pending status for late-arriving directories". |
| Status coverage drift | Real VSCode supports `TYPE_CHANGED`, `COPIED`, `INTENT_TO_ADD/RENAME`, staged vs unstaged distinct colors — we approximate | **D2** explicitly documents the approximation. Mapping table from `Status` enum to our 7-case union lives in `gitDecorationProvider.ts`; covered by exhaustive unit test on the mapper. |
