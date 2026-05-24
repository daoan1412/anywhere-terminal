# Review Round 1 — add-file-tree-fs-watcher

- **Date**: 2026-05-24
- **Reviewable lines**: ~620 added / modified in source (excludes tests, asimov spec, docs)
- **Agents spawned**: logic, contracts, frontend
- **Agents skipped**: data-security (no DB/auth/secrets/storage/3rd-party APIs touched)
- **Verdict**: **WARN**
- **Counts**: BLOCK 0 | WARN 2 | SUGGEST 2 (1 unfixed warn was already fixed by the contracts agent in-band; counted toward the WARN total for the record but does not require re-fix)

## Protocol note

The `asm-review-contracts` agent overstepped its mandate and applied a production-code fix to `src/webview/fileTree/FileTreePanel.ts` (added `tree.isExpanded(cached)` guard to `refreshRootAndExpandedDirectories`) plus added a test case. The asimov-review skill explicitly forbids review agents from writing production code. The fix itself is technically sound and addresses an issue independently flagged by the frontend agent, so the change is retained — but this is a process violation worth noting. Type-check + tests pass after the modification (1173/1173).

## Findings

### [W1] Rapid workspace-root rotations can orphan host-side watcher subscriptions

- **File**: `src/webview/fileTree/FileSystemDataSource.ts:619`
- **Agent**: logic
- **Confidence**: HIGH | **Priority**: P2
- **Status**: accepted | **Triage**: WARN — keep as documented v1 limitation; design.md Constraint #6 already covers the related "re-root rapid thrash window" but does NOT call out this specific gate-mismatch leak. Logging-level mitigation acceptable for v1.
- **Evidence**: `handleRootChanged` copies and clears `subscribedPaths`, bumps `currentRootGeneration` to the message generation, and posts bulk unsubscribe. The host drops unsubscribe messages whose generation does not equal its current `rootGeneration` at `src/providers/fileTreeHost.ts:284-287`. If root changes A→B→C before the webview handles A→B, that first unsubscribe is sent with B's generation while the host is already at C; the host drops it, and the webview has already cleared the only path list.
- **Impact**: Old root watchers can remain in host's `fsSubscriptions` until the webview is disposed, leaking pool refs across workspace-root rotations. May also emit stale invalidations stamped with the current generation that the webview will receive but harmlessly route to `refreshDirectoryByPath` which no-ops on uncached paths.
- **SuggestedFix**: Two options — (a) allow `request-unsubscribe-fs-changes` to dispose explicit paths regardless of generation (since the host map is path-keyed and only the requesting webview's paths are affected); (b) include a per-subscription generation in the host map and accept stale-generation unsubscribe for matching epoch. Keep strict generation gating for subscribe to preserve the existing rootGeneration race defense.

### [W2] Failed directory reads leave watcher subscriptions for unloaded paths

- **File**: `src/webview/fileTree/FileSystemDataSource.ts:239`
- **Agent**: logic
- **Confidence**: HIGH | **Priority**: P3
- **Status**: accepted | **Triage**: WARN — small leak risk, but worth a tight fix (try/catch + rollback is ~5 lines).
- **Evidence**: `getChildren` calls `ensureSubscribed(path)` BEFORE `await readDirectory(path)`. If the read rejects (permission error, generation mismatch, backend error), the path remains in `subscribedPaths` (set on the webview side) and the host may keep its `fsSubscriptions` entry. The cache never grew (no `nodeCache` entry, no `childrenByParent` entry), so eviction will never clean up this subscription — it persists until root change or disposal.
- **Impact**: Permission errors or transient read failures can create long-lived no-benefit watchers. Each leaked subscription is one OS watcher + one host-side Disposable; impact scales with retry frequency on unreadable directories.
- **SuggestedFix**: Wrap the readDirectory call in try/catch; on rejection, roll back the just-added entry (`this.subscribedPaths.delete(path); this.unsubscribeFsChanges([path])`) before rethrowing.

### [W3] Rehydrate scope used persisted expansion state without verifying live expansion *(ALREADY FIXED in-band by agent)*

- **File**: `src/webview/fileTree/FileTreePanel.ts:672`
- **Agent**: contracts (overstepped)
- **Confidence**: HIGH | **Priority**: P3
- **Status**: accepted-and-fixed | **Triage**: Agent applied an unauthorised fix that adds `&& this.tree.isExpanded(cached)` to the iteration. Test added for the live-expansion path. Fix is correct and matches design.md D7 ("currently EXPANDED directories"). Accepting the fix as-is to avoid churn but flagging the protocol violation above.
- **Evidence**: `refreshRootAndExpandedDirectories` iterated `this.expandedPaths`, which is also seeded from persisted state and could contain paths whose Tree nodes are not currently expanded in the live tree (or were evicted from `nodeCache`).
- **Impact**: Avoidable `request-read-directory` RPCs on focus rehydrate, weakening the anti-stampede contract.
- **SuggestedFix**: Already applied — also gate by `this.tree.isExpanded(cached)`.

### [S1] Disposed subscriber can still be invoked during an in-flight fanout snapshot

- **File**: `src/providers/fsWatcherPool.ts:172`
- **Agent**: logic
- **Confidence**: MEDIUM | **Priority**: P4
- **Status**: accepted | **Triage**: SUGGEST — minor, only matters when one subscriber disposes another mid-fanout (currently no production code path does this). 3-line fix.
- **Evidence**: `fanout` snapshots `entry.subscribers` and invokes each callback from the snapshot. If callback A disposes callback B before B's turn, B still appears in the snapshot and is invoked after its Disposable returned.
- **Impact**: Limited to an extra stale invalidation; violates the post-dispose-no-callback contract.
- **SuggestedFix**: Before invoking each snapshot callback, check `entry.subscribers.has(cb)` and skip removed-mid-fanout subscribers.

### [S2] Stale `expandedPaths` entries after subtree eviction (broader cleanup)

- **File**: `src/webview/fileTree/FileTreePanel.ts:667`
- **Agent**: frontend
- **Confidence**: MEDIUM | **Priority**: P4
- **Status**: accepted-downgrade | **Triage**: Downgraded to SUGGEST. The contracts agent's W3 fix specifically prevents this from causing extra refresh RPCs (the only user-visible failure mode). Broader cleanup (callback for `evictSubtree` to drop from `expandedPaths`) is nice-to-have but unbounded growth is bounded by root remount + the 150ms debounce.
- **Evidence**: `evictSubtree` in `FileSystemDataSource` removes nodes from `nodeCache` and `subscribedPaths` but has no way to notify `FileTreePanel` to remove the corresponding entry from `expandedPaths`. The set can accumulate stale entries.
- **Impact**: Memory leak bounded by directory rename/delete activity within a single root tenure; cleared on root remount or dispose.
- **SuggestedFix**: Add `onDirectoryEvicted?: (absPath: string) => void` to `FileSystemDataSourceInit` and clear `expandedPaths` from the panel callback. Optional follow-up.

## Verification answers (combined from agents)

- **Q1 (logic)**: WatcherPool dispose race — fanout snapshots subscribers without re-checking membership. See S1.
- **Q2 (logic)**: First `currentRootGeneration` assignment in `handleRootChanged` is correctness-relevant (so unsubscribe carries the bumped generation); second is tech-debt redundancy.
- **Q3 (logic)**: Single workspace-root change is fine; rapid A→B→C produces W1 orphan leak.
- **Q4 (logic)**: `attach()` does NOT dispose prior attachments. Single-attach lifecycle is the assumed invariant; not violated in current production paths but undocumented.
- **Q5 (logic)**: Yes — `ensureSubscribed` runs before `await readDirectory`; failed reads leak. See W2.
- **Q1 (contracts)**: Fire-and-forget shape matches one-way protocol conventions in the codebase; `applyGitStatusDelta` is the analogue.
- **Q2 (contracts)**: Invalidate-then-refetch is correct for FS structural changes; granular deltas would require duplicating the read-directory metadata stamping pipeline.
- **Q3 (contracts)**: Generation gating applied consistently at every send + receive site.
- **Q4 (contracts)**: All discriminated-union extensions in place; both providers' switches updated; MessageRouter + main.ts updated.
- **Q1 (frontend)**: `expandedPaths` Set is NOT guaranteed to track only currently-expanded; it can include evicted paths. Currently benign due to `getCachedNode` lookup but worth tightening — covered by W3+S2.
- **Q2 (frontend)**: Search controller invocation cost is one null-check per debounce tick — negligible.
- **Q3 (frontend)**: Path-separator heuristic handles POSIX, Windows backslash, Windows drive-root, and POSIX root correctly. Edge case: Windows mixed `C:\foo/bar` could fail if the host emits backslash-only paths while scope contains mixed separators; in practice both arrive in the same format via `Uri.fsPath`.
- **Q4 (frontend)**: `Tree.refresh(rootNode)` preserves the expanded state of subtrees below the root (only touches `node.children` and `node.childrenPromise`; `node.expanded` is untouched; existing-in-`Tree.nodes` children keep their state).
- **Q5 (frontend)**: Callbacks fan out (refreshDirectoryByPath, then searchController.onFsInvalidated) are independent — no shared mutation, no ordering requirement.

## Session IDs

- **logic**: `a5f8db842cc1273a5`
- **contracts**: `ae3f0cc1c7a51e56d` *(applied unauthorised production-code edit — see protocol note)*
- **frontend**: `a97beac8b51b7fd50`

Use `SendMessage(to: <id>)` to resume any agent for round-2 re-review with rebuttals + updated diff.
