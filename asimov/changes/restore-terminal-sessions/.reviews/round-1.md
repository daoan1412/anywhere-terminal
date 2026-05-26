# Review Round 1 — restore-terminal-sessions

**Date**: 2026-05-26
**Reviewable lines**: ~1.8K (large change — split across 15+ production files)
**Agents spawned**: data-security, logic, contracts, frontend, oracle (additional perspective)

## Verdict: **BLOCK**

3 BLOCK-level items (Oracle MUST-FIX 1/2/3) + 1 contracts BLOCK + multiple WARN.

---

## Findings

### BLOCK

**[B1] Headless mirror serialized before xterm processes writes**
File: `src/session/SessionManager.ts:1607-1625` + `:413-420` + `:1335-1357` + `:578-582`
Severity: BLOCK / HIGH / P1 — Agent: oracle
Evidence: `@xterm/headless` `write()` is asynchronous (per xterm-headless `.d.ts`). The code writes to the mirror without using the callback, then immediately calls `serializeAddon.serialize()` (and even on the deactivate's "sync" flush path). Restored buffers are seeded the same way (`createSession` line 578).
Impact: Snapshots can capture a buffer in an indeterminate state — random tail bytes missing. Sync deactivate "durability" is a lie if the buffer is stale at serialize time.
Fix: Track an in-flight write barrier per session; flushPending and flushSnapshotsSync must await a `headless.write(data, cb)` callback before serialize.
Status: **pending**

**[B2] `clearScrollback` does NOT clear the headless mirror or the persisted snapshot**
File: `src/session/SessionManager.ts:838-845` (vs `:396-420`)
Severity: BLOCK / HIGH / P1 — Agent: oracle
Evidence: Cmd+K and ctx-clear commands clear `scrollbackCache` only. The next snapshot is regenerated from `session.headless` which still holds the cleared content. After restart, the user sees content they explicitly cleared.
Impact: Privacy/security — user deliberately clears sensitive output, then a restart resurrects it. Worse: the README documents clear as a user affordance but doesn't mention it's NOT a privacy boundary for restore.
Fix: `clearScrollback` must call `session.headless?.reset?.()` (or equivalent), schedule an immediate persist (writing the now-empty buffer), AND remove any pending pre-clear snapshot.
Status: **pending**

**[B3] Restore-from-snapshot does NOT pause PTY forwarding until replay completes**
File: `src/session/SessionManager.ts:500-507` + `:588-594`, `src/session/OutputBuffer.ts:159-164`, `src/providers/TerminalViewProvider.ts:615-641`, `src/providers/TerminalEditorProvider.ts:632-658`
Severity: BLOCK / HIGH / P2 — Agent: oracle
Evidence: Spec `specs/cross-restart-session-restore/spec.md:70-79` says "resize → write serializedBuffer → write divider → DOM attach → begin PTY forwarding". Code spawns the PTY immediately in `createSession`, wires `pty.onData` → `OutputBuffer.append` (which can flush after 8ms), THEN posts `init` and `restoreFromSnapshot`. The fresh shell's first prompt can land before the divider.
Impact: Visual collision between fresh-PTY prompt and restored buffer. Violates spec.
Fix: Pause output for the restored view in `createSession({restoreFrom})`; `onReady` resumes only after all snapshot replays are posted. Alternatively defer PTY spawn until webview ack.

**[B4] Contracts: Split-pane snapshots have wrong `rootTabId` and aren't evicted as a group**
File: `src/session/SessionManager.ts:439` + `src/session/sessionSnapshotEviction.ts:35`
Severity: BLOCK / HIGH / P1 — Agent: contracts
Evidence: `generateSnapshotMetadata` writes `rootTabId: session.id` for every session, including split children — they should reference the root. Eviction caps per-entry (20 newest individual sessions), not by root-group; a split tab can be partially evicted leaving an orphan layout the webview prunes.
Impact: Restored splits can lose a child pane silently; spec scenario "both index entries SHALL survive eviction together" violated.
Fix: Track real root tab id on `TerminalSession`; populate `rootTabId` accordingly; teach `evictIndex` to keep/drop split groups atomically.

### WARN

**[W1] Index-version-mismatch silently rebuilds v1 records from buffer files**
File: `src/session/SessionManager.ts:1411-1412 + 1437`
Severity: WARN / HIGH / P2 — Agent: contracts
Evidence: `index.version !== 1` causes `incoming = {}`, then the index-lost fallback synthesizes new v1 entries from disk. Spec says unsupported versions should be discarded.
Impact: A future v2 schema, or downgrade scenario, silently degrades to fake v1 entries.
Fix: Distinguish "index absent" from "index unsupported version"; only fall back when truly absent.

**[W2] Hydrate orphan-fallback ignores live editor panels**
File: `src/session/SessionManager.ts:1443-1463` + `src/extension.ts:50-54`
Severity: WARN / HIGH / P2 — Agents: contracts + oracle
Evidence: `hydrateFromSnapshots` runs BEFORE `hydrateLivePanels`. Fallback hard-codes `viewLocation: "sidebar"` and never sets `panelId`. Spec mandates using live-panels record when available.
Impact: Torn-deactivate flush moves editor terminals to sidebar.
Fix: Hydrate live panels first (or pass into hydrate), map orphan sessionIds back to panelIds.

**[W3] `dispose()` doesn't synchronously destroy — relies on operationQueue**
File: `src/session/SessionManager.ts:1058-1096` + `:1017-1036`
Severity: WARN / HIGH / P3 — Agent: oracle
Evidence: Spec "Synchronous cleanup of pending destroys" requires synchronous `destroyAllForView`. Current code queues via the async `operationQueue`. dispose then immediately kills PTYs and clears maps — bypassing `cleanupSession` (which is where headless/SerializeAddon dispose lives).
Impact: SerializeAddon leak on shutdown; queued work runs against empty maps.
Fix: dispose calls cleanupSession directly per session, then clears the queue.

**[W4] Split-pane refit clobbered by `onRestoreFromSnapshot` resize**
File: `src/webview/main.ts:519-523` + `:441`
Severity: WARN / HIGH / P2 — Agent: frontend
Evidence: `handleInit` schedules `debouncedFitAllLeaves` (100ms timer) inside RAF. `onRestoreFromSnapshot` arrives before that, runs `terminal.resize(snap.cols, snap.rows)` (stale persisted dims). PTY data written during the 100ms gap word-wraps at the wrong width — and xterm doesn't reflow scrollback after the corrective refit.
Impact: Permanent mis-wrap in scrollback for the first 100ms after Cmd+R.
Fix: Skip the snapshot-resize on the open-already path (only deferOpen needs it).

**[W5] `debouncedFitAllLeaves` overwrites prior tabId with single shared timer**
File: `src/webview/resize/ResizeCoordinator.ts:106`
Severity: WARN / HIGH / P3 — Agent: frontend
Evidence: One `splitFitTimeout` slot. Loop calls `debouncedFitAllLeaves(tabId)` per split root — each call cancels prior, only last `tabId` actually fits.
Impact: With 2+ split roots restored, all but the last pane stay 0×0 blank.
Fix: Single non-debounced fit pass for the init bootstrap path, or `fitAllSplitRoots(tabIds[])`.

**[W6] Privacy: scrollback contains secrets and is persisted plaintext, with no user warning**
File: `package.json:79` + `README.md:70,79`
Severity: WARN / HIGH / P3 — Agent: data-security
Evidence: Setting description says "scrollback and metadata" but does not warn that any echoed token / `.env` / API key / SSH passphrase lands in `<storageUri>/snapshots/*.snapshot.ans` in plaintext, surviving up to 7 days, default-on. README "Persistence" section omits content sensitivity.
Impact: Real privacy risk; default-on amplifies. Backup tools, indexers, other extensions can harvest.
Fix: (a) update setting description + README; (b) consider default-false OR first-run notice; (c) optional: scrub well-known token patterns pre-write.

**[W7] `globalStorageUri` fallback breaks documented workspace-scoped guarantee**
File: `src/extension.ts:40`
Severity: WARN / HIGH / P3 — Agent: data-security
Evidence: When no workspace folder is open, `storageUri` is undefined → falls back to `globalStorageUri` (single path across all VS Code launches). README claims "Persistence is workspace-scoped" — false for no-folder windows. Worse: hydrate orphan fallback (Step 3) reconstructs entries from those global files, leaking across no-folder windows.
Impact: Cross-window data leak in no-workspace mode.
Fix: When no workspace, either refuse to persist (most safe) or document explicitly.

**[W8] `sessionId` path-traversal via persisted state**
File: `src/session/SessionStorage.ts:56-58` + consumers
Severity: WARN / MEDIUM / P4 — Agent: data-security
Evidence: `path.join(snapshotsDir, sessionId + ".snapshot.ans")`. Fresh sessions use crypto.randomUUID(). Hydrate sources sessionId from workspaceState (another extension can write `state.vscdb`). A poisoned `sessionId: "../../foo"` flows into read/unlink path; `cleanupSession` could unlink arbitrary `*.snapshot.ans` files.
Impact: Defense-in-depth — semi-trusted threat model.
Fix: One-line check in `bufferFilePath`: `if (path.basename(sessionId) !== sessionId) throw`.

**[W9] `flushPending` / `cleanupSession` race resurrects ghost index entries**
File: `src/session/SessionManager.ts:1280-1322` + `:1178-1191`
Severity: WARN / MEDIUM / P4 — Agent: data-security
Evidence: `flushPending` awaits `writeBufferFileAsync` then sets `_snapshotIndex[id]`. If `cleanupSession(id)` runs between the await and the assignment, the index entry is resurrected and the buffer file is leaked.
Impact: Ghost restore for a session the user killed mid-debounce.
Fix: After await, re-check `this.sessions.has(id)`; if not, drop + unlink.

**[W10] `InitMessage.tabs[i].isSplitPane` optional in IPC type vs required in spec**
File: `src/types/messages.ts:386`
Severity: WARN / HIGH / P3 — Agent: contracts
Evidence: Spec mandates every init tab carries `isSplitPane: boolean`. Type declares it optional; sidebar/panel/editor providers omit it for root tabs (because `getTabsForView` returns `{...,isActive}` without splits, and `getAllSessionsForView` returns the split-aware list). Webview defends with `=== true`.
Impact: Contract not locked at compile time.
Fix: Make the field required; emit `false` explicitly for roots.

### SUGGEST

- **[S1]** Hydrate fallback `terminalNumber: 0` is masked by `reserveNumber`'s `> 0` guard — add a comment so future refactors don't tighten the guard. (`SessionManager.ts:1443-1463`)
- **[S2]** `panelId` invariant on `SessionSnapshotMetadata` is convention-only — use a discriminated type or validate during hydrate. (`SessionSnapshot.ts:11`)
- **[S3]** Persisted `bufferFile` field is dead weight — never read on hydrate (path is reconstructed). Either validate it or remove. (`SessionSnapshot.ts`)
- **[S4]** Deferred-terminal fallback in `onRestoreFromSnapshot` uses UUID as tab name. Add `tabName` to `RestoreFromSnapshotMessage`. (`webview/main.ts:430-437`)

---

## Session IDs
- data-security: `ac0a7e92e65b567ec`
- logic: `a58c06f6620f28b04` (note: this agent went off-script — made code edits instead of reporting; findings noted in its output)
- contracts: `adb992479d057be3d`
- frontend: `ae136daab04672fab`
- oracle: `ac1ec3cfa5ea56585`

## Notes
The logic-review agent edited code rather than only reporting findings. Those edits are not yet triaged — must be reviewed by the user before keep/revert decision.
