# Review: enhance-vault-sessions — Round 1

- **Date:** 2026-07-07
- **Reviewable lines:** ~1290 (1195 tracked insertions + ~98 new registry) across 22 production files
- **Agents spawned:** data-security, logic, contracts, frontend, performance (all 5)
- **Agents skipped:** none
- **Verdict:** WARN
- **Counts:** BLOCK 0 · WARN 8 · SUGGEST 0 shown (4 suppressed: 1 WARN-P4 + 3 SUGGEST)

Intent (proposal/design): make the AI Vault live and richer without mutating agent stores — (D1) rename via a read-only sidecar Memento registry, (D2/D3/D6) per-message model+tokens and a git-branch chip, (D4) FS-watcher-driven auto-refresh, (D5) live-follow the previewed session. Implementation tracks the design doc closely; no major design gap. Security posture (read-only sidecar, glob-safe id guard, defensive Memento parse, overlay-never-persisted-to-cache) verified clean by data-security.

## Findings

### [W1] Auto-refresh amplification: full cache re-persist + full list push + full DOM rebuild every ~300ms during an active session
- severity: WARN · confidence: HIGH · priority: P2 · agent: performance (+chair, +frontend scroll-anchor nuance)
- file: src/providers/TerminalViewProvider.ts:549-570 → src/vault/VaultService.ts:238,287 → src/webview/vault/VaultPanel.ts:680-723
- evidence: Each coalesced store-write burst runs `refresh()` which sorts the full merged list, serializes and writes the ENTIRE cache doc to disk (`cacheStore.save(doc)`), pushes the full list, and the webview does `listEl.replaceChildren()` rebuilding every row — for a one-message delta, repeating ~1/300ms for the whole duration of an active session. The Claude `files` reader also `stat`s every session file (O(total historical sessions), not bounded by ROW_LIMIT=500) to find the one change. Separately, `renderList` restores raw `scrollTop` only (VaultPanel.ts:680/723), so if rows are inserted/reordered above the viewport the same pixel offset shows a different row (visible jump) even though selection/open-preview survive.
- impact: Sustained disk-write + full list-DOM rebuild amplification during active coding; stat-enumeration grows with lifetime session count; possible viewport jump on auto-refresh.
- fix: Push the changed entry as a delta and patch that one row instead of full re-persist + `replaceChildren()`; decouple the full-doc persist from the per-burst push; anchor scroll on the first visible row id + offset rather than raw `scrollTop`.
- status: deferred · triage: accepted (deferred) — legitimate cost concern, but non-blocking (WARN) and the proposed fix is an architectural refactor of the cache-persist + list-push + DOM-diff path, too large for a safe pre-archive change in fastlane. Already bounded by the 300ms debounce + stale-seq coalescing. Filed as a follow-up; not fixing this round.

### [W2] Recursive `**/*.jsonl` store watchers uncapped on the total-history axis, armed ×2 (sidebar + panel)
- severity: WARN · confidence: HIGH · priority: P2 · agent: performance (+chair)
- file: src/vault/VaultService.ts:365-373 (getStoreWatchTargets); src/providers/TerminalViewProvider.ts:527-547 (armVaultStoreWatchers); src/providers/fsWatcherPool.ts (subscribePattern)
- evidence: Watch targets are recursive `**/*.jsonl` over `~/.claude/projects` and `~/.codex/sessions` — growth axis = total historical session files/dirs (neither store is pruned), with no recent-activity window/exclusion. A recursive non-workspace watcher does an initial subtree crawl and holds OS watch resources scaling with tree size, and ANY `.jsonl` write anywhere in the tree (other projects/background sessions) fires the debounced full refresh (amplifying W1). Each of the two provider instances arms its own 4 targets → 2× the recursive watchers over identical trees. `subscribePattern` watchers are also not counted against the pool's SOFT_CAP (separate `patternEntries` set) — bounded here (4+≤2) but uncounted.
- impact: Watcher setup/resource cost and spurious refresh triggers grow with months of accumulated sessions; fixed 2× redundancy.
- fix: Scope the watch to a recent-activity subtree or to resolved recent session files rather than `**`; share one watcher set across the two providers.
- status: deferred · triage: accepted (deferred) — real growth-axis concern, non-blocking (WARN). Recent-activity scoping needs a new bounding design (which subtree/window) and sharing one watcher set across the two provider instances is a lifecycle refactor; both exceed a safe pre-archive edit. Watcher count is bounded (≤8) today. Filed as a follow-up.

