# Review Round 4 — restore-terminal-sessions

**Date**: 2026-05-26
**Reviewable lines**: ~4,665 (full uncommitted diff — includes the critical-bug fix + refactor: `detachSession` split + sidecar `index.json`)
**Agents spawned**: data-security, logic, contracts, frontend, oracle (all 5 ultimately responded; both contracts + oracle required one retry each due to CF 524)
**Prior rounds**: round-1.md (BLOCK), round-2.md (BLOCK), round-3.md (APPROVE — premature)

## Verdict: **REJECT**

4 BLOCK findings (all HIGH confidence) + 4 WARN. Round-3's APPROVE was wrong; the criteria for "all findings closed" missed FIVE classes of cross-method temporal coupling bugs that none of the per-method reviewers in rounds 1-3 caught. Round-4 instructed agents to specifically hunt for the bug PATTERN (not just verify prior fixes), and the result is the highest-quality finding set across all rounds.

**Counts**: 4 BLOCK / 4 WARN / 0 SUGGEST (6 suppressed under priority cap — listed at bottom)

---

## Findings

### [B1] Queued user destroy resurrects after deactivate
**File**: `src/session/SessionManager.ts:702-710, 778-832, 837-866` | **Agent**: logic | **Confidence**: HIGH | **Priority**: P1

**Evidence**: `destroySession()` appends to `operationQueue` (microtask). `performDestroy()` adds id to `terminalBeingKilled`, kills PTY, awaits `setTimeout(0)`, then calls `cleanupSession()` → `detachSession()` (which unlinks the buffer file + drops index entry). If `extension.deactivate()` lands either (a) AFTER `destroySession()` enqueued but BEFORE the microtask runs, or (b) inside the `setTimeout(0)` await window, then `dispose()` walks `sessions.keys()` (still includes the doomed id) → calls `releaseMirror(id)` → **PRESERVES the snapshot**. Then `sessions.clear()`. Then the queued `performDestroy` resumes; `cleanupSession()` early-returns because `this.sessions.get(id)` is undefined. Result: a snapshot the user explicitly closed survives to the next activate and the closed terminal reappears.

**Impact**: User-visible silent data persistence violation. Privacy contract: a tab the user actively destroyed should not come back. The window is narrow but deterministic under shutdown pressure.

**Suggested fix**: Track destructive intent synchronously. Add `sessionsPendingDestroy: Set<string>` updated by `destroySession()` / `destroyAllForView()` at enqueue time. In `dispose()`, for each id in that set call `snapshots.detachSession(id)` (destructive) instead of `snapshots.releaseMirror(id)` (preserve). Clear the set only after `cleanupSession()` completes.

---

### [B2] flushPending re-entry race overwrites cleared snapshot with pre-clear content
**File**: `src/session/SnapshotPersistence.ts:441-549, 339, 456-464` | **Agent**: logic | **Confidence**: HIGH | **Priority**: P1

**Evidence**: `flushPending()` has no single-flight protection. Adversarial sequence:
1. Debounce timer fires → `void this.flushPending()` starts for session A. Clears `_pendingSessions`. Awaits `writeBarrier(A)` (older state). Calls `generateSnapshotMetadata(A)` → **serializes pre-clear content**.
2. User triggers `clearScrollback(A)` → `resetMirror(A)` → chains RIS write into `writeBarriers[A]` → `void flushSessionImmediate(A)` → `await this.flushPending()`.
3. Second `flushPending` starts. Awaits its own `writeBarrier(A)` (which now includes the RIS). Serializes POST-RIS empty buffer. `writeBufferFileAsync(A, empty)` writes empty file. Assigns `_snapshotIndex[A] = {empty, snapshotAt: t2}`.
4. First call resumes — its `writeBufferFileAsync(A, pre-clear)` was already in flight. Two concurrent writes to the same file; LAST write wins. If step 1's write completes after step 3's, file contains pre-clear content. Then step 1's `_snapshotIndex[A] = {pre-clear, snapshotAt: t1}` overwrites step 3's newer metadata.

