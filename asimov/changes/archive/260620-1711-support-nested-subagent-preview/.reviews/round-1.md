# Review round 1 — support-nested-subagent-preview

- Date: 2026-06-20
- Reviewable lines: ~270 added/modified in reviewable src files (565 total incl. tests)
- Verdict: **WARN**
- Counts: Blocking 0 | Warnings 2 | Suggestions 2 (1 suppressed)
- Agents spawned: data-security, logic, contracts, frontend, performance
- Agents skipped: none

## Intent

Claude Code (v2.1.172+) lets a subagent spawn its own subagents (depth ≤ 5). The vault/terminal
preview previously flattened nested subagents under the root by description. This change
reconstructs the true subagent tree from each subagent's on-disk `meta.toolUseId` (the spawning
`tool_use` id): a whole-stream `createSpawnIdCollector` gathers Agent/Task spawn ids; `scopeDirectChildren`
keeps only stubs whose `toolUseId` was spawned in this transcript; the classifier binds those stubs by
id (legacy stubs without `toolUseId` keep description matching). The terminal popup gains real lazy
nested drill-down via a new host resolver `resolveSubagentDetailByEntryId(entryId)` and an `entryId`
extension to the existing `requestSubagentPreview`/`subagentPreviewResponse` round-trip.

## Findings

