# Tasks: support-nested-subagent-preview

<!-- Builder context: every Claude subagent (any depth) is stored FLAT at
`<projects>/<projectDir>/<sessionId>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json`
= `{agentType, description, toolUseId}`. `toolUseId` is the `tool_use` id of the Agent/Task
call that spawned the subagent, and that call lives in the PARENT transcript (root or another
subagent). A real depth-2 probe session for manual checks: `a75b754c-beae-47c7-858b-fccd1045228e`
(OUTER agent-ae64670496020c053, INNER agent-a6c8b4b288e8ec71e). -->

## 1. Reader — reconstruct the subagent tree

- [x] 1_1 Thread `toolUseId` into the Claude child stub
  - **Deps**: none
  - **Refs**: specs/vault-session-preview/spec.md (Nested sub-sessions fold into the parent); design.md D1
  - **Scope**: src/vault/readers/detail.ts, src/vault/readers/claudeChildren.ts
  - **Acceptance**:
    - Outcome: `ClaudeChildStub` carries optional `toolUseId`, and `listClaudeSubagentStubs` populates it from each `agent-<id>.meta.json`'s `toolUseId` (omitted when absent).
    - Verify: unit src/vault/readers/claudeReader.detail.test.ts
  - **Plan**:
    1. Add `toolUseId?: string` to `ClaudeChildStub` (detail.ts:121).
    2. In `listClaudeSubagentStubs` (claudeChildren.ts:444) read `meta.toolUseId` (via `readSubagentMeta`, extend it to return `toolUseId`) into the stub.

- [x] 1_2 Match stubs by `toolUseId` (id-only) + merge-all unmatched + per-level `subagentCount`
  - **Deps**: 1_1
  - **Refs**: design.md D2, D4; specs/vault-session-preview/spec.md
  - **Scope**: src/vault/readers/detail.ts
  - **Acceptance**:
    - Outcome: in `classifyClaudeStyleEvents`, an `Agent`/`Task` `tool_use` whose `id` equals a stub's `toolUseId` consumes that stub at the call site. A stub WITH a `toolUseId` binds by id ONLY (never by description); description match (`matchStub`) applies ONLY to stubs WITHOUT a `toolUseId` (legacy). `mergeUnmatchedStubs` merges EVERY unmatched stub it received by timestamp (the reader has already scoped the list to this transcript's direct children — see 1_3/1_4 — so a `toolUseId` stub whose `Task` block was truncated out of the bounded records is still placed; classify does not re-scope). `stats.subagentCount` reflects the direct children embedded in THIS transcript, not the whole flat stub list.
    - Verify: unit src/vault/readers/detail.test.ts
  - **Plan**:
    1. In the `Task`/`Agent` block branch (detail.ts:579): if `block.id` equals a stub's `toolUseId`, consume that stub; else if the stub has no `toolUseId`, fall back to `matchStub(stubs, description, sub)`.
    2. Keep `mergeUnmatchedStubs` (detail.ts:650) merging ALL remaining stubs by timestamp (do NOT gate on `toolUseId`).
    3. Replace `subagentCount = max(spawnCalls, totalStubs)` (detail.ts:655) with the count of direct children placed in this transcript.

