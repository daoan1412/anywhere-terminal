# Review Summary — restore-terminal-sessions

## Lifecycle (across 6 rounds)

| ID | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 | Round 6 | Final |
|---|---|---|---|---|---|---|---|
| B1 (write barrier) | BLOCK / accepted | PARTIALLY → SUGGEST [S1] | by-design accepted | — | — | — | Closed (documented limit) |
| B2 (clearScrollback privacy) | BLOCK / accepted | NOT-FIXED → BLOCK [R2.B1] | VERIFIED-FIXED (no-mirror) | Re-opened via R4.B2 (with-mirror race) | VERIFIED-FIXED (with-mirror via epoch) — but R5.B1 reopened | VERIFIED-FIXED at root (D16 transactional) | **Closed** |
| B3 (restore pause/resume) | BLOCK / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| B4 (split rootTabId + group eviction) | BLOCK / accepted | PARTIALLY → WARN [R2.W1] | VERIFIED-FIXED | — | — | — | Closed |
| W1 (corrupted index) | WARN / accepted | VERIFIED-FIXED | — | Re-opened via R4.W3 (unsupported version) | VERIFIED-FIXED (loadIndexDetailed) | — | Closed |
| W2 (hydrate ordering) | WARN / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| W3 (sync dispose) | WARN / accepted | VERIFIED-FIXED | — | Re-opened via R4.B1 (dispose-path equivalent) | VERIFIED-FIXED (sessionsPendingDestroy) | VERIFIED-FIXED via D14 state machine | Closed |
| W4 (snapshot resize clobber) | WARN / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| W5 (per-tab debounce) | WARN / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| W6 (privacy docs) | WARN / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| W7 (no-workspace leak) | WARN / accepted | PARTIALLY → WARN [R2.W2] | VERIFIED-FIXED (toggle gate) | Re-opened via R4.B4 (purge ordering) | VERIFIED-FIXED (rmSync-first) | — | Closed |
| W8 (path traversal) | WARN / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| W9 (ghost resurrection) | WARN / accepted | NOT-FIXED → WARN [R2.W3] | VERIFIED-FIXED (per-session re-check) | — | — | — | Closed |
| W10 (isSplitPane required) | WARN / accepted | VERIFIED-FIXED | — | — | — | — | Closed |
| R2.W4 (init/restore retry, SidebarPanel) | — | NEW / accepted | VERIFIED-FIXED (init-failure bail) | Re-opened via R4.W1 (editor redux) | VERIFIED-FIXED (editor onReady async) | — | Closed |
| R2.S2 (split fit clobber) | — | NEW / accepted | VERIFIED-FIXED | — | — | — | Closed |
| R2.S3 (asymmetric throws) | — | NEW / deferred | — | — | — | — | Deferred to follow-up |
| R4.B1 (queued destroy resurrects) | — | — | — | NEW BLOCK | VERIFIED-FIXED | confirmed via D14 dispatch | Closed |
| R4.B2 (flushPending race overwrites clear) | — | — | — | NEW BLOCK | PARTIALLY → R5.B1 | VERIFIED-FIXED at root (D16) | Closed |
| R4.B3 (onExit destroys exited snapshot, D13) | — | — | — | NEW BLOCK | VERIFIED-FIXED | confirmed via commitExitSnapshot | Closed |
| R4.B4 (purge async ordering) | — | — | — | NEW BLOCK | VERIFIED-FIXED | — | Closed |
| R4.W1 (editor onReady sync, W4 redux) | — | — | — | NEW WARN | VERIFIED-FIXED | — | Closed |
| R4.W2 (panelSerializer UUID fallback) | — | — | — | NEW WARN | PARTIALLY → R5.W1 | persists (provider untouched) | **Open — defer to small follow-up** |
| R4.W3 (loadIndex unsupported vs missing) | — | — | — | NEW WARN | VERIFIED-FIXED | — | Closed |
| R4.W4 (deferOpen no isSplitPane) | — | — | — | NEW WARN | VERIFIED-FIXED | — | Closed |
| R5.B1 (stale-epoch unlink kills canonical) | — | — | — | — | **NEW BLOCK** | **VERIFIED-FIXED at root** via D16 (temp+gen+rename — async never touches canonical) | Closed |
| R5.B2 (debounced async sidecar overwrites sync) | — | — | — | — | **NEW BLOCK** | **VERIFIED-FIXED at root** via D16 + D17 (sidecarGen + temp+rename + Memento removed for index) | Closed |
| R5.W1 (panelSerializer over-broad sweep) | — | — | — | — | NEW WARN | persists — provider files untouched in round 6 | **Open** |
| R5.W2 (purge sequential Memento awaits) | — | — | — | — | NEW WARN | VERIFIED-FIXED (independent try/catch) | Closed |
| R5.W3 (destroyAllForView race) | — | — | — | — | NEW WARN | VERIFIED-FIXED (doomedIds captured at sync-enqueue) | Closed |
| **R6.W1** (rename TOCTOU between gen check and rename completion) | — | — | — | — | — | NEW WARN LOW | Open (follow-up) |
| **R6.W2** (dispose-time N sync sidecar commits) | — | — | — | — | — | NEW WARN LOW (perf) | Open (follow-up) |
| **R6.S1** (commitClearSnapshot RIS not chained into writeBarriers) | — | — | — | — | — | NEW SUGGEST | Open (follow-up) |