**Impact**: Clear-scrollback privacy boundary can be violated. The user clears, the file persists, the cleared content is restored after restart. The B2/R2.B1 fix (`purgePersistedSnapshot`) covers the no-mirror case but does NOT close this with-mirror race.

**Suggested fix**: Serialize `flushPending` executions via a single-flight lock. Add a per-session epoch token bumped by `resetMirror()` + `purgePersistedSnapshot()`. In `flushPending`, capture the epoch at entry; before assigning to `_snapshotIndex` or writing the file, re-check the captured epoch matches the live one. Stale epoch → discard the write + unlink the file you just wrote.

---

### [B3] Non-killed `pty.onExit` destroys the exited-shell snapshot D13 promises to preserve
**File**: `src/session/SessionManager.ts:426-437, 871-898` + `src/session/SnapshotPersistence.ts:214-231` | **Agent**: oracle | **Confidence**: HIGH | **Priority**: P1

**Evidence**: In `createSession`'s `pty.onExit` wire (line 426-437): for non-killed exits (e.g. user typing `exit` in the shell, or crash), the handler calls `recordExit(session, code)` → fires `onShellExited` (immediate flush) → then calls `cleanupSession(id)`. `cleanupSession` calls `snapshots.detachSession(id)` which **unlinks the buffer file + drops the index entry**.

Per design.md D13: "exited entries are KEPT (restored read-only)". The fire-and-forget `flushSessionImmediate(id)` queues an async write, but `cleanupSession` runs synchronously immediately after and detaches before the write completes. Even if the write races ahead, `flushPending`'s per-session liveness re-check (`if (!this.getSession(id))`) at SnapshotPersistence.ts:526 unlinks the just-written file.

`SessionManager.exit.test.ts:131-134` explicitly acknowledges the bug: "The non-killed exit path runs cleanup; the snapshot can no longer be generated (session removed)". The test then sidesteps to the killed path to inspect state.

**Impact**: Spec violation. A shell that exits naturally (`exit`, `Ctrl+D`, or crashes) leaves no restored read-only view after restart. The D13 contract — central to the "restore EVERY terminal" UX — is silently broken for the most common exit path.

**Suggested fix**: Special-case the shell-exit cleanup. When `session.shellExited === true`, `cleanupSession` should call `snapshots.releaseMirror(id)` (preserve persistence) instead of `detachSession(id)` (destroy). Equivalently: move the snapshot teardown out of `cleanupSession` and only run it from explicit-destroy paths.

---

### [B4] `SessionStorage.purge()` await-then-rm ordering leaves stale sidecar on shutdown cancel
**File**: `src/session/SessionStorage.ts:241-262` + `src/extension.ts:65-70` + `src/session/SnapshotPersistence.ts:151-172` | **Agent**: oracle | **Confidence**: HIGH | **Priority**: P1

**Evidence**: `SessionStorage.purge()` awaits `workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined)` and `workspaceState.update(LIVE_EDITOR_PANELS_KEY, undefined)` BEFORE running `rmSync(snapshotsDir, {recursive, force})`. Both fire sites for purge are fire-and-forget (`void this.storage.purge()`):
- Runtime toggle off: `setRestoreEnabled(false)` at SnapshotPersistence.ts:171
- Activate with restoreEnabled=false: `extension.ts:70`

VS Code raises a `Canceled` Thenable on `Memento.update()` during ext-host shutdown — this is the SAME platform behavior that produced the original critical bug. If user toggles off + quits within the debounce window, the first `await` throws Canceled, the try-block exits, `rmSync` never runs, sidecar `index.json` and `*.snapshot.ans` files persist on disk.

On next activate with restoreEnabled=true, `loadIndex()` prefers the stale sidecar over the now-purged Memento → hydrates phantom sessions whose buffer files are also still on disk. Privacy contract violated.

**Impact**: This is the SAME bug shape as the original (Canceled Memento + file cleanup that depends on it). The sidecar was added to dodge the bug in one direction; in the opposite direction (purge) it's still vulnerable. Round-3 fixed write-path; round-4 catches read-path equivalent.

