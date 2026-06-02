# vault-workflow-board Specification
## Requirements

### Requirement: Workflow run surfaces as board data

The reader SHALL, when resolving a workflow group child (a `:workflow:` id), build the workflow's `VaultSessionDetail` from the run manifest's `workflowProgress` so that `timeline` is a single `workflowBoard` item carrying: `workflowName`; optional `summary`, `status`, `agentCount`, `durationMs`, `totalTokens`, `totalToolCalls`, `model`; `phases` (`{ index, title, detail? }`, in index order); and `agents` (one per `workflow_agent` entry, in progress order) each with `label`, `phaseIndex`, optional `model`/`tokens`/`toolCalls`/`durationMs`, and `entryId` set to the agent's `:wfagent:` id (`formatWorkflowAgentSessionId(parentId, wfId, "agent-" + agentId)`) ONLY when that agent's transcript file exists.

The board SHALL NOT surface per-agent run-state nor per-phase done/total completion — only the data present in the manifest is shown.

#### Scenario: Manifest without workflowProgress

- **WHEN** a workflow manifest lacks a `workflowProgress` array
- **THEN** the reader returns the existing first-prompt `subagentSession` list (no `workflowBoard` item), preserving current behavior

### Requirement: Workflow board renders two-pane with reused agent transcript

The preview SHALL render a `workflowBoard` item as a two-pane master-detail board separated by a draggable splitter: a left "Phases" pane listing each phase (title + its agent count) expandable to its agent rows, and a right "Agents" pane that shows the selected phase's agents as collapsed rows (`label · model · tokens · tools · duration`) and, when an agent is selected, REPLACES the list with that agent's transcript plus a back affordance.

The agent transcript SHALL be produced by the shared nested-detail path — `PreviewTimelineBag.populateNested(agent.entryId, body)` resolving to `renderNestedInto` — never by a board-specific transcript renderer. Activating an agent row with no `entryId` SHALL be a no-op.

All board text SHALL be rendered as plain text via `textContent`; no session-derived value SHALL be assigned through `innerHTML`.

#### Scenario: Selecting a board agent reuses the session-detail preview

- **WHEN** an agent row carrying an `entryId` is activated in the board
- **THEN** the right pane calls `bag.populateNested(entryId, body)` — the same lazy-load + cache path used for subagent sessions — and the agent's transcript is rendered by `renderNestedInto`

### Requirement: Raw Workflow tool call is suppressed

Classification SHALL NOT surface the `Workflow` tool_use as an activity step: it produces no `tool` timeline item and is not counted in `toolCount`. The manifest-derived workflow board node is the sole representation of a run in the timeline.