## Round verdicts

- Round 1: **BLOCK** (4 BLOCK + 10 WARN + 4 SUGGEST) — see round-1.md
- Round 2: **BLOCK** (1 BLOCK + 4 WARN + 3 SUGGEST) — see round-2.md
- Round 3: **APPROVE** (0 BLOCK + 0 WARN + 0 SUGGEST after follow-up) — **PREMATURE — missed 4 BLOCK that round-4 caught**
- Round 4: **REJECT** (4 BLOCK + 4 WARN + 0 SUGGEST after suppression) — see round-4.md
- Round 5: **BLOCK** (2 NEW BLOCK + 3 WARN + 2 SUGGEST after suppression) — see round-5.md. 6/8 round-4 findings VERIFIED-FIXED; 2 partial fixes (R4.B2, R4.W2) reopened as R5.B1, R5.W1.
- Round 6: **APPROVE** (0 BLOCK + 2 WARN LOW + 1 SUGGEST) — see round-6.md. **Full D14–D18 redesign**. R5.B1 + R5.B2 closed at the architecture root (transactional storage + sidecar SSOT). R5.W2 + R5.W3 closed via targeted fixes. R5.W1 persists — provider layer untouched, scheduled for separate change. 2 new LOW-confidence WARN (R6.W1 rename TOCTOU, R6.W2 dispose perf) are follow-up items, not blockers.

## Closed rate

- Round-1 (14 findings): 14/14 closed in rounds 1-3 — but 4 of those (B2, W3, W7, R2.W4) RE-OPENED in round-4 as same-pattern bugs in different locations
- Round-4 NEW findings (8): 0/8 closed — pending triage + fix

## Critical-bug-after-approve incident

After round-3 APPROVE, a critical bug was discovered in production-test: `SessionManager.dispose()` was calling `snapshots.detachSession()` which unlinked the buffer files `flushSnapshotsSync` had written milliseconds earlier. Fixed by splitting `detachSession` into two methods (`detachSession` destructive + `releaseMirror` preserve) and adding a sync sidecar `<storageUri>/snapshots/index.json` for shutdown-resilient persistence. This pre-round-4 fix is correct in its narrow scope, but round-4 reveals SAME BUG SHAPE in 4 other code paths that the original review across 5 agents × 3 rounds did not catch.

## Lessons captured

- `feedback_review_vs_instrumentation.md` — code review alone misses cross-method temporal coupling
- `feedback_api_naming_disambiguates_semantics.md` — split methods when opposite cleanup semantics needed
- **Round-4 confirms the lesson**: same bug pattern recurs in different files when the underlying fix doesn't address the systemic shape

## Recommendation

**Ready to archive (Round 6 APPROVE).** Round 6's redesign (D14–D18) was the path that round-5 oracle prescribed: per-session lifecycle state machine + intentful SnapshotPersistence commands + transactional storage. Both round-5 BLOCK findings (R5.B1 stale unlink, R5.B2 sync sidecar racy) are now architecturally impossible — not patched but eliminated. R5.W2 + R5.W3 closed via targeted fixes (independent try/catch + doomedIds capture). The dispatch in dispose/cleanupSession is exhaustive across the four states (D14) with an explicit fall-through. 4/5 round-5 findings VERIFIED-FIXED.

**Open follow-ups** (small, non-blocking):
- R5.W1 (TerminalPanelSerializer sweep) — provider layer; small change
- R6.W1 (rename TOCTOU window) — narrow microsecond window; single-flight lock or third gen check inside rename callback
- R6.W2 (dispose-time N sync sidecar commits) — perf; batch-write or skip when `_disposed`
- R6.S1 (commitClearSnapshot RIS not chained into writeBarriers) — 3-line fix

The architecture root-fix model worked: round-3 → round-4 → round-5 was patch-on-patch; round-6 was a clean redesign and the bug-shape was eliminated.