**Suggested fix**: In `purge()`, run `rmSync` synchronously FIRST, before any `await workspaceState.update`. File cleanup must be the first-step boundary; Memento cleanup is best-effort. Alternative: add `purgeFilesSync()` exposed for the activate path that drops files before any awaited Memento work.

---

### [W1] TerminalEditorProvider.onReady is synchronous — R2.W4 redux for editor revive
**File**: `src/providers/TerminalEditorProvider.ts:585, 629-663` | **Agent**: frontend | **Confidence**: HIGH | **Priority**: P1

**Evidence**: Round-3 fixed `TerminalViewProvider.onReady` to `async` + `await safeSendWithRetry(init)` before `restoreFromSnapshot` posts, with bail-on-failure. The editor-tab equivalent at `TerminalEditorProvider.ts:585` is `private onReady(): void` — synchronous. Phase B branch (line 629-663) posts `init` via fire-and-forget `safePostMessage` then immediately loops `restoreFromSnapshot` calls. If the webview hasn't processed `init` before the restore posts arrive (race window same as W4), the webview falls into the `deferOpen` mis-wrap — exactly what R2.W4 was closing. The R2.W4 fix was NOT applied symmetrically to the editor provider.

**Impact**: User-visible blank editor terminals on cross-restart restore (Phase B). The exact symptom that triggered the critical bug hunt this round. The fix exists in TerminalViewProvider; it just wasn't ported.

**Suggested fix**: Mirror TerminalViewProvider's async `onReady` + `safeSendWithRetry` in TerminalEditorProvider. Both Phase A (`init` then `restore`) and Phase B (`init` then `restoreFromSnapshot`) branches must await init delivery and bail symmetrically.

---

### [W2] TerminalPanelSerializer UUID fallback orphans snapshot + nukes grace cancel
**File**: `src/providers/TerminalPanelSerializer.ts:27-46` | **Agent**: frontend | **Confidence**: HIGH | **Priority**: P2

**Evidence**: When `state?.panelId` is absent (corrupt state, first-ever serialize on old version, VS Code drops state), `panelId = crypto.randomUUID()` generates a fresh UUID. Two cascading failures:
1. `cancelScheduledDestroy("editor-${freshUUID}")` is a no-op because the prior `onDidDispose` scheduled destroy under `"editor-${originalPanelId}"`. The grace-period destroy fires ~5s after revive, **killing the just-revived PTY**.
2. `consumeSnapshotsForPanel(freshUUID)` returns nothing → persisted snapshot stays orphaned on disk + the revived editor terminal starts empty instead of restoring.

**Impact**: User loses both the PTY (5s after revive) and the persisted scrollback. Silent — no error surfaced. Symptom: editor tab opens with a working terminal that suddenly goes blank.

**Suggested fix**: Log a warning when falling back to a fresh UUID. For the grace-period: when state is absent, sweep all `editor-*` pending destroys and cancel any whose viewId matches the fresh UUID's prefix (no other panel can claim them). Better: when state is absent, refuse to revive — emit a webview error or close the panel — since restore is impossible without the panelId.

---

### [W3] `loadIndex` collapses "unsupported sidecar version" with "absent index" → orphan recovery runs wrongly
**File**: `src/session/SessionStorage.ts:55-69` | **Agent**: contracts | **Confidence**: HIGH | **Priority**: P2

**Evidence**: `loadIndex()` returns `undefined` for `parsed.version !== 1`. Downstream, `SnapshotPersistence.hydrateFromSnapshots()` treats `undefined` as "index absent" and runs **orphan recovery** (Step 3 at SnapshotPersistence.ts:672), synthesizing v1 entries from surviving buffer files. Per spec: "corrupted state is discarded, not recovered" (round-1 W1). A future v2 sidecar would trigger the wrong fallback path — orphan recovery silently restores buffers with potentially incompatible v1 metadata.

