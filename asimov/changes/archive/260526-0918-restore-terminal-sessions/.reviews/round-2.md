# Review Round 2 — restore-terminal-sessions

**Date**: 2026-05-26
**Reviewable lines**: ~4K added across the 3 round-1-fix commits + uncommitted working tree
**Agents spawned**: data-security, logic, contracts, frontend, oracle (cross-cutting independent perspective)
**Prior round**: round-1.md (4 BLOCK + 10 WARN + 4 SUGGEST, all accepted for fix)

## Verdict: **BLOCK**

1 BLOCK residual + 4 WARN residuals/new + 3 SUGGEST. The refactor is sound and most fixes verified; the privacy boundary contract for `clearScrollback` is the main remaining gap.

**Counts**: 1 BLOCK / 4 WARN / 3 SUGGEST

---

## Round-1 Status Matrix

| ID | Status | Notes |
|---|---|---|
| B1 | PARTIALLY-FIXED | Async paths await write barrier. Sync deactivate (`flushSnapshotsSync`) by design does NOT — accepted limitation, see [S1]. |
| B2 | **NOT-FIXED (privacy contract gap)** | Restored exited sessions (no headless mirror) bypass `resetMirror`. See [B1]. |
| B3 | VERIFIED-FIXED | `pauseOutput` before `pty.onData` wiring; providers `resumeOutputForView` after restore postMessages. |
| B4 | PARTIALLY-FIXED | rootTabId wired end-to-end on happy path; per-entry age/size filter still runs BEFORE grouping. See [W1]. |
| W1 | VERIFIED-FIXED | `indexCorrupted` flag correctly distinguishes absent vs unsupported. |
| W2 | VERIFIED-FIXED | `hydrateLivePanels` runs before `hydrateFromSnapshots`; orphan fallback maps to panelId. |
| W3 | VERIFIED-FIXED | `dispose()` synchronously tears down sessions, bypasses queue. |
| W4 | VERIFIED-FIXED | `terminal.resize` only on `attachLater` branch. |
| W5 | VERIFIED-FIXED | Per-tab `splitFitTimeouts: Map<string, number>`. |
| W6 | VERIFIED-FIXED | Setting description + README warn plaintext on disk + Cmd+K boundary. |
| W7 | PARTIALLY-FIXED | Activate-time guard works. Runtime toggle handler bypasses it. See [W2]. |
| W8 | VERIFIED-FIXED | `assertSafeSessionId` covers empty/dotfile/slash; all I/O paths route through guards. |
| W9 | **NOT-FIXED** | `_persistGeneration` only bumps on `setRestoreEnabled`, not per-session `detachSession`. See [W3]. |
| W10 | VERIFIED-FIXED | `isSplitPane: boolean` required; both providers emit explicitly. |

---

## Findings

### BLOCK

**[B1] `clearScrollback` is NOT a privacy boundary for restored exited terminals**
Files: `src/session/SnapshotPersistence.ts:187-190` + `:289-292` + `src/session/SessionManager.ts:609-615`
Severity: BLOCK / HIGH / P1 — Agents: logic + oracle (independent agreement)
Round-1 ref: B2 residual
Evidence: Round-1 B2 fix added `resetMirror(sessionId)` (RIS + immediate flush) to `clearScrollback`. But `attachSession` skips the headless mirror entirely when `restoreFrom.metadata.shellExited === true` (`SnapshotPersistence.ts:190`). `resetMirror` then early-returns at `:291-292` for the same reason. Result: a user pressing `Cmd+K` on a restored exited terminal clears the live xterm display but leaves the existing `<storageUri>/snapshots/<sessionId>.snapshot.ans` file and index entry untouched — the cleared content reappears on the NEXT restart's restore.
Impact: Privacy boundary contract documented in `README.md:81` ("clear-screen command (Cmd+K) now also clears the persisted buffer, so use it as a privacy boundary") is silently violated for the read-only restored-exited subset. Users explicitly clearing sensitive output before screen-share / hand-off can have it resurrected.
Fix: In `clearScrollback`, when the session is exited / has no mirror, directly delete the buffer file + index entry via `SnapshotPersistence.detachSession(sessionId)` (or a new explicit `purgeSnapshot(sessionId)` method that unlinks the file + scrubs the index without disposing the mirror). Either way the persisted file must go.
Status: **accepted**
Triage: Privacy contract (README:81 + B2 commit message) explicit. Will fix in round-3.

