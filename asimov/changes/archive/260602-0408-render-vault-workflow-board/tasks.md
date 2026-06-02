# Tasks: render-vault-workflow-board

## 1. Reader & data

- [x] 1_1 Add `workflowBoard` member to the `VaultTimelineItem` union
  - **Deps**: none
  - **Refs**: specs/vault-workflow-board/spec.md "Workflow run surfaces as board data"; design.md D1, D8 (Interfaces)
  - **Scope**: src/vault/types.ts
  - **Acceptance**:
    - Outcome: `VaultTimelineItem` includes the `workflowBoard` variant with exactly the fields in design.md Interfaces (workflowName + optional meta scalars + `phases[]` + `agents[]` with optional `entryId`).
    - Verify: none — type-only (compiled by 1_2 / 2_x)
  - **Plan**:
    1. Add the `workflowBoard` union member to `src/vault/types.ts` per design.md Interfaces.

- [x] 1_2 Build the board from manifest `workflowProgress` in `readClaudeWorkflowDetail`
  - **Deps**: 1_1
  - **Refs**: specs/vault-workflow-board/spec.md "Workflow run surfaces as board data" (+ Scenario: Manifest without workflowProgress); design.md D2
  - **Scope**: src/vault/readers/claudeChildren.ts, src/vault/readers/claudeReader.test.ts, workflow test fixtures under that test's `WF_FIXTURE_ROOT`
  - **Acceptance**:
    - Outcome: resolving a `:workflow:` id returns a detail whose `timeline` is one `workflowBoard` item — `phases` in index order (each phase's `detail` taken from `manifest.phases[index-1]`), `agents` in progress order, each agent's `entryId` set to its `:wfagent:` id ONLY when `agentId` is non-empty alphanumeric AND `agent-<agentId>.jsonl` exists, plus meta scalars from the manifest. A manifest whose `workflowProgress` is absent, `[]`, or phase-only still returns the existing first-prompt `subagentSession` list.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. In `readClaudeWorkflowDetail`, after loading the manifest, branch: build the board ONLY when `workflowProgress` is a non-empty array with ≥1 `workflow_agent` entry; otherwise keep the current `synthesizeGroupDetail` path.
    2. Add a local `buildWorkflowBoardItem(manifest, parentId, wfId, stemSet)`: split `workflowProgress` into `workflow_phase` (→ `phases`; resolve `detail` via `manifest.phases[phaseIndex-1]?.detail`, title-equality fallback) and `workflow_agent` (→ `agents`); reuse the existing `fs.readdir(agentsDir)` result as a `Set` of stems; set `entryId = formatWorkflowAgentSessionId(parentId, wfId, "agent-"+agentId)` only when `/^[A-Za-z0-9]+$/.test(agentId)` and `"agent-"+agentId ∈ set`.
    3. Return `finalizeDetail(formatEntryId("claude", sessionId), { firstPrompt: summary, recentActivity: [], timeline: [boardItem], stats: { messageCount: 0, toolCount: 0, subagentCount: agents.length } }, false)`.
    4. Add fixtures + tests: (a) a run whose `workflow_phase.index` is 1-based and `manifest.phases` 0-based — assert the phase `detail` is NOT off-by-one; (b) an agent with a missing file → row present, `entryId` absent; (c) `workflowProgress: []` → first-prompt fallback path; (d) full board shape + meta scalars.

- [x] 1_3 Suppress the raw `Workflow` tool_use in `classifyClaudeStyleEvents`
  - **Deps**: none
  - **Refs**: specs/vault-workflow-board/spec.md "Raw Workflow tool call is suppressed"; design.md D5
  - **Scope**: src/vault/readers/detail.ts, src/vault/readers/detail.test.ts
  - **Acceptance**:
    - Outcome: an assistant `tool_use` with `name === "Workflow"` produces no `tool` timeline item and does not increment `stats.toolCount`; sibling `text`/`tool_use` blocks in the SAME assistant message are unaffected.
    - Verify: unit src/vault/readers/detail.test.ts
  - **Plan**:
    1. In the `tool_use` branch of `classifyClaudeStyleEvents` (the non-`Task`/`Agent` else), `continue` the content-block loop when `name === "Workflow"` — before `toolCount++`/`toolLabel`. This skips only the one block, not the message (D5).
    2. Add a test: one assistant message containing `text` + a `Workflow` tool_use + a `Bash` tool_use → the text message and the Bash tool item survive, the Workflow item is absent, and `toolCount === 1`.

## 2. Webview rendering

- [x] 2_1 Add `renderWorkflowBoard` (two-pane board + splitter, agent detail via `populateNested`)
  - **Deps**: 1_1
  - **Refs**: specs/vault-workflow-board/spec.md "Workflow board renders two-pane with reused agent transcript" (+ Scenario: Selecting a board agent reuses the session-detail preview); design.md D3, D4, D6, D7 (Interfaces)
  - **Scope**: src/webview/vault/workflowBoard.ts, src/webview/vault/workflowBoard.test.ts
  - **Acceptance**:
    - Outcome: `renderWorkflowBoard(item, bag)` returns an element with a left Phases tree (phase → agent rows) and a right Agents pane; selecting a phase lists its agents (collapsed: `label · model · tokens · tools · duration`); selecting an agent with `entryId` clears the right pane and calls `bag.populateNested(entryId, body)`; an agent without `entryId` is a no-op; the splitter drag adjusts left-pane width; every session-derived string is set via `textContent`.
    - Verify: unit src/webview/vault/workflowBoard.test.ts
  - **Plan**:
    1. Build DOM: `.vault-wfboard` → `.vault-wfboard-left` (Phases), `.vault-wfboard-split`, `.vault-wfboard-right`; header line with summary + meta (agents/duration/tokens/toolCalls/model) and an optional neutral status chip.
    2. Group `agents` by `phaseIndex`; render phase rows (title + count) that toggle their agent leaves; clicking a phase shows its agent cards in the right pane, clicking an agent (tree leaf or card) selects it.
    3. On agent select with `entryId`: create a detail container, append a back affordance, call `bag.populateNested(entryId, container)`; manage selection by local `.sel` toggles + right-pane swap (no external rerender — D4).
    4. Add local `mousedown`/`mousemove` splitter handlers adjusting `left.style.flexBasis` within ~180px min bounds (D7).
    5. Add format helpers (`fmtModel`/`fmtDur`/`fmtTok`) — colocate or reuse from renderAtoms; all text via `textContent`.
    6. Test with a stub `PreviewTimelineBag`: assert tree structure, that selecting an agent calls `populateNested` with the right `entryId`, and that a no-`entryId` agent does not.

- [x] 2_2 Dispatch `workflowBoard` from the timeline renderer
  - **Deps**: 2_1, 1_1
  - **Refs**: design.md D8
  - **Scope**: src/webview/vault/previewTimeline.ts, src/webview/vault/workflowBoard.test.ts
  - **Acceptance**:
    - Outcome: a `workflowBoard` item is rendered standalone (not swept into a capped "Show N more" run) via `renderWorkflowBoard`, even when surrounded by ordinary steps.
    - Verify: unit src/webview/vault/workflowBoard.test.ts
  - **Plan**:
    1. In `breaksRun`, add `|| item.kind === "workflowBoard"`.
    2. In `renderTimelineItem`, add `case "workflowBoard": return renderWorkflowBoard(item, bag);` (import from workflowBoard.ts).
    3. Add a test that PROVES `breaksRun` (mirroring the subagent cap test): timeline = user msg → 4 tools → `workflowBoard` → 4 tools; assert the board is rendered directly and the ordinary tools split into two independently-capped runs (would fail if `breaksRun` were omitted, unlike a lone-item timeline).

- [x] 2_3 Style the board
  - **Deps**: 2_1
  - **Refs**: design.md D6, D7
  - **Scope**: src/webview/vault/vaultPanel.css
  - **Acceptance**:
    - Outcome: `.vault-wfboard` two-pane layout, Phases tree rows, agent cards, agent-detail, and a `col-resize` splitter are styled consistently with the existing preview (VS Code theme vars); panes scroll independently.
    - Verify: none — styling, manual visual
  - **Plan**:
    1. Add `.vault-wfboard*` rules to vaultPanel.css mirroring existing `.vault-preview-subagent*` tokens; splitter `cursor: col-resize` + hover accent.

- [x] 2_4 Integration test for the async reuse seam (board → agent transcript via `populateNested`)
  - **Deps**: 2_1, 2_2, 1_2
  - **Refs**: specs/vault-workflow-board/spec.md "Workflow board renders two-pane with reused agent transcript" (Scenario); design.md D3, D4
  - **Scope**: src/webview/vault/VaultPanel.test.ts
  - **Acceptance**:
    - Outcome: end-to-end in jsdom — expanding a workflow node → host returns `[workflowBoard]` → board mounts; selecting an agent posts `requestVaultSessionDetail` and the returned transcript renders in the right pane (driven through the real `PreviewController` `populateNested`/`pendingNested` routing, not a stub bag). A rapid-switch case (select A, select B before A resolves) leaves B's transcript in the visible pane and A's late reply does not overwrite it.
    - Verify: integration src/webview/vault/VaultPanel.test.ts
  - **Plan**:
    1. Reuse the existing VaultPanel jsdom harness (document.body + mocked host messages) to expand a workflow group and feed a `[workflowBoard]` detail response.
    2. Select an agent row, assert a `requestVaultSessionDetail` for its `:wfagent:` entryId is posted, feed the response, assert the transcript appears in the board's right pane.
    3. Add the rapid A→B switch assertion (late A reply is inert).

## 3. Cleanup

- [x] 3_1 Remove the throwaway mockup prototype files
  - **Deps**: none
  - **Refs**: discovery.md (prototype)
  - **Scope**: .wf-mockup.html, .wf-mockup.template.html, .wf-mockup-data.json
  - **Acceptance**:
    - Outcome: the three prototype files no longer exist in the repo root.
    - Verify: none — cleanup
  - **Plan**:
    1. Delete `.wf-mockup.html`, `.wf-mockup.template.html`, `.wf-mockup-data.json`.