**Impact**: Forward-compat hazard. A v2 release that introduces breaking metadata changes can't safely downgrade in mixed-version environments — old extensions would orphan-recover the v2 files with v1 defaults.

**Suggested fix**: Distinguish "missing" from "unsupported" at the API surface. Change `loadIndex()` to return `{ kind: "valid"; index } | { kind: "missing" } | { kind: "unsupported" }`, and gate orphan recovery in `hydrateFromSnapshots` on the `missing` case only — `unsupported` should also disable orphan recovery (matching round-1 W1's "corrupted = discard" semantics).

---

### [W4] webview deferOpen path creates terminal without `isSplitPane` — corrupts tabLayouts under W1 race
**File**: `src/webview/main.ts:441-449` | **Agent**: frontend | **Confidence**: HIGH | **Priority**: P3

**Evidence**: In `onRestoreFromSnapshot`'s defensive deferOpen branch, the call to `factory.createTerminal(msg.tabId, msg.tabId, store.currentConfig, isActive, null, { deferOpen: true })` omits `isSplitPane`. When `isSplitPane` defaults to false, `TerminalFactory.createTerminal` runs `store.tabLayouts.set(id, createLeaf(id))` and `store.tabActivePaneIds.set(id, id)`. If the missing terminal is actually a split-pane CHILD (which can happen when the W1 race makes init/restoreFromSnapshot land out of order), the deferOpen path overwrites the correctly-restored parent's `tabLayouts` with a bare leaf, collapsing the split tree. `store.persist()` then writes the corrupted layout to VS Code state.

**Impact**: Persistent data corruption of split-pane layouts when W1's race fires for a split child. Requires both W1 + a split-pane snapshot to manifest, but if it does, the layout damage outlives the W1 fix.

**Suggested fix**: Pass `isSplitPane: true` to `createTerminal` in the deferOpen fallback when the tabId is not already a root in `store.tabLayouts.keys()`. At minimum, skip the `tabLayouts.set` mutation in the deferOpen path entirely.

---

## Suppressed (priority cap — track for follow-up)

6 lower-priority findings were dropped under the 8-finding cap:

| ID | Severity | File | Title | Why suppressed |
|---|---|---|---|---|
| F3 | WARN MEDIUM | TerminalViewProvider.ts:329-331 | Concurrent user messages during async onReady race with in-flight init | Narrow window (~50-150ms); easy follow-up |
| F5 | SUGGEST | TerminalEditorProvider.ts:610-628 | Phase A editor uses fire-and-forget init | Bundle into W1's fix |
| D1 | WARN MEDIUM | SessionStorage.ts:55-69 | Sidecar shape validation shallow | Same trust boundary as Memento |
| D2 | WARN MEDIUM | SnapshotPersistence.ts:349-361 | purgePersistedSnapshot doesn't sync update sidecar | Privacy contract held via "missing file → drop entry" |
| D3 | SUGGEST | SnapshotPersistence.ts:151-173 | Toggle-off purge is fire-and-forget no error surfaced | Same root cause as B4 — fix together |
| O3 | WARN MEDIUM | SnapshotPersistence.ts:476/562 | Deactivate sync flush not serialized vs running async flushPending | Same root cause as B2 — fix together |

---

## Round-3 Status Verification

| Round-3 Status | Holds in Round-4? |
|---|---|
| B1 (clearScrollback no-mirror, R2.B1) — VERIFIED-FIXED | Yes for no-mirror path. NEW B2 catches with-mirror race for same clear semantics. |
| W1 (group-level eviction, R2.W1) — VERIFIED-FIXED | Yes |
| W2 (runtime toggle guard, R2.W2) — VERIFIED-FIXED | Yes for the toggle gate. NEW B4 catches the purge ordering. |
| W3 (per-session destroy race, R2.W3) — VERIFIED-FIXED | Per-session re-check holds for async flush. NEW B1 catches the dispose-path equivalent. |
| W4 (init/restore retry ordering, R2.W4) — VERIFIED-FIXED | TerminalViewProvider only. NEW W1 catches the editor-provider redux. |
| S2 (split-pane fit gate, R2.S2) — VERIFIED-FIXED | Yes |

**Pattern**: Every BLOCK / WARN in round-4 is either (a) a NEW instance of the same bug PATTERN that prior rounds fixed in just one place, or (b) a new cross-method coupling that per-method review can't see. The fixes from rounds 1-3 are valid — they're just incomplete.

---

## Verification Questions / Responses

| Q | Domain | Answer |
|---|---|---|
| Q1 (data-sec): sidecar privacy + integrity | data-sec | Shallow validation; not a regression vs Memento — same trust boundary. WARN. |
| Q2 (data-sec): purge() completeness | data-sec | rmSync covers sidecar+buffers IF reached. Race in B4 means it may not reach. |
| Q3 (data-sec): clearScrollback privacy boundary | data-sec | Holds via "missing file → drop entry". Subject to B2 race. |
| Q1 (logic): lifecycle ordering audit | logic | dispose uses releaseMirror correctly EXCEPT when destroy is queued/in-flight → B1. |
| Q2 (logic): flushSnapshotsSync vs flushIndexAwaited divergence | logic | Not material for restore correctness; sidecar wins on load. |
| Q3 (logic): pending operation queue + dispose race | logic | Real bug → B1. |
| Q4 (logic): flushPending re-entry race | logic | Real bug → B2. |
| Q1 (contracts): detachSession vs releaseMirror | contracts | onExit non-killed path uses wrong method → B3. |
| Q2 (contracts): sidecar version contract | contracts | Unsupported version mishandled → W3. |
| Q1 (frontend): init-before-restore symmetry | frontend | Editor not fixed → W1. |
| Q2 (frontend): deserializeWebviewPanel state restore | frontend | UUID fallback orphans → W2. |
| Oracle: new cross-method bugs? | oracle | 3 found (B3, B4, O3-suppressed). Two of three are HIGH confidence. |

---

## Process Retrospective (oracle + chair)

Oracle's verdict on the round-3 miss: "Primarily a tools/process failure, not reviewer negligence." Per-method static review is structurally weak at temporal coupling across methods. The round-1/2/3 fix sequence — clear individual fixes that each looked correct in isolation — accumulated 5 bugs of the SAME PATTERN that nobody could see at the per-method scope.

**What round-4 did differently** (and worked):
- Explicit instruction to agents: "hunt for the bug PATTERN, not just verify prior fixes"
- Provided agents with the prior-bug shape ("flushSync writes → dispose unlinks") so they could pattern-match
- Oracle was given the other agents' findings as anti-context and told "find NEW bugs of the same shape"

**Recommendation for going forward**: State-machine / fault-injection tests are mandatory before approve. The tests should encode:
- destroy + deactivate interleaving (B1)
- clear + persist interleaving (B2)
- onExit + cleanup ordering (B3)
- toggle-off + Canceled-Memento + quit ordering (B4)
- editor Phase B init-then-restore (W1)
- serialize-state-loss revive (W2)

Without these, the next refactor will re-introduce one of these or a sibling bug.

---

## Test + Type Gate

Not re-run this round — code unchanged since round-3's 1299/1299 pass. Findings are about behavioral correctness, not type-level breakage. After fixes, MUST re-run.

---

## Session IDs (round-4)

- data-security: `a5cc4e4421175c546` (first attempt succeeded)
- logic: `a4dd27cdd3695631b` (first attempt succeeded)
- contracts: `a761a71e66b5dfbfc` (second attempt — first 524'd)
- frontend: `a630c71e0afe636f3` (first attempt succeeded)
- oracle: `a45b834bd99474e64` (second attempt — first 524'd, third attempt 524'd before second succeeded)

## Persisted

- `asimov/changes/restore-terminal-sessions/.reviews/round-4.md` (this file)
- `asimov/changes/restore-terminal-sessions/.reviews/summary.md` (cross-round lifecycle table — to be updated)
