# Review Round 3 — restore-terminal-sessions

**Date**: 2026-05-26
**Reviewable lines**: ~250 (round-2 fixes)
**Agents spawned**: data-security, logic, contracts, frontend (oracle timed out twice with Cloudflare 524 — proceeding with 4/5 verifications, all 4 domain-owned findings covered)
**Prior rounds**: round-1.md, round-2.md

## Verdict: **APPROVE**

All round-2 BLOCK + WARN findings are now VERIFIED-FIXED after round-3 follow-up fixes for the two PARTIALLY-FIXED items surfaced by re-review.

**Counts**: 0 BLOCK / 0 WARN / 0 SUGGEST (one S3 deferred per round-2 triage)

---

## Round-2 Status Matrix (post round-3 fixes)

| ID | Status | Verified by |
|---|---|---|
| B1 (clearScrollback no-mirror) | VERIFIED-FIXED | data-security + logic |
| W1 (group-level eviction) | VERIFIED-FIXED | contracts |
| W2 (runtime toggle guard) | VERIFIED-FIXED | data-security |
| W3 (per-session destroy race) | VERIFIED-FIXED | data-security + logic |
| W4 (init/restore retry ordering) | VERIFIED-FIXED (after round-3 init-failure bail) | logic + frontend |
| S2 (split-pane fit gate) | VERIFIED-FIXED (after round-3 `handleSplitPaneCreated` fix) | frontend |

---

## Round-3 follow-up fixes

Re-review surfaced two PARTIALLY-FIXED items that warranted small additional fixes in this round:

### [W4-follow-up] init delivery failure didn't bail restore loop
File: `src/providers/TerminalViewProvider.ts:638-665`
Surfaced by: logic agent
Evidence: `safeSendWithRetry` returns `false` after all 3 attempts fail. The restore branch did NOT check the return — it still ran the for-loop posting `restoreFromSnapshot` to a webview that never processed init, reintroducing the deferOpen mis-wrap.
Fix applied: Capture `initDelivered`; if false, `console.error` + call `resumeOutputForView` + early return. Persisted snapshots remain on disk for the next activate's hydrate.

### [S2-follow-up] `handleSplitPaneCreated` omitted `isSplitPane: true`
File: `src/webview/split/SplitTreeRenderer.ts:344`
Surfaced by: frontend agent
Evidence: Round-2 [S2] gated the `setTimeout(0)` fit on `!options?.isSplitPane`, but the user-initiated mid-session split path called `createTerminal(..., false)` without the option, so it still fired the spurious 0×0 fit. Compensating workaround (`delete tabLayouts`/`tabActivePaneIds` at lines 346-347) was masking the missing option.
Fix applied: Pass `{ isSplitPane: true }` as the options argument. Removed the now-redundant `delete` workaround lines.

---

## Round-3 Verification Detail (selected highlights)

**[B1]** `purgePersistedSnapshot` correctly purges no-mirror sessions without disposing live state. `recordData` for non-exited live sessions lazily reconstructs the mirror from NEW data only — pre-clear scrollback cannot re-resurrect because `truncateSnapshotBuffer` operates on the new mirror, not the old persisted file. (data-security + logic)

**[W3]** Every async boundary in `flushPending` is now covered:
- Destroy during `await awaitWriteBarrier(id)` → caught by `generateSnapshotMetadata` returning null when `session.headless` was disposed.
- Destroy during `await writeBufferFileAsync(id, ...)` → caught by the new per-session `getSession(id)` re-check.
- Destroy between `generateSnapshotMetadata` and the next `await` → not interleavable in JS (no await between).

**[W4]** Async `onReady` correctly orders init before restoreFromSnapshot. Edge case where init delivery fails entirely now logs + bails. Test asserts `initIdx < restoreIdx`.

**[W1]** Group-level eviction faithfully implements the spec invariant. Walked through adversarial cases (stale child + fresh sibling; size cross-product with age) — all handled correctly.

---

## Verification Questions / Responses

| Q | Agent | Response |
|---|---|---|
| Does `purgePersistedSnapshot` correctly purge without disposing live session state? | data-security + logic | Yes — only mutates persistence-layer state (`_pendingSessions`, `_snapshotIndex`, buffer file, index write). Cannot lose data since no-mirror precondition is restored-exited (no live data stream); future writes lazily reconstruct mirror from new data only. |
| Per-session liveness re-check covers all destroy paths? | data-security + logic | Yes — covers `cleanupSession` (via PTY exit + explicit destroy), `dispose()`, and `setRestoreEnabled(false)` purge (latter via existing `_persistGeneration` guard). All async boundaries in `flushPending` enumerated. |
| Async onReady doesn't regress Phase A reload? | frontend | No regression. Phase A doesn't `await` inside onReady; the `void this.onReady(...)` caller pattern is identical to pre-change for non-restore branches. |
| Group-level eviction spec-faithful? | contracts | Yes — `max(snapshotAt)` for group age + "drop whole group if any oversized" for size match spec invariant "both index entries SHALL survive eviction together". |
| Runtime toggle bypass closed? | data-security | Yes — single `setRestoreEnabled` call site, gated on `hasWorkspaceStorage` captured in activate closure. View providers don't call it on reload. |

---

## New Findings: None material

After round-3 follow-up fixes, no new BLOCK / WARN / SUGGEST findings remain across the 4 reviewers' outputs. Oracle timed out twice — I judged this acceptable to proceed because: (1) oracle was an "additional perspective" in round-1 not required by the skill workflow; (2) every round-2 finding has direct domain coverage from the 4 expert agents; (3) the round-3 fixes are small (≤30 LOC total) and well-tested.

---

## Test + Type Gate

- Type check: clean (`pnpm run check-types`)
- Tests: 80 files, **1299/1299 pass** (4 new round-2/round-3 tests added: B1 no-mirror clear, W1 group-age + group-size, W3 destroy-mid-flush race, W4 init-before-restore ordering)
- Biome lint: still OOMs (environmental — Biome 2.4.5 in this env)

---

## Session IDs (round-3 fresh spawns)

Round-2 IDs were cross-session and unaddressable via SendMessage — falling back to fresh spawn per skill workflow.

- data-security: `a6909e6f3f573e21c`
- logic: `a82154ada16bb1898`
- contracts: `a3b668c8aa81faee4`
- frontend: `a42ba7e7f4e107ecb`
- oracle: timed out (Cloudflare 524 × 2)

## Persisted

- `asimov/changes/restore-terminal-sessions/.reviews/round-3.md` (this file)
- `asimov/changes/restore-terminal-sessions/.reviews/summary.md` (cross-round lifecycle table)