### WARN

**[W1] Eviction applies per-entry age + size caps BEFORE grouping by `rootTabId`**
File: `src/session/sessionSnapshotEviction.ts:19-34`
Severity: WARN / HIGH / P2 — Agent: contracts
Round-1 ref: B4 residual
Evidence: Step 1 of `evictIndex` drops individual entries that exceed `SNAPSHOT_MAX_AGE_MS` (7d) or `SNAPSHOT_MAX_BUFFER_BYTES` (1MB). Only Step 2 onward groups by `rootTabId`. If one pane in a split goes dormant for 7 days while a sibling is active (sibling re-writes refresh `snapshotAt` only on the sibling's own metadata), or if one pane's buffer exceeds 1MB while sibling's is small, the dormant/oversized pane is evicted independently and the layout is orphaned. The spec at `specs/cross-restart-session-restore/spec.md:123-126` ("both index entries SHALL survive eviction together") is then violated even though Step 4's count-based grouping works correctly.
Impact: Practical trigger is narrow (split with one dormant or one ballooned pane), but the round-1 contract claim "split-pane snapshots evict as a group" is still incomplete.
Fix: Apply age + size eviction at the group level, not the entry level — either drop the whole group if ANY member is expired (strict), OR clamp the group's freshness to `max(member.snapshotAt)` and size to `max(member.bufferBytes)`. Document the chosen semantic in design.md D5.
Status: **accepted**
Triage: Spec invariant violation real (rare trigger but real). Will use max(snapshotAt) for age + drop-group-if-any-member-oversized for size. Round-3 fix.

**[W2] Runtime `sessionRestore.enabled` toggle bypasses no-workspace-folder guard**
File: `src/extension.ts:497-499`
Severity: WARN / HIGH / P2 — Agent: data-security
Round-1 ref: W7 residual
Evidence: Activate-time computes `hasWorkspaceStorage = context.storageUri !== undefined` and `restoreEnabled = hasWorkspaceStorage && readSessionRestoreEnabled()` — the no-folder guard. The `SessionStorage` instance is constructed unconditionally with `context.storageUri ?? context.globalStorageUri`, so when `storageUri` is undefined, storage points at the shared global directory. The `onDidChangeConfiguration` handler at `:497-499` calls `sessionManager.setRestoreEnabled(readSessionRestoreEnabled())` directly, NOT gated on `hasWorkspaceStorage`. If a user toggles the setting from off → on (or User-scope sync flips it) in a no-workspace window, `restoreEnabled` becomes true and subsequent PTY activity writes snapshots into `<globalStorageUri>/snapshots/` — visible to every other no-folder window the user opens.
Impact: Cross-no-folder-window data leak — the exact W7 threat model, just via the runtime toggle path instead of activate-time. Default-on means the trigger requires user action, but the setting IS a documented user-facing kill switch.
Fix: Capture `hasWorkspaceStorage` in the activate closure and gate the toggle: `sessionManager.setRestoreEnabled(hasWorkspaceStorage && readSessionRestoreEnabled())`. Optionally `console.warn` when the toggle is suppressed.
Status: **accepted**
Triage: Defense-in-depth, one-line fix. Round-3.

**[W3] Per-session destroy during async flush still resurrects ghost index entries**
File: `src/session/SnapshotPersistence.ts:431-466` + `:214-230` + `:156`
Severity: WARN / HIGH / P3 — Agents: data-security + logic + oracle (3-way independent agreement)
Round-1 ref: W9 NOT-FIXED
Evidence: `_persistGeneration` increments ONLY in `setRestoreEnabled`. Per-session cleanup (`detachSession`) deletes the index entry + unlinks the buffer file but does NOT bump the generation. Inside `flushPending`, `isStillCurrent()` checks `restoreEnabled` / `storage` / `_persistGeneration` — none of which mutate on a single-session destroy. The `getSession(id)` check before `awaitWriteBarrier` catches early destroys, but the window between `await storage.writeBufferFileAsync(id, ...)` (line 451) and `this._snapshotIndex[id] = result.metadata` (line 466) still permits: cleanup runs, unlinks the file, drops the entry → async write completes, recreates the file → line 466 reinserts the index entry. `scheduleIndexWrite` then persists the ghost.
Impact: A destroyed terminal's plaintext scrollback can be resurrected on the next restart. Narrow race but real privacy implication (same content as W6).
Fix: Add `this._persistGeneration++` to `detachSession`. One-line, makes `isStillCurrent()` honest. Optionally add a defensive `if (!this.getSession(id)) { await storage.unlinkBufferFile(id); continue; }` after line 451.
Status: **accepted**
Triage: 3-way agreement. Privacy-flavored race; one-line fix.

**[W4] `init` postMessage uses fire-and-forget `safeSendWithRetry` while restore loop posts synchronously — retry path inverts order**
File: `src/providers/TerminalViewProvider.ts:632-649` + `src/providers/TerminalEditorProvider.ts:641-663`
Severity: WARN / HIGH / P3 — Agent: frontend
Round-1 ref: new finding (B3 follow-up)
Evidence: The restore path does `void this.safeSendWithRetry(webview, {type: "init", ...})` and then synchronously loops calling `safePostMessage(webview, {type: "restoreFromSnapshot", ...})`. Happy path: webview is ready, FIFO ordering holds, init lands first. Unhappy path: `safeSendWithRetry`'s first attempt fails and a 50ms retry is scheduled, while the subsequent `safePostMessage` calls successfully enqueue immediately. The webview then processes `restoreFromSnapshot` before `init`, sees no terminal instance for the tabId, falls into the `deferOpen` branch — and `attachLater = true` triggers the `terminal.resize(snap.cols, snap.rows)` path which is exactly what round-1 W4 was designed to avoid (causes mis-wrap).
Impact: Narrow retry-path race. Bypasses the W4 fix and reintroduces the open-already-vs-deferred dimension authority confusion.
Fix: Await `safeSendWithRetry` for `init` before posting `restoreFromSnapshot` messages. Or stash `restoreFromSnapshot` payloads on the provider and post them inside the retry promise's `.then()`. Either way, restore-from-snapshot MUST observe init-delivery.
Status: **accepted**
Triage: Narrow but reproducible. Async await pattern; clean fix.

### SUGGEST

**Triage of SUGGESTs**: S1 = **rejected (by-design)** — no fix; documented limit. S2 = **accepted** — trivial gate. S3 = **deferred** — latent footgun, track in follow-up change.

**[S1] Sync deactivate flush (`flushSnapshotsSync`) accepts ≤8ms of unparsed PTY data as a documented limitation**
File: `src/session/SnapshotPersistence.ts:494-511` + comment at `:109-110`
Severity: SUGGEST / HIGH / P4 — Agent: oracle
Round-1 ref: B1 residual
Evidence: Round-1 B1 fix added a per-session async write barrier and `flushPending` awaits it. The sync deactivate path (`flushSnapshotsSync`) cannot await — Memento writes that survive deactivate must be sync, and the awaitable `headless.write(data, cb)` callback would force microtask scheduling that the sync path can't take. The code documents this trade-off explicitly. No path forward without rearchitecting deactivate.
Impact: ≤8ms tail of PTY data may be missing from the snapshot captured at deactivate. Acceptable.
Fix: Keep current behavior; ensure design.md notes this is by-design.

**[S2] `TerminalFactory.createTerminal` schedules a `setTimeout(0)` fit for split-pane children before `renderTabSplitTree` reparents them**
File: `src/webview/terminal/TerminalFactory.ts:487-496` (uncommitted)
Severity: SUGGEST / HIGH / P4 — Agent: frontend
Evidence: Every `createTerminal` call schedules `setTimeout(0, fitTerminal)`. For split-pane children, the container is still detached/0×0 at that point — measure-then-resize sends a stale resize IPC to the extension before `renderTabSplitTree`'s `requestAnimationFrame` callback fires the correct fit.
Impact: Extra resize IPC traffic + transient 1×1 PTY width per split child on reload.
Fix: Gate the zero-delay fit: `if (!options?.isSplitPane) setTimeout(() => this.fitTerminal(instance), 0)` — let `debouncedFitAllLeaves` own split-pane sizing.

**[S3] `SessionStorage.bufferFile*` throw semantics are asymmetric across read vs write**
File: `src/session/SessionStorage.ts:75-128`
Severity: SUGGEST / HIGH / P5 — Agent: data-security
Evidence: `readBufferFile` and `unlinkBufferFile` swallow `assertSafeSessionId` rejections (no-op + warn). `writeBufferFileSync`, `writeBufferFileAsync`, and `bufferFileRelativePath` let the throw propagate. Current call sites all wrap writes in try/catch so the asymmetry is benign now, but a future caller without that wrap would crash on an unsafe id.
Impact: Latent footgun — defense-in-depth pattern is non-uniform.
Fix: Either symmetric no-op-on-unsafe behavior for all entry points, or a single `safeBufferFilePath(id): string | null` helper that all consumers null-check.

---

## Verification Questions / Responses

| Q | Agent | Response |
|---|---|---|
| Was B2 fix complete for restored exited sessions? | logic + oracle | **No** — no-mirror sessions skip both `resetMirror` and the immediate flush → buffer file persists. Materialized as [B1]. |
| Does `_persistGeneration` cover per-session destroy? | data-security + logic + oracle | **No** — only `setRestoreEnabled` bumps it. Race window between `writeBufferFileAsync` and index assignment. Materialized as [W3]. |
| Does the W7 fix close all paths writing to globalStorageUri in no-folder windows? | data-security | **No** — runtime toggle handler at extension.ts:497-499 bypasses the activate-time guard. Materialized as [W2]. |
| Does eviction preserve split-pane group atomicity end-to-end? | contracts + oracle | **Partial** — Step 4 (count cap) works. Steps 1-2 (age + size) still per-entry. Materialized as [W1]. |
| Is the W4 fix robust against init-retry race? | frontend | **No** — `restoreFromSnapshot` can land before `init` on retry. Materialized as [W4]. |
| Hydrate ordering, W1 corrupted-vs-absent, W10 isSplitPane required, W3 sync dispose, W5 per-tab debounce, W6 README, W8 path traversal | various | **All verified-fixed.** |

---

## Cross-round filter

Round-1 findings carrying forward:
- B1 → SUGGEST [S1] (downgraded; sync path is by-design limit)
- B2 → BLOCK [B1] (privacy contract incomplete for restored exited)
- B4 → WARN [W1] (rootTabId end-to-end; eviction step 1 incomplete)
- W7 → WARN [W2] (runtime toggle bypasses guard)
- W9 → WARN [W3] (per-session destroy race still open)

Round-1 findings closed:
- B3, W1, W2, W3, W4, W5, W6, W8, W10 — VERIFIED-FIXED across multiple reviewers.

New (round-2 originating):
- [W4] init/restore postMessage ordering on retry path
- [S2] `setTimeout(0)` fit for split-pane children
- [S3] asymmetric throw semantics in SessionStorage

---

## Session IDs (round-2 agents)

- data-security: `ad7dd99d51fc93754`
- logic: `a6ca9d72bfad2f7a2`
- contracts: `a4ec819413066a6ca`
- frontend: `a29b8a4ef84342688`
- oracle: `a9fa08e7388da5bc7`

Resume via `SendMessage(to: "review-restore-terminal-sessions-{agent}")` for round-3 if needed.

## Notes

- All 5 agents stayed on-script (review-only). The off-script logic-edit incident from round-1 did not recur.
- The 3 fixes the off-script round-1 logic agent applied (`_persistGeneration` race guard, partial-index recovery, restore-priority shell/args/cwd) are confirmed preserved across the refactor by oracle.
- Test status: 1295/1295 passing, typecheck clean. Biome lint OOMs (environmental — not addressed).
- The uncommitted working tree contains net-new source files (`TerminalPanelSerializer.ts`, `SessionSnapshot.ts`, `restoreDivider.ts`, additional test files) that are part of this change but were never committed. Oracle spot-checked them and found no obvious issue.
