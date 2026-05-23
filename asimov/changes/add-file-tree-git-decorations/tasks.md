## 1. Shared types + manifest

- [x] 1_1 Add `GitStatus` union + extend `FileEntry` + add `GitStatusChangedMessage` (with revision)
  - **Deps**: none
  - **Refs**: specs/git-decoration-source/spec.md#requirement-status-enum-and-precedence-approximation; specs/git-decoration-source/spec.md#requirement-incremental-change-message; specs/file-tree-git-decorations/spec.md#requirement-fileentry-carries-gitstatus-and-gitrevision; design.md D8, D10
  - **Scope**: `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: `GitStatus` exported, `FileEntry.gitStatus?: GitStatus` and `FileEntry.gitRevision?: number` fields present, `GitStatusChangedMessage` discriminated-union member present with `type: 'git-status-changed'`, `rootGeneration: number`, `revision: number`, `changes: ReadonlyArray<{ path: string; status: GitStatus | null }>`.
    - Verify: none — type-only addition
  - **Plan**:
    1. Insert `GitStatus` type near `FileEntry`, add `gitStatus?` + `gitRevision?` fields, add new message variant to the host-to-webview union, run `pnpm run check-types`.

- [x] 1_2 Declare `extensionDependencies: ['vscode.git']` in `package.json`
  - **Deps**: none
  - **Refs**: specs/git-decoration-source/spec.md#requirement-extension-dependency-on-built-in-git; design.md D1
  - **Scope**: `package.json`
  - **Acceptance**:
    - Outcome: `package.json` contains `"extensionDependencies": ["vscode.git"]`; `pnpm run check-types` and `pnpm run lint` still pass.
    - Verify: none — manifest change verified by type/lint pass
  - **Plan**:
    1. Add the `extensionDependencies` array next to `activationEvents`; re-run lint + check-types.

## 2. Extension host — GitDecorationProvider

- [x] 2_1 Implement `GitDecorationProvider` (lifecycle, per-repo maps, revision counter, status precedence)
  - **Deps**: 1_1, 1_2
  - **Refs**: specs/git-decoration-source/spec.md#requirement-git-api-acquisition-lifecycle; specs/git-decoration-source/spec.md#requirement-per-repository-status-maps; specs/git-decoration-source/spec.md#requirement-revision-counter; specs/git-decoration-source/spec.md#requirement-status-enum-and-precedence-approximation; specs/git-decoration-source/spec.md#requirement-disposal; design.md D1, D2, D9, D10, D12; docs/research/20260523-vscode-git-decorations.md
  - **Scope**: `src/providers/gitDecorationProvider.ts` (new), `src/providers/git.d.ts` (new — copy of the public surface from vscode/extensions/git/src/api/git.d.ts, license header preserved), `src/providers/gitStatusMapping.ts` (new — pure status enum → GitStatus mapper)
  - **Acceptance**:
    - Outcome: `createGitDecorationProvider({ rootGenerationProvider, logger })` returns `{ getStatus, currentRevision, onDidChange, reset, dispose }`. Lifecycle handles all five cases from D9 (absent / not-activated / disabled / uninitialized / permanent-failure). Per-repo internal status maps are keyed by `repository.rootUri.fsPath`; `onDidCloseRepository` drops the whole sub-map (no `startsWith` walk). `getStatus(path)` returns `{ status, revision }` reflecting the merged view across all open repos. The global `revision` counter increments on every status mutation; both `getStatus.revision` and emitted deltas reflect this. The pure status mapper handles `TYPE_CHANGED / COPIED / INTENT_TO_ADD / INTENT_TO_RENAME / submodule` per spec.
    - Verify: unit src/providers/gitDecorationProvider.test.ts
  - **Plan**:
    1. Add `src/providers/git.d.ts` — type stubs for `GitExtension`, `API`, `Repository`, `Change`, `Status`, `APIState` (just the public surface we use). License header per repo policy.
    2. Add `src/providers/gitStatusMapping.ts` — pure function `mapStatus(s: Status): GitStatus` with table from the spec. Exhaustive unit test covering every `Status` enum value.
    3. Implement `acquireApi()` covering the five lifecycle cases: (a) absent → subscribe to `extensions.onDidChange` + retry; (b) `await ext.activate()`; (c) `enabled === false` → subscribe to `onDidChangeEnablement` + wait; (d) `api.state === 'uninitialized'` → subscribe to `onDidChangeState` + wait for `'initialized'`; (e) throws → log once, no-op forever. Dispose retry subscriptions on first success.
    4. On API ready, register listeners on `gitApi.repositories`, `gitApi.onDidOpenRepository`, `gitApi.onDidCloseRepository`. Maintain `repoMaps: Map<string, Map<string, GitStatus>>` keyed by `rootUri.fsPath`.
    5. Per-repo subscription on `state.onDidChange`: rebuild that repo's map from the four change arrays + apply precedence + diff against previous + emit delta. Bump `revision`. Emit delta as `{revision, changes}`.
    6. `onDidCloseRepository`: drop `repoMaps.get(rootUri.fsPath)` whole entry; emit delta with all paths from that map set to `null`; bump `revision`.
    7. Implement `reset()` (drop all repo maps + emit delta clearing all previously-decorated paths, bump revision), `dispose()` (dispose all subscriptions; idempotent).

- [x] 2_2 Add 100 ms debounce wrapper around `onDidChange` emission
  - **Deps**: 2_1
  - **Refs**: specs/git-decoration-source/spec.md#requirement-incremental-change-message; design.md D4, D10
  - **Scope**: `src/providers/gitDecorationProvider.ts`, `src/providers/gitDecorationProvider.test.ts`
  - **Acceptance**:
    - Outcome: Three back-to-back internal updates within 100 ms emit exactly one `onDidChange` event whose payload is the merged delta (most-recent status per path) with the revision at flush time. Each flush emits a single revision shared by all changes in the batch. Test uses fake timers.
    - Verify: unit src/providers/gitDecorationProvider.test.ts
  - **Plan**:
    1. Wrap the internal emit in a coalescer keyed by `absPath` — accumulate into a pending map, schedule `setTimeout(flush, 100)` only when not already scheduled. On flush: bump `revision` once, emit `{revision, changes: [...]}` to listeners. Add fake-timer test with multi-burst coalescing + revision monotonicity assertions.

## 3. Wire provider into FileTreeHost

- [x] 3_1 Inject `GitDecorationProvider` into `FileTreeHost` and attach `gitStatus + gitRevision` on directory reads
  - **Deps**: 2_1
  - **Refs**: specs/git-decoration-source/spec.md#requirement-status-snapshot-on-directory-read; specs/file-tree-git-decorations/spec.md#requirement-migrate-is-ignored-styling; design.md D3, D7, D10
  - **Scope**: `src/providers/fileTreeHost.ts`, `src/providers/fileTreeRpcHandler.ts`, `src/providers/fileTreeHost.test.ts`
  - **Acceptance**:
    - Outcome: `request-read-directory` response contains `gitStatus` (when present) and `gitRevision` (always) on every entry. `gitRevision` comes from `provider.getStatus(entry.path).revision`. When `ignored: true` AND no higher-severity status, the response carries `gitStatus: 'ignored'` (replacing the previous `is-ignored` style as the canonical signal).
    - Verify: unit src/providers/fileTreeHost.test.ts
  - **Plan**:
    1. Add `gitDecorationProvider` as a constructor/factory dep on `FileTreeHost`.
    2. In `fileTreeRpcHandler.ts`, after gathering entries + ignored flags, call `const {status, revision} = provider.getStatus(entry.path)`; assign `entry.gitStatus = status ?? (entry.ignored ? 'ignored' : undefined)` and `entry.gitRevision = revision`.
    3. Add test cases: entry with modified status (revision propagated), entry both modified+ignored (modified wins), entry only ignored (gitStatus = 'ignored'), revision is monotonic across two reads with an intervening delta.

- [x] 3_2 Forward provider deltas to the webview as `GitStatusChanged` messages
  - **Deps**: 2_2, 3_1
  - **Refs**: specs/git-decoration-source/spec.md#requirement-incremental-change-message; specs/git-decoration-source/spec.md#requirement-workspace-root-invalidation; design.md D3, D10
  - **Scope**: `src/providers/fileTreeHost.ts`, `src/providers/fileTreeHost.test.ts`
  - **Acceptance**:
    - Outcome: `FileTreeHost` subscribes to `provider.onDidChange` and posts a `GitStatusChangedMessage` with the current `rootGeneration` and the delta's `revision`. On `WorkspaceRootChanged`, host calls `provider.reset()` before/with the root-changed broadcast so the next emitted delta carries a fresh revision and clears previously-decorated paths.
    - Verify: unit src/providers/fileTreeHost.test.ts
  - **Plan**:
    1. In `FileTreeHost.attach`, hook `provider.onDidChange` to `webview.postMessage({type: 'git-status-changed', rootGeneration, revision, changes})`.
    2. In the existing workspace-root-change handler, call `provider.reset()` before incrementing the generation.
    3. Test: assert one post per delta with correct revision; assert reset is called on root change; assert post-reset deltas carry strictly-greater revisions.

- [x] 3_3 Wire `GitDecorationProvider` into extension activation
  - **Deps**: 3_2
  - **Refs**: specs/git-decoration-source/spec.md#requirement-disposal; design.md D9
  - **Scope**: `src/extension.ts`, `src/providers/TerminalViewProvider.ts`
  - **Acceptance**:
    - Outcome: On `activate()`, a `GitDecorationProvider` is created and registered with the extension's disposable list, then passed into every `FileTreeHost` instance. On `deactivate()`, provider is disposed exactly once.
    - Verify: manual launch extension in Extension Development Host; open a git workspace; modify a file; observe IPC trace shows git-status-changed
  - **Plan**:
    1. Create provider in `activate()`, pass through `TerminalViewProvider` constructor down to where `FileTreeHost` is constructed. Push the provider into `context.subscriptions`.

## 4. Webview — FileNode + FileSystemDataSource

- [x] 4_1 Extend `FileNode` + introduce `applyStatusTransition` + route snapshot through it
  - **Deps**: 1_1
  - **Refs**: specs/file-tree-git-decorations/spec.md#requirement-filenode-caches-gitstatus-and-is-mutated-via-a-single-transition-function; specs/file-tree-git-decorations/spec.md#requirement-parent-folder-propagation; design.md D5, D6, D10, D11
  - **Scope**: `src/webview/fileTree/IFileSystemProvider.ts`, `src/webview/fileTree/FileSystemDataSource.ts`, `src/webview/fileTree/FileSystemDataSource.test.ts`
  - **Acceptance**:
    - Outcome: `FileNode` has `gitStatus?: GitStatus` and (folders only) `dirtyDescendantCount?: number`. `FileSystemDataSource` has a private `applyStatusTransition(node, next, revision)` function — the **only** writer of `gitStatus` and the **only** mutator of `dirtyDescendantCount`. The function implements D11 exactly: revision-guarded apply + dirty-transition refcount walk excluding `ignored` and `deleted`. Directory-snapshot application calls `applyStatusTransition(node, entry.gitStatus, entry.gitRevision)` per entry — never direct assignment.
    - Verify: unit src/webview/fileTree/FileSystemDataSource.test.ts
  - **Plan**:
    1. Add fields to `IFileSystemProvider.ts` (`gitStatus`, `dirtyDescendantCount`).
    2. Add `revisionByPath: Map<string, number>` field on `FileSystemDataSource`.
    3. Implement private `applyStatusTransition(node, next, revision)` per D11. Implement `isDirtyForPropagation` predicate (`modified|added|renamed|untracked|conflicted` only).
    4. Refactor `applyEntries` (or equivalent) to call `applyStatusTransition` per entry instead of direct assignment. Direct assignment of `gitStatus` is forbidden from this task onward.
    5. Tests: snapshot transition increments ancestor counters; deleted status does NOT propagate; ignored does NOT propagate; revision-older snapshot does not clobber a fresh delta; symmetric snapshot-then-clear returns counters to 0.

- [x] 4_2 Implement `applyGitStatusDelta` + pending-status map with revision tracking
  - **Deps**: 4_1
  - **Refs**: specs/file-tree-git-decorations/spec.md#requirement-pending-status-for-late-arriving-directories; specs/git-decoration-source/spec.md#requirement-incremental-change-message; design.md D10, D11
  - **Scope**: `src/webview/fileTree/FileSystemDataSource.ts`, `src/webview/fileTree/FileSystemDataSource.test.ts`
  - **Acceptance**:
    - Outcome: `applyGitStatusDelta(revision, changes)` routes every `{path, status}` through `applyStatusTransition` (defined in 4_1). Paths with no cached node are stored in `pendingStatuses: Map<string, { status: GitStatus|null; revision: number }>`. On node insert, matching pending entries are drained via `applyStatusTransition`. Pending entries are dropped when a subsequent delta sets `status: null` for the same path. The pending map clears on `WorkspaceRootChanged`. A snapshot-then-stale-delta scenario does NOT clobber the snapshot (revision guard rejects). A stale-snapshot-after-fresh-delta scenario does NOT clobber the delta (revision guard rejects).
    - Verify: unit src/webview/fileTree/FileSystemDataSource.test.ts
  - **Plan**:
    1. Add `pendingStatuses: Map<string, { status: GitStatus|null; revision: number }>` field; clear in `handleWorkspaceRootChanged`.
    2. Implement `applyGitStatusDelta(revision, changes)`: for each entry, find node; if missing → store in pending; else call `applyStatusTransition(node, status ?? undefined, revision)`. If `status === null` AND the path is in pending → also delete from pending (cleanup).
    3. Hook node insertion: on `FileNode` insert, look up `pendingStatuses.get(absPath)`; if found, call `applyStatusTransition(node, pending.status ?? undefined, pending.revision)` then delete from pending.
    4. Tests: (a) single modify delta; (b) modify→clean (refcount returns to 0); (c) nested 3-deep modify (3 ancestors increment); (d) pending-status-then-insert; (e) snapshot-revision-5-then-delta-revision-3 keeps the snapshot; (f) delta-revision-5-then-snapshot-revision-3 keeps the delta (snapshot rejected); (g) root-change clears pending; (h) null-delta clears pending; (i) deleted status does NOT increment parent; (j) ignored does NOT increment parent.

- [x] 4_3 Route `GitStatusChanged` messages through `MessageRouter` to `FileSystemDataSource`
  - **Deps**: 4_2
  - **Refs**: specs/git-decoration-source/spec.md#requirement-incremental-change-message
  - **Scope**: `src/webview/fileTree/FileTreeController.ts`, `src/webview/messaging/MessageRouter.ts` (if a handler-registration table is used), `src/webview/fileTree/FileTreeController.test.ts` (create if needed)
  - **Acceptance**:
    - Outcome: A `git-status-changed` message with the current `rootGeneration` invokes `dataSource.applyGitStatusDelta(msg.revision, msg.changes)`. A message with a stale `rootGeneration` is dropped (logged at DEBUG only).
    - Verify: unit src/webview/fileTree/FileTreeController.test.ts (or extend the closest existing controller test)
  - **Plan**:
    1. Add a handler for `git-status-changed` in the controller; gate on `msg.rootGeneration === currentRootGeneration` (same gate the existing handlers use); pass `msg.revision` through to `applyGitStatusDelta`.
    2. Test: deliver an in-generation message → applyDelta called with the right revision; deliver a stale one → not called.

## 5. Webview — renderer + CSS

- [x] 5_1 Extend `ReadOnlyFileRenderer` with `git-*` row class + badge span + search-row cache lookup
  - **Deps**: 4_1
  - **Refs**: specs/file-tree-git-decorations/spec.md#requirement-row-css-class-mapping; specs/file-tree-git-decorations/spec.md#requirement-badge-letter; specs/file-tree-git-decorations/spec.md#requirement-migrate-is-ignored-styling; specs/file-tree-git-decorations/spec.md#requirement-flat-list-search-mode-honors-decorations-via-cache-lookup; design.md D13
  - **Scope**: `src/webview/fileTree/ReadOnlyFileRenderer.ts`, `src/webview/fileTree/ReadOnlyFileRenderer.test.ts`, `src/webview/fileTree/FileSystemDataSource.ts` (add `getCachedNode(absPath)` accessor if missing)
  - **Acceptance**:
    - Outcome: In `renderTemplate`, a `<span class="git-badge">` is created once. In `renderElement`, the row receives exactly one `git-{status}` class (existing `git-*` classes removed first) and the badge span's `textContent` + `is-visible` class is set per the mapping table. Folders with `dirtyDescendantCount > 0` get `git-folder-dirty` + badge `•`. Search-row mode looks up `dataSource.getCachedNode(absolutePath)?.gitStatus` and applies per-file class + badge; folder-dirty propagation is skipped in flat-list mode. `.is-ignored` is no longer applied anywhere.
    - Verify: unit src/webview/fileTree/ReadOnlyFileRenderer.test.ts
  - **Plan**:
    1. Add `gitBadge` element to the template.
    2. In `renderElement`, compute target classes from `node.gitStatus` + (folder + dirtyDescendantCount > 0); update `row.classList` using a small `applyGitClass(row, status)` helper that strips all `git-*` first.
    3. Set `gitBadge.textContent` from the badge table; toggle `is-visible`.
    4. Delete the `.is-ignored` class toggle (line ~138).
    5. For search rows: pass the data source (or a small accessor closure) into the renderer; look up `getCachedNode(result.absolutePath)?.gitStatus` and apply the same class/badge mapping. No badge for uncached paths.
    6. Test each status → expected class + badge; test folder dirty → `•` badge; test status clears → no `git-*` class; test flat-list cached row → correct class; test flat-list uncached row → no `git-*` class.

- [x] 5_2 Update CSS — git color variables + badge layout, remove `.is-ignored`
  - **Deps**: 5_1
  - **Refs**: specs/file-tree-git-decorations/spec.md#requirement-color-via-css-variables; specs/file-tree-git-decorations/spec.md#requirement-migrate-is-ignored-styling
  - **Scope**: `src/webview/fileTree/fileTreePanel.css`
  - **Acceptance**:
    - Outcome: One CSS rule per `.git-*` class binding `color` to the matching `--vscode-gitDecoration-*ResourceForeground` variable. `.git-deleted` adds `text-decoration: line-through`. `.git-badge` is positioned right-aligned, has `is-visible` toggle, narrow fixed width. Old `.is-ignored` block removed.
    - Verify: manual open extension dev host with a workspace containing modified/added/deleted/untracked files; visually compare to built-in Explorer
  - **Plan**:
    1. Delete `.is-ignored` rules (lines ~30-38).
    2. Add the seven `.git-*` rules + `.git-folder-dirty` + `.git-badge` rules.
    3. Sanity-check in dev host with light + dark theme.

## 6. Tests and integration

- [x] 6_1 Integration test — full IPC round-trip with simulated git deltas (race + multi-root + lifecycle)
  - **Deps**: 3_2, 4_3, 5_1
  - **Refs**: specs/git-decoration-source/spec.md#requirement-incremental-change-message; specs/git-decoration-source/spec.md#requirement-per-repository-status-maps; specs/git-decoration-source/spec.md#requirement-git-api-acquisition-lifecycle; specs/file-tree-git-decorations/spec.md#requirement-pending-status-for-late-arriving-directories; design.md D10, D12
  - **Scope**: `src/test/fileTreeGitDecorations.integration.test.ts` (new) — or extend `src/test/fileTreeRpc.integration.test.ts` if conventions favor that
  - **Acceptance**:
    - Outcome: A test driver constructs a `FileTreeHost` with a stubbed `GitDecorationProvider`, performs a `request-read-directory`, then fires a synthetic delta and asserts the webview side's `FileSystemDataSource` ends up with the expected `gitStatus` per node and parent `dirtyDescendantCount`. Covers race + multi-root + lifecycle.
    - Verify: integration src/test/fileTreeGitDecorations.integration.test.ts
  - **Plan**:
    1. Reuse existing test scaffolding for the IPC pair; substitute a fake `GitDecorationProvider` that lets the test push deltas with controlled revisions.
    2. Cases: (a) snapshot-with-status; (b) delta-clear-status; (c) pending-then-insert; (d) workspace-root-change clears pending + status; (e) **race**: snapshot revision 1 in flight, delta revision 2 arrives first, then snapshot revision 1 arrives — final state matches delta; (f) **multi-root**: two repos `/work/repo` and `/work/repo-foo` with overlapping prefixes — closing `/work/repo` does NOT clear entries under `/work/repo-foo`; (g) **lifecycle**: provider starts in no-op (extension disabled), enablement flips to true mid-test, status updates begin flowing; (h) **submodule mapping**: a status from the mapper's "other" buckets (TYPE_CHANGED) lands as `modified` on the webview row.

## 7. Verification + cleanup

- [x] 7_1 Run full verification suite + measure bundle delta
  - **Deps**: 5_2, 6_1
  - **Refs**: design.md (Risk Map — bundle row)
  - **Scope**: _(none — verification only)_
  - **Acceptance**:
    - Outcome: `pnpm run check-types` passes; `pnpm run lint` passes; `pnpm run test:unit` passes; built bundle size grew by < 5 KB gzip compared to `main`.
    - Verify: manual run each command; record sizes in workflow.md Notes
  - **Plan**:
    1. Run check-types, lint, unit. Build extension. Diff bundle size against `git stash; pnpm run build` of HEAD.

- [ ] 7_2 Manual QA in Extension Development Host
  - **Deps**: 7_1
  - **Refs**: proposal.md § UI Impact
  - **Scope**: _(none — verification only)_
  - **Acceptance**:
    - Outcome: In a real git workspace, modify a tracked file → see `M` badge + tint within ~100 ms. Add a new file → `U` badge. `git add` it → `A` badge. `rm` a tracked file → `D` badge + strike-through. Delete a folder containing modifications → parent shows `•` until the folder is itself deleted. Disable the built-in git extension → tree behaves as before (no errors). Switch themes (light ↔ dark) → colors change automatically.
    - Verify: manual run extension in dev host with a real git repo; exercise each status; switch themes; toggle git extension
  - **Plan**:
    1. Launch dev host. Open a known repo. Make each kind of change, capture screenshots if convenient. Record results in workflow.md Revision Log.