- [x] 1_3 Scope the root read to its direct children
  - **Deps**: 1_1, 1_2
  - **Refs**: design.md D2 + Architecture; src/vault/readers/claudeTeam.ts:108 (`teamContextCollector` whole-stream onRecord pattern)
  - **Scope**: src/vault/readers/claudeReader.ts, src/vault/readers/detail.ts
  - **Acceptance**:
    - Outcome: `readClaudeDetail` passes to classify only subagent stubs that are root's DIRECT children — those whose `toolUseId` appears as an `Agent`/`Task` `tool_use` id anywhere in the root's WHOLE stream (not just the head+tail bounded slice), plus any stub lacking `toolUseId` (legacy). The spawn-id collector counts ids from NON-`isSidechain` records only (matching classify's root view), so a mixed/older root file's sidechain `Task` ids do NOT surface nested children at root. A subagent spawned inside another subagent is omitted from the root timeline.
    - Verify: unit src/vault/readers/claudeReader.detail.test.ts
  - **Plan**:
    1. Add a spawn-id collector to the existing `onRecord` stream pass in `readClaudeDetail` (claudeReader.ts:206-220) that records every NON-`isSidechain` `Agent`/`Task` `tool_use` id across the whole file (mirror `teamContextCollector`).
    2. Filter `subStubs` to `{ stub: !stub.toolUseId || spawnIds.has(stub.toolUseId) }` before building `childStubs` (claudeReader.ts:224).

- [x] 1_4 Recurse: a subagent's detail embeds ITS direct children
  - **Deps**: 1_1, 1_2, 1_3
  - **Refs**: design.md D3; specs/vault-session-preview/spec.md (nested expandable, arbitrary depth)
  - **Scope**: src/vault/readers/claudeChildren.ts
  - **Acceptance**:
    - Outcome: `readClaudeSubagentDetail` discovers and embeds the subagent's own direct children — its returned `VaultSessionDetail.timeline` contains a `subagentSession` for each grandchild whose `toolUseId` is in this subagent's transcript; drilling into a grandchild resolves recursively via the same `<parentId>:subagent:<stem>` entryId scheme. Because a subagent file IS all-sidechain, spawn-id collection here counts ALL records (`includeSidechain: true`), unlike the root read.
    - Verify: unit src/vault/readers/claudeReader.detail.test.ts
  - **Plan**:
    1. In `readClaudeSubagentDetail` (claudeChildren.ts:33), fetch `listClaudeSubagentStubs(parentId)` and collect this subagent file's whole-stream spawn ids while streaming (all records, since the file is all-sidechain).
    2. Scope to direct children (same `toolUseId` rule as 1_3) and pass them as `childStubs` to `classifyClaudeStyleEvents` (keep `includeSidechain: true`).

## 2. Terminal popup — nested drill-down

- [x] 2_1 Extend `requestSubagentPreview` with an optional `entryId` (host)
  - **Deps**: 1_4
  - **Refs**: design.md D5; specs/terminal-subagent-preview/spec.md (Click opens the subagent preview popup)
  - **Scope**: src/types/messages.ts, src/providers/TerminalViewProvider.ts, src/providers/TerminalEditorProvider.ts
  - **Acceptance**:
    - Outcome: the `requestSubagentPreview` request MAY carry an optional `entryId`, and its response echoes that `entryId`. WHEN `entryId` is present, BOTH providers resolve it via `readClaudeDetail(entryId)` (containment-checked by id; no terminal/description matching) instead of the live-terminal lookup. WHEN absent, behavior is unchanged (live-terminal subagent resolution). No new message type is added; the panel's `requestVaultSessionDetail` channel is NOT touched.
    - Verify: unit src/providers/TerminalViewProvider.ts (existing provider test, or add one) — `none — covered by 2_2 webview test` if no provider unit harness exists
  - **Plan**:
    1. Add optional `entryId?: string` to the `requestSubagentPreview` request and its response shape in messages.ts.
    2. In each provider's `requestSubagentPreview` handler (TerminalEditorProvider.ts ~584, TerminalViewProvider.ts ~429), branch: `entryId` present → `readClaudeDetail(entryId)` and reply echoing `entryId`; else existing path.

- [x] 2_2 Replace the popup's flat bag with real nested drill-down (webview)
  - **Deps**: 2_1
  - **Refs**: design.md D5; src/webview/vault/PreviewController.ts:399-426 (`populateNested` reference); [[project_body_overlay_disposal]]
  - **Scope**: src/webview/links/SubagentPreviewPopup.ts, src/webview/terminal/TerminalFactory.ts, src/webview/messaging/MessageRouter.ts, src/webview/links/SubagentPreviewPopup.test.ts
  - **Acceptance**:
    - Outcome: expanding a nested `subagentSession` block in the popup posts `requestSubagentPreview` with the child `entryId`; the echoed response is correlated to that block and renders the child nested in place via `renderNestedInto`, with the `renderingNested` self-cycle guard (an `entryId`-bearing response populates the nested block, an `entryId`-less one is still the top-level `setContent`). Nested cache/state is cleared on the popup's idempotent `dispose()` so no body node leaks; opening another popup still dismisses this one.
    - Verify: unit src/webview/links/SubagentPreviewPopup.test.ts
  - **Plan**:
    1. Replace `FLAT_BAG` (SubagentPreviewPopup.ts:31) with a real `PreviewTimelineBag` holding a `nestedDetails` cache, `expandedNested` set, and `renderingNested` cycle guard — mirror `PreviewController.populateNested`; `populateNested` posts `requestSubagentPreview{entryId}` via an injected `postMessage`.
    2. Route the echoed `entryId`-bearing response to the popup's nested handler (TerminalFactory.ts wiring + MessageRouter.ts); add a webview test asserting a nested response renders the child in place.
    3. Clear nested cache/state in `dispose()` (SubagentPreviewPopup.ts:135).

## 3. Tests & validation

- [x] 3_1 Reader unit tests — depth-2 tree, legacy depth-1, counts
  - **Deps**: 1_4
  - **Refs**: specs/vault-session-preview/spec.md (Scenario: Claude nested subagent nests under its real parent); design.md Risk Map
  - **Scope**: src/vault/readers/claudeReader.detail.test.ts, src/vault/readers/detail.test.ts
  - **Acceptance**:
    - Outcome: tests assert (a) depth-2: root embeds only direct child A (not B); expanding A embeds B; (b) a legacy session whose metas lack `toolUseId` produces the SAME timeline as before (no regression); (c) `subagentCount` is the per-level direct-child count; (d) TRUNCATION edge: a direct child whose `Task` block is bounded OUT of `read.records` but whose spawn id is seen by the whole-stream collector still appears (by timestamp merge), while a nested child stays off root; (e) a mixed/older root file containing a sidechain `Task` id does NOT surface that nested child at root.
    - Verify: unit src/vault/readers/claudeReader.detail.test.ts
  - **Plan**:
    1. Add a depth-2 temp fixture (root jsonl + `subagents/agent-A.jsonl`/`.meta.json` + `agent-B.jsonl`/`.meta.json`, where B.meta.toolUseId is a `tool_use` id inside A's transcript and A.meta.toolUseId is inside root).
    2. Assert the tree, recursion, and counts; add a no-`toolUseId` legacy fixture asserting unchanged output.
    3. Add the truncation fixture (force a small read limit so the spawn `Task` block falls in the dropped middle) and a mixed-sidechain-root fixture; assert (d) and (e).

- [x] 3_2 Manual validation in the running extension (panel)
  - **Deps**: 1_4, 2_2
  - **Refs**: workflow.md Notes (real probe session `a75b754c-beae-47c7-858b-fccd1045228e`)
  - **Scope**: none — manual
  - **Acceptance**:
    - Outcome: in the running extension, previewing the probe session shows OUTER nested under the root and expanding OUTER reveals INNER (the vault panel tree). Terminal-popup nested drill-down is covered deterministically by the 2_2 webview test; a live-terminal popup check is best-effort (hard to reproduce a live nested Task line on demand).
    - Verify: manual — open the vault preview on session a75b754c and expand OUTER → INNER
  - **Plan**:
    1. Launch the extension (F5), open the AI Coding Vault, preview `a75b754c-…`, confirm the OUTER→INNER tree; if a live Claude terminal with a nested subagent line is available, click it and expand the nested block (best-effort).