### [W3] Live-follow tail fingerprint can freeze the preview during in-place streaming append
- severity: WARN · confidence: MEDIUM · priority: P2 · agent: frontend
- file: src/webview/vault/PreviewController.ts:536-551 (tailFingerprint/itemTail)
- evidence: `itemTail` fingerprints only `text.slice(0, 48)` plus the timeline length. When a reader assembles one assistant message's text in place across re-reads (OpenCode message parts; final-message assembly) the timeline length is unchanged and, once the first 48 chars are stable, the fingerprint stops changing — so `handleFollowUpdate` no-ops and the visible transcript appears frozen mid-message until a NEW timeline item appears.
- impact: Live-follow looks frozen during a long streaming message; self-heals when the next item lands.
- fix: Add text length and/or a suffix/cheap hash of the full tail text to the fingerprint (e.g. `kind|role|ts|len|first+last slice`).
- status: fixed · triage: accepted — directly degrades live-follow (feature 4). Fixed in PreviewController.itemTail: fingerprint is now `kind|role|ts|len|first-32|last-24`, so in-place text growth changes it. Verified via existing suite + manual-verify in task 4_4 Acceptance.

### [W4] Inline-rename cancel (Esc) leaves the list DOM stale until the next event
- severity: WARN · confidence: MEDIUM · priority: P2 · agent: frontend (+chair, +logic)
- file: src/webview/vault/VaultPanel.ts:593-599 (render deferral) + 760-772 (beginRename/onDone)
- evidence: While a rename editor is open, `render()` defers the rebuild via `lastRenderSig = null; return` (entries ARE stored, only paint deferred). Commit round-trips a fresh push → repaint. But `onDone` only clears `renamingEntryId`; on Esc-cancel there is no host round-trip, so no render is triggered — if an auto-refresh push arrived during the edit, the list DOM stays stale (despite fresh `this.entries`) until the next unrelated event.
- impact: Transient stale list after cancelling a rename that overlapped an auto-refresh; low frequency, self-heals on next push.
- fix: After clearing `renamingEntryId`, if `lastRenderSig === null` call `renderList()` so cancel/no-op commit repaints from fresh entries.
- status: fixed · triage: accepted — correctness (feature 1). Fixed in VaultPanel.beginRename onDone: after clearing `renamingEntryId`, repaint when `lastRenderSig === null`. Full suite green.

### [W5] Live-follow full preview-body rebuild per change instead of appending the delta
- severity: WARN · confidence: MEDIUM · priority: P3 · agent: performance (+chair)
- file: src/webview/vault/PreviewController.ts:335-365 → :364 renderPreviewDetail (renderTimelineInto over the whole timeline)
- evidence: On every follow burst that passes the fingerprint guard, `renderPreviewDetail` tears down and rebuilds the entire `.vault-preview-body` (up to MAX_TIMELINE_ITEMS=400 nodes) for a one-message append. Cost is bounded (400 cap + fingerprint no-op + bounded `getDetail`) but not proportionate to the delta.
- impact: Full DOM teardown/rebuild per ~400ms append while following an active session.
- fix: Append the new tail item(s) to existing DOM on the follow path instead of a full re-render.
- status: deferred · triage: accepted (deferred) — non-blocking (WARN·P3), bounded by the 400-item cap + fingerprint no-op + bounded getDetail. Incremental-append needs a DOM-diff/append path in renderPreviewDetail (shared with the normal render); too large for a safe pre-archive edit. Filed as a follow-up.

