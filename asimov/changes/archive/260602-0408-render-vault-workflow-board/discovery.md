# Discovery: render-vault-workflow-board

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot | Done | finder subagent (exact signatures) + direct manifest inspection |
| Internal Patterns | Done | memory recall (nest-workflow-team-sessions, extracted-shell decision) |
| External Research | Skipped | no new lib/API |
| Constraint Check | Done | safe-render requirement (vault-session-preview), manifest size cap |

## Key Findings

### 1. The manifest already holds the full board — it is currently discarded
Each run's `<parentId>/workflows/wf_*.json` carries everything the CLI board renders:
- `phases[]` → `{ title, detail }`
- `workflowProgress[]` → ordered entries: `{ type:"workflow_phase", index, title }` and `{ type:"workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model, tokens, toolCalls, durationMs, promptPreview, resultPreview }`
- scalars: `workflowName, summary, status, agentCount, durationMs, totalTokens, totalToolCalls, defaultModel`

`readClaudeWorkflowDetail` (claudeChildren.ts:57-108) ignores ALL of this — it re-reads each agent file's FIRST PROMPT and emits a flat `subagentSession` list (near-identical labels). `readManifestJson` caps at 2 MiB and is already called there for `summary`.

### 2. A workflow renders TWICE and both are wrong
- **Raw blob**: the `Workflow` tool_use has input `{ script: "<13 KB JS>" }`. `toolLabel` has no `Workflow` case → default branch returns the first string value = the script, truncated to 600 chars → an unreadable code blob as an activity step (detail.ts:248-257, 493-507).
- **Generic group node**: `listClaudeWorkflowStubs` adds a `subagentSession` node ("Workflow: name · N agents · status"), merged by manifest timestamp; expanding it yields the flat first-prompt list above.

### 3. The reuse seam already exists
Agent transcripts resolve today via `:wfagent:` ids → `readClaudeWorkflowAgentDetail` (claudeChildren.ts:112-130). The webview's nested lazy-load — `PreviewTimelineBag.populateNested(entryId, body)` → `renderNestedInto` → `renderTimelineInto` (previewTimeline.ts:40,78) with cache (`nestedDetails`) + pending tracking (`pendingNested`) in PreviewController — is exactly the "session-detail preview" the user wants the agent detail to reuse. The board should drive agent detail through this same `populateNested`, not re-render transcripts itself.

### 4. Prior art / guardrails (memory)
- `nest-workflow-team-sessions` added the `subagentSession`/`teammateTurn` timeline variants and the `renderPreviewDetail` break/guard pattern for non-run nodes — the board node slots into the same machinery.
- Decision `extracted-shell-header-builder-prevents-ui-divergence`: "reuse" must mean composing ONE shared piece, not reusing leaves while duplicating orchestration. → Agent detail MUST go through `populateNested`/`renderNestedInto`; only the board chrome (panes, tree, splitter) is new.
- `vault-session-preview` "Safe preview rendering": all session-derived text via `textContent`, icons only from the static map. The board renderer must obey this.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Workflow detail (reader) | first-prompt `subagentSession` list | board data from `workflowProgress` | parse manifest progress → phases + agents (+ `:wfagent:` entryId) |
| Timeline item kinds | message/thinking/subagentSession/teammate*/activity | a `workflowBoard` variant | new union member in types.ts |
| Webview renderer | generic timeline + nested expand | two-pane board (tree + agent cards + detail + splitter) | new `renderWorkflowBoard` |
| Agent detail | nested transcript via `populateNested` | drive it from a board agent selection | wire board → `bag.populateNested(agentEntryId, rightBody)` |
| Raw Workflow tool_use | dumped as 600-char blob | suppressed | `name==="Workflow"` skip in classify |

## Options

### Option A — `workflowBoard` timeline item + reuse `populateNested` for agent transcripts (Recommended)
`readClaudeWorkflowDetail` returns `timeline = [{ kind:"workflowBoard", phases, agents, meta }]`; webview adds one `renderWorkflowBoard(item, bag)` that owns the two panes + splitter, and drills each agent via `bag.populateNested(agent.entryId, rightBody)`. Single new item kind, single new renderer; transcript rendering is 100% reused. Degrades to the current first-prompt list when `workflowProgress` is absent.

### Option B — Enrich the generic `subagentSession` group in place
Attach board fields to the group node and special-case the generic timeline renderer. Rejected: spreads workflow specifics across the shared `renderSubagentSession`/run machinery, makes the two-pane layout awkward, and couples generic rendering to one feature.

## Risks

1. **Board re-render churn vs `pendingNested`** — switching agents mid-load could orphan a pending body. Mitigation: board manages selection by local DOM swaps (no PreviewController rerender) and relies on `populateNested`'s cache; orphaned pending bodies are harmless (filled on re-select). Document in design D-risk.
2. **agentId → file stem mapping** — progress `agentId` (`a61b…`) vs file stem (`agent-a61b…`). Mitigation: build entryId as `formatWorkflowAgentSessionId(parentId, wfId, "agent-"+agentId)`, cross-checked against the dir listing; rows with no file are shown without drill-down.
3. **Older manifests without `workflowProgress`** — Mitigation: fall back to the existing first-prompt `synthesizeGroupDetail` path (back-compat preserved).
4. **Safe-render regression** — board injects labels/model/summary. Mitigation: all text via `textContent`; no `innerHTML` for session data (reuse renderAtoms helpers).
5. **Suppressing the raw Workflow tool_use hides a manifest-less run** — Mitigation: manifests are written at run start (even `killed` runs have one), so this is effectively impossible; accept.