### [W1] Nested drill-down state machine is keyed by `entryId` alone — sibling-stranding + stale-open contamination
- Severity: WARN | Confidence: HIGH | Priority: P2 | Agent: logic + frontend (corroborated) + chair
- File: `src/webview/links/SubagentPreviewPopup.ts:84-93` (collapse), `:190-204` (populateNested), `:206-227` (handleNestedResponse)
- Evidence: `pendingNested` is `Map<entryId, Set<HTMLElement>>`. (a) **Sibling stranding** (HIGH): two simultaneously-open blocks rendering the same child `entryId` X share one pending Set; collapsing one runs `this.pendingNested.delete(entryId)` — deleting the whole Set — so the in-flight response is dropped and the still-open sibling block hangs on `loadingBody()` forever (detail never cached, re-expand won't recover). (b) **Stale-open contamination** (MEDIUM): routing ignores `requestId` when `entryId` is present (`TerminalFactory.fillSubagentPreview` → `handleNestedResponse`); after open-replace + re-expand of the same `entryId`, an older response can satisfy/delete the current pending container, causing the newer response to be dropped. `open()` calls `dispose()` (clears `pendingNested`), which defuses the common case, so harm requires re-expanding the identical child in a re-opened popup — and the rendered content is the same child file either way, so impact is low.
- Impact: A still-open sibling drill-down stuck on a permanent spinner (narrow: same child `entryId` in two open blocks); at worst a stale/error reply briefly shown for a re-opened identical block. No data corruption. This is a faithful mirror of the existing `PreviewController.ts:118` pattern.
- Fix: Discriminate pending entries per container (and/or per nested `requestId`/open-generation). On collapse remove only the collapsing block's body and delete the key only when its Set empties; in `handleNestedResponse` render to whatever containers remain. Apply the same fix to `PreviewController` to keep them in sync.

### [W2] Every nested-subagent open re-lists the whole session's subagent set — O(N) reads per node, O(N²) to drill a tree, no host cache
- Severity: WARN | Confidence: HIGH | Priority: P3 | Agent: performance + chair
- File: `src/vault/readers/claudeChildren.ts:53-58` (Promise.all adds `listClaudeSubagentStubs(parentId)` per open); cost body `:487-501`
- Growth axis: **subagents-per-session** (sibling count) — NOT bounded by depth ≤ 5 (depth bounds tree height, not subagent count).
- Evidence: `readClaudeSubagentDetail` now calls `listClaudeSubagentStubs(parentId)` on EVERY subagent open. That does `readdir` + a serial `for` loop of `readSubagentMeta` (readFile+JSON.parse) and `readFirstUserRecord` (stream until first user record) for EVERY sibling subagent (≈2×N file opens, serialized by await), then `scopeDirectChildren` discards all but the direct children. The host keeps no read cache, so each popup expand fires a fresh `requestSubagentPreview{entryId}` → re-reads all N subagents; drilling K opened nodes ≈ O(N²) small file reads. The webview `nestedDetails` cache only spares re-open of the same popup.
- Impact: Invisible on today's small sessions; surfaces as interactive expand latency as subagent counts grow (the intent explicitly targets many siblings + depth-5 trees).
- Fix: Compute `listClaudeSubagentStubs(parentId)` once per session and thread/cache it for nested reads instead of re-listing per node (memoize keyed on `(parentId, dir mtime)`); `Promise.all` the per-sibling meta/first-record reads to drop the serial-await wall.

### [S1] Degraded nested-expand (no `postMessage`) leaves a permanent spinner instead of an inert state
- Severity: SUGGEST | Confidence: HIGH | Priority: P4 | Agent: contracts
- File: `src/webview/links/SubagentPreviewPopup.ts` (populateNested, `if (!this.postMessage) return;` after `body.replaceChildren(loadingBody())`)
- Evidence: When `postMessage` is absent (legacy caller/test), the block sets `loadingBody()` then returns with no fetch — a spinner that never resolves. Contract says "expand is a no-op" but the rendered state reads as a hang.
- Fix: Render an inert empty/placeholder (e.g. `emptyState(...)`) or leave prior content in the no-channel branch.

### [S2] Nested-fetch `requestId` is generated but dead on the response path — document the entryId-keyed routing
- Severity: SUGGEST | Confidence: MEDIUM | Priority: P4 | Agent: contracts
- File: `src/webview/links/SubagentPreviewPopup.ts` (`requestId: subagent-nested-${++this.nestedReqSeq}`)
- Evidence: Nested replies route entirely by `entryId`; the echoed `requestId` is never consulted on the nested path (top-level path stale-guards by `requestId`). A maintainer may assume nested stale-guarding by `requestId`. Tying the fix for W1's stale-contamination to a real nested `requestId`/generation would also make this key load-bearing.
- Fix: Comment that `requestId` is shape-required and nested routing is `entryId`-keyed — or adopt it as the discriminator per W1's fix.

### Suppressed (priority overflow / pre-existing)
- Sibling-stranding edge also exists in `PreviewController.ts:118` (mirrored source) — same root cause as W1, fix both together (noted in W1).

## Verification question outcomes
- **Security (data-security, clean):** `resolveSubagentDetailByEntryId` is fully guarded — `parseEntryId` → claude-only → `parseClaudeChildId` → `isSafeSessionId` (rejects `:`/`/`/`..`/absolute) + `path.relative` containment in `resolveClaudeSubagentPath`. `toolUseId` typed defensively; malformed meta cannot crash; echoing `entryId` leaks nothing (re-resolved by id, never trusted as path).
- **Logic:** Truncated-out spawn block does NOT lose a direct child — whole-stream collector keeps it scoped and `mergeUnmatchedStubs` surfaces it by timestamp. Mixed/legacy root cannot surface a grandchild (root collector is non-sidechain only). Cycle guard `renderingNested` correct.
- **Contracts:** Channel-reuse with additive-optional `entryId` is clean (mutually exclusive by presence, top-level reply never carries it). `toolUseId` legacy-compat sound — `== null` guards at all three consumers.
- **Performance:** spawn collector piggybacks the existing single stream pass (no extra I/O, negligible per-record cost, not redundant with the bounded-records classifier). The cost is W2's per-open session-wide re-listing.

## Verdict rationale
0 BLOCK, 2 WARN → **WARN**. No security, correctness-critical, or breaking-contract defect. Both warnings are real but narrow/scale-deferred quality issues; the security and legacy-compat surfaces are clean.

## Triage (author, 2026-06-20 — user-confirmed: "apply fixes, defer W1")

- **W1** — Status: **rebutted / deferred**. Real but narrow (needs the same child `entryId` open in two blocks; `dispose()` already defuses the open-replace race). It faithfully mirrors `PreviewController` — which design **D5 explicitly mandated** mirroring — so a correct fix must change the shared `PreviewTimelineBag` interface AND the vault panel, exceeding this change's appetite (M). Tracked as a follow-up to fix both surfaces (popup + panel) together; not a regression (pre-existing pattern).
- **W2** — Status: **partially accepted + partially rebutted**. ACCEPTED: parallelized the per-sibling meta/first-record reads in `listClaudeSubagentStubs` with `Promise.all` (claudeChildren.ts) — drops the serial-await wall on both the root read and every nested open. REBUTTED (host stub/detail cache): the reader is intentionally stateless per `vault-session-preview` → "Session detail IPC: *holding no detail cache and not re-listing the full index*". A memoized cache would contradict that spec decision; the O(K·N) drill cost is an accepted trade-off for statelessness, noted in design Data-Scale. Re-verified: tsc clean, 2151 tests pass.
- **S1** — Status: **accepted / fixed**. `populateNested` now renders an inert `emptyState` placeholder (not `loadingBody()`) when no `postMessage` channel is injected.
- **S2** — Status: **accepted / fixed (doc)**. Added a comment at the nested-request site noting `requestId` is shape-required and nested routing is `entryId`-keyed.

Follow-ups (out of this change): W1 per-container/generation discrimination in `SubagentPreviewPopup` + `PreviewController`; W2 single-list threading if a stateless-compatible approach is found.