### [W6] `VaultMessageTokens.input`/`output` typed optional but always co-emitted
- severity: WARN · confidence: HIGH · priority: P3 · agent: contracts
- file: src/vault/types.ts:171 (interface); emit sites detail.ts:657, codexReader.ts:868, opencodeReader.ts:440
- evidence: All three readers build `tokens` only when usage exists, and every construction sets BOTH `input` and `output` unconditionally; the type doc itself states a message with no usage carries no `tokens` at all. So when `tokens` is present, `input`/`output` are always present, yet the type marks them `?`.
- impact: Optional markers don't model a real state; every consumer must handle an `undefined` that never occurs and the type miscommunicates the invariant.
- fix: Make `input: number; output: number` required; keep only `contextWindow?: number` optional (Codex-only). Non-breaking — all producers already satisfy it.
- status: fixed · triage: accepted — verified all three emit sites (detail.ts, codexReader.ts, opencodeReader.ts) always co-emit input+output. Made both required in VaultMessageTokens; contextWindow stays optional. check-types clean.

### [W7] OpenCode per-message `output` excludes reasoning tokens; Claude/Codex include them (cross-reader divergence)
- severity: WARN · confidence: MEDIUM · priority: P3 · agent: contracts
- file: src/vault/readers/opencodeReader.ts:440-442
- evidence: OpenCode records `reasoning` separately from `output` (the list accumulator at :438 adds `output + reasoning` separately — proving they don't overlap), but per-message `msgTokens.output = num(tokens.output)` drops reasoning. Claude (`output_tokens`) and Codex (`last.output_tokens`) already subsume generated reasoning. The single `VaultMessageTokens` contract defines `output` = "generated tokens" with one semantic.
- impact: An OpenCode assistant turn with reasoning under-reports `output` vs the equivalent Claude/Codex turn; per-message token UI is inconsistent across agents.
- fix: Either add reasoning to OpenCode's `output` (`num(tokens.output) + num(tokens.reasoning)`) or document `output` as text-only and normalize the others — pick one and state it in the type doc.
- status: fixed · triage: accepted — chose the "reasoning folded into output" semantic (matches Claude/Codex). OpenCode `output = output + reasoning`; VaultMessageTokens doc now states output subsumes reasoning across all agents. The existing session-total accumulator already treated output/reasoning as disjoint, confirming no double-count. Updated opencodeReader.detail.test.ts expectation (20→25).

### [W8] Codex per-message token backfill misattributes tokens on a tool-only/interrupted turn; stale `currentModel`
- severity: WARN · confidence: MEDIUM · priority: P3 · agent: logic (+chair)
- file: src/vault/readers/codexReader.ts:846-876 (lastAssistantItem set at :852, backfill at :858-869)
- evidence: `lastAssistantItem` is reassigned only inside the `agent_message` branch and only when the message has text; the later `token_count` backfills `lastAssistantItem.tokens` by reference. This assumes a strict `agent_message → token_count` 1:1 ordering. A turn that emits no assistant text before its `token_count` (tool-only, interrupted/aborted, or empty/filtered) leaves the reference on the PRIOR text turn, so that turn's usage overwrites the prior message's token badge. Related: `currentModel` persists across turns until the next `turn_context`, so a mid-session model change without a re-emitted `turn_context` stamps a stale model on later messages.
- impact: Display-only mis-attribution of the per-message token/context badge (and possibly model) to the wrong assistant turn; source data untouched, no crash.
- fix: Correlate usage to its turn explicitly (track the most-recent assistant item created since the last `token_count` and reset after each backfill, or key on a turn/response id) instead of "last text message".
- status: fixed (token part) · triage: accepted (token misattribution) / rebutted (stale currentModel sub-point) — Fixed the token misattribution: `lastAssistantItem` is now reset to undefined after each backfill, so a later token_count with no intervening agent_message can't overwrite the prior turn's badge. Added regression test in codexReader.detail.test.ts ("does not re-attribute a later token_count (tool-only turn)"). Rebut the stale-`currentModel` sub-point: Codex emits a `turn_context` at the start of every turn (the reader keys model off it), so `currentModel` is refreshed per turn; a mid-session model change without a re-emitted turn_context is not a real Codex rollout state. Display-only, no data risk.

## Suppressed (priority overflow — max 8)
- [S-perf] WARN·P4 — Codex/OpenCode follow watches the SHARED store DB (`state_5.sqlite*`/`opencode.db*`), so any session's write wakes a bounded `getDetail` re-read for the ONE previewed session (guarded by fingerprint → no re-render). — src/vault/VaultService.ts:397-403
- [S-logic] SUGGEST·P4 — `handleFollowUpdate` scrolled-up + shorter-window (`!atBottom && newCount<prevCount`) early-return silently drops new tail messages (no pill raised, no re-fetch on scroll-down); equal-length window shift jumps viewport; pill count `+= delta>0?delta:1` undercounts a multi-message equal-length shift. — src/webview/vault/PreviewController.ts:360-380
- [S-front] SUGGEST·P4 — a renamed session shows its `customName` but the list query still matches only `title`/cwd/agent, so it isn't searchable by the visible name. — src/webview/vault/vaultListView.ts:66
- [S-contract] SUGGEST·P4 — per-message `model` id format inconsistent: OpenCode emits `provider/model`, Claude/Codex emit the bare id. — src/vault/readers/opencodeReader.ts:432

## Support code (Phase 2.5, inline)
- New tests (VaultCustomNameRegistry.test.ts, VaultService.customName.test.ts, VaultService.watchTargets.test.ts) cover set/get/trim/cap/clear, malformed-persist rejection, overlay-not-in-cache, the glob-injection guard (`codex:../../*` and `codex:a/b` → []), and store/session watch-target resolution. Reader detail tests extended for per-message model/tokens. No `.only`/`.skip`, async tests awaited, no PII/secret fixtures. OK.

## Triage (2026-07-07, fastlane)
- **0 BLOCK** → review-loop exit condition met; no re-review round needed.
- **Fixed this round (5):** W3 (fingerprint), W4 (rename-cancel repaint), W6 (required token fields), W7 (reasoning folded into output), W8 (codex token misattribution + regression test). Stale-`currentModel` sub-point of W8 rebutted (turn_context is per-turn in Codex).
- **Accepted but deferred (3):** W1, W2, W5 — all WARN performance/scale refactors, non-blocking, each bounded today (300ms debounce, ≤8 watchers, 400-item cap). Deferred as follow-ups; too large for a safe pre-archive fastlane edit.
- **Suppressed 4 (S-*):** not triaged this round (all P4 SUGGEST + 1 WARN·P4, non-blocking).
- Verify Gate re-run after fixes: check-types clean; vitest 2202 pass / 0 fail.

## Sub-agents spawned
- data-security: completed — no findings (verified glob-safe id guard, recursive-glob scope, defensive Memento parse, overlay-not-persisted-to-cache)
- logic: completed — 1 WARN (W8) + 1 SUGGEST (suppressed); watcher/timer release + `_vaultRefreshSeq`/`_vaultFollowSeq` guards verified safe
- contracts: completed — 2 WARN (W6, W7) + 1 SUGGEST (suppressed); message union wired end-to-end, additive-safe, D1 cache invariant upheld
- frontend: completed — 3 WARN (W3, W4, part of W1) + 1 SUGGEST (suppressed)
- performance: completed — 4 WARN (W1, W2, W5, S-perf); no BLOCK (incremental cached refresh + bounded readers hold)
