# Review Summary — restore-terminal-sessions

## Lifecycle (across 4 rounds)

| ID | Round 1 | Round 2 | Round 3 | Round 4 | Final |
|---|---|---|---|---|---|
| B1 (write barrier) | BLOCK / accepted | PARTIALLY → SUGGEST [S1] | by-design accepted | — | Closed (documented limit) |
| B2 (clearScrollback privacy) | BLOCK / accepted | NOT-FIXED → BLOCK [R2.B1] | VERIFIED-FIXED (no-mirror) | Re-opened via R4.B2 (with-mirror race) | Re-open |
| B3 (restore pause/resume) | BLOCK / accepted | VERIFIED-FIXED | — | — | Closed |
| B4 (split rootTabId + group eviction) | BLOCK / accepted | PARTIALLY → WARN [R2.W1] | VERIFIED-FIXED | — | Closed |
| W1 (corrupted index) | WARN / accepted | VERIFIED-FIXED | — | Re-opened via R4.W3 (unsupported version) | Re-open |
| W2 (hydrate ordering) | WARN / accepted | VERIFIED-FIXED | — | — | Closed |
| W3 (sync dispose) | WARN / accepted | VERIFIED-FIXED | — | Re-opened via R4.B1 (dispose-path equivalent) | Re-open |
| W4 (snapshot resize clobber) | WARN / accepted | VERIFIED-FIXED | — | — | Closed |
| W5 (per-tab debounce) | WARN / accepted | VERIFIED-FIXED | — | — | Closed |
| W6 (privacy docs) | WARN / accepted | VERIFIED-FIXED | — | — | Closed |
| W7 (no-workspace leak) | WARN / accepted | PARTIALLY → WARN [R2.W2] | VERIFIED-FIXED (toggle gate) | Re-opened via R4.B4 (purge ordering) | Re-open |
| W8 (path traversal) | WARN / accepted | VERIFIED-FIXED | — | — | Closed |
| W9 (ghost resurrection) | WARN / accepted | NOT-FIXED → WARN [R2.W3] | VERIFIED-FIXED (per-session re-check) | — | Closed |
| W10 (isSplitPane required) | WARN / accepted | VERIFIED-FIXED | — | — | Closed |
| R2.W4 (init/restore retry, SidebarPanel) | — | NEW / accepted | VERIFIED-FIXED (init-failure bail) | Re-opened via R4.W1 (editor redux) | Re-open |
| R2.S2 (split fit clobber) | — | NEW / accepted | VERIFIED-FIXED | — | Closed |
| R2.S3 (asymmetric throws) | — | NEW / deferred | — | — | Deferred to follow-up |
| **R4.B1** (queued destroy resurrects) | — | — | — | **NEW BLOCK** | Open |
| **R4.B2** (flushPending race overwrites clear) | — | — | — | **NEW BLOCK** | Open |
| **R4.B3** (onExit destroys exited snapshot, D13) | — | — | — | **NEW BLOCK** | Open |
| **R4.B4** (purge async ordering) | — | — | — | **NEW BLOCK** | Open |
| **R4.W1** (editor onReady sync, W4 redux) | — | — | — | **NEW WARN** | Open |
| **R4.W2** (panelSerializer UUID fallback) | — | — | — | **NEW WARN** | Open |
| **R4.W3** (loadIndex unsupported vs missing) | — | — | — | **NEW WARN** | Open |
| **R4.W4** (deferOpen no isSplitPane) | — | — | — | **NEW WARN** | Open |
| R4.suppressed (F3, F5, D1, D2, D3, O3) | — | — | — | NEW low-priority | Track for follow-up |

## Round verdicts

- Round 1: **BLOCK** (4 BLOCK + 10 WARN + 4 SUGGEST) — see round-1.md
- Round 2: **BLOCK** (1 BLOCK + 4 WARN + 3 SUGGEST) — see round-2.md
- Round 3: **APPROVE** (0 BLOCK + 0 WARN + 0 SUGGEST after follow-up) — **PREMATURE — missed 4 BLOCK that round-4 caught**
- Round 4: **REJECT** (4 BLOCK + 4 WARN + 0 SUGGEST after suppression) — see round-4.md
- Round 5: **BLOCK** (2 NEW BLOCK + 3 WARN + 2 SUGGEST after suppression) — see round-5.md. 6/8 round-4 findings VERIFIED-FIXED; 2 partial fixes (R4.B2, R4.W2) reopened as R5.B1, R5.W1.

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

**NOT ready to archive.** Round-5 caught 2 NEW BLOCK regressions in the round-4 fixes themselves — confirming oracle's "patch stack" diagnosis. Two paths forward:
1. **Patch (1 day)**: temp-file + rename for async buffer/sidecar writes (closes R5.B1 + R5.B2); fix W1-W3; accept tech-debt; round 6.
2. **Redesign (2-3 days)**: per oracle — explicit per-session lifecycle state machine + intentful SnapshotPersistence commands + transactional storage (temp + generation + atomic rename for ALL writes). Closes the bug-shape at the root.

Patch unblocks immediately; redesign prevents the next round-N regression of the same shape.
