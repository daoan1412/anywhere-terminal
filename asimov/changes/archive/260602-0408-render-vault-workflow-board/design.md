# Design: render-vault-workflow-board

## Decisions

### D1: New `workflowBoard` timeline item kind (not enriched `subagentSession`)
The workflow's `VaultSessionDetail.timeline` becomes a single `workflowBoard` item; a dedicated webview renderer owns the board. Rejected alternative: hanging board fields on the generic `subagentSession` node and special-casing `renderSubagentSession`/run machinery — that bleeds workflow specifics into the shared renderer and makes the two-pane layout awkward. The board is a self-contained leaf in the union; the generic timeline only needs to dispatch to it.

### D2: Reader maps `workflowProgress` → board; agent files cross-checked
`readClaudeWorkflowDetail` reads the manifest (already loaded there for `summary`), splits `workflowProgress` into `workflow_phase` and `workflow_agent` entries, and emits the `workflowBoard` item. Phase rows come from the `workflow_phase` entries (1-based `index`); a phase's optional `detail` is looked up positionally as `manifest.phases[phaseIndex - 1]?.detail` (progress `index` is 1-based, `manifest.phases` is a 0-based array — off-by-one is real), with title-equality as a fallback match. Each `workflow_agent.agentId` (`a61b…`) maps to file stem `agent-<agentId>` ONLY when `agentId` is a non-empty alphanumeric string (`/^[A-Za-z0-9]+$/`, so the stem satisfies `WORKFLOW_AGENT_STEM_RE`); the existing `fs.readdir(agentsDir)` listing is reused as a Set so an agent gets a drill-down `entryId` only when its file is present — a missing/malformed `agentId` or absent file yields a row with no `entryId` (non-clickable). The board is emitted ONLY when `workflowProgress` is a non-empty array containing at least one usable `workflow_agent`; otherwise (absent, `[]`, or phase-only) keep the current first-prompt `synthesizeGroupDetail` path (back-compat). Raw numbers/model ids pass through unformatted; the webview formats them.

### D3: Agent detail reuses `populateNested`; board owns only chrome
Per knowledge decision `extracted-shell-header-builder-prevents-ui-divergence`, "reuse" must compose one shared piece, not duplicate orchestration. The board renders panes/tree/cards/splitter only; the per-agent transcript is produced by `bag.populateNested(agent.entryId, body)` → `renderNestedInto` → `renderTimelineInto`, identical to subagent-session expansion (cache + pending tracking included). The board never re-implements transcript rendering.

### D4: Board manages selection by local DOM, not a PreviewController re-render
Phase/agent selection toggles `.sel` classes and swaps the right-pane subtree directly inside the board element — it does NOT call `rerenderActiveDetail`. This keeps the board self-contained and avoids orphaning `pendingNested` bodies on rapid agent switches (a stale pending body is simply never filled; re-selecting hits the cache). Selection state is intentionally ephemeral (lost if the parent preview re-renders; re-expanding restores).

### D5: Suppress the raw `Workflow` tool_use in classify
In `classifyClaudeStyleEvents`, the per-block loop `for (const b of content)` SHALL `continue` when a `tool_use` block has `name === "Workflow"` (before `toolCount++`/`toolLabel`). This is a `continue` of the CONTENT-BLOCK loop, NOT a return from `classifyClaudeStyleEvents` — sibling `text`/`thinking`/other `tool_use` blocks in the same assistant message are untouched. The manifest-derived board node is the sole representation. Safe because run manifests are written at start (even `killed` runs have one), so a workflow can never silently vanish. Chosen over relabeling in `toolLabel` (which would still emit a redundant step).

### D6: Drop run-state; header shows manifest facts only
No per-agent state icon and no per-phase `done/total` (user directive — sessions are post-hoc, not live). The board header shows manifest scalars only (`summary`, and a meta line `N agents · duration · tokens · tool calls · model`); the run-level `status` may appear as a neutral (non-colored) chip. Each phase row shows its agent count, not a completion fraction.

### D7: Splitter is local; whole-panel resize stays FloatingWindow's
The splitter drags the left pane's `flex-basis` within min widths (≈180px each side) via local mousedown/mousemove handlers scoped to the board. Geometry is not persisted. The surrounding overlay's resize/maximize remains FloatingWindow's responsibility (unchanged).

### D8: `workflowBoard` breaks runs and dispatches directly
`breaksRun` returns true for `workflowBoard` so it is rendered standalone via `renderTimelineItem` (a new `case "workflowBoard"`), not swept into a capped "show N more" run. It is the lone item in the workflow child's nested detail.

## Interfaces

```ts
// src/vault/types.ts — new VaultTimelineItem union member (D1)
| {
    kind: "workflowBoard";
    workflowName: string;
    summary?: string;
    status?: string;          // raw manifest run outcome (e.g. "completed" | "killed"); informational, not per-agent state
    agentCount?: number;
    durationMs?: number;
    totalTokens?: number;
    totalToolCalls?: number;
    model?: string;           // defaultModel (raw id; webview formats)
    phases: { index: number; title: string; detail?: string }[];
    agents: {
      label: string;
      phaseIndex: number;
      entryId?: string;       // :wfagent: id for transcript drill-down; omitted when no agent file exists
      model?: string;
      tokens?: number;
      toolCalls?: number;
      durationMs?: number;
    }[];
    timestamp?: number;
  }
```

```ts
// src/webview/vault/workflowBoard.ts — new renderer (D3, D7)
export function renderWorkflowBoard(
  item: Extract<VaultTimelineItem, { kind: "workflowBoard" }>,
  bag: PreviewTimelineBag,
): HTMLElement;
// builds .vault-wfboard (left Phases tree | splitter | right Agents pane);
// selecting an agent with entryId → bag.populateNested(entryId, rightBody)
```

```ts
// src/webview/vault/previewTimeline.ts — dispatch (D8)
// breaksRun(): add `|| item.kind === "workflowBoard"`
// renderTimelineItem(): add `case "workflowBoard": return renderWorkflowBoard(item, bag);`
```

Reader output shape (D2): `readClaudeWorkflowDetail` → `finalizeDetail(entryId, { firstPrompt: summary, recentActivity: [], timeline: [workflowBoardItem], stats: { messageCount: 0, toolCount: 0, subagentCount: agents.length } }, false)`.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| Board ↔ `pendingNested` | Rapid agent switching orphans a pending body | D4 — local DOM selection, no PreviewController rerender; orphaned pending body is harmless, re-select hits cache |
| Reader agentId→stem | `agent-<id>` mismatch leaves agents un-drillable | D2 — cross-check against `fs.readdir(agentsDir)` Set; missing file → row shown without `entryId` (no-op on click per spec) |
| Back-compat | Older manifests lack `workflowProgress` | D2 — fall back to existing first-prompt `synthesizeGroupDetail` path; covered by a reader unit test |
| Safe rendering | Board injects labels/model/summary | D3/D7 — all text via `textContent`; reuse `renderAtoms` text helpers; no `innerHTML` for session data (vault-session-preview "Safe preview rendering") |
| Suppressed tool call | A manifest-less run would vanish | D5 — manifests written at run start (killed runs included); accepted as effectively impossible |
| `toolCount` stat | Skipping `Workflow` changes counts | D5 — intended; `Workflow` is orchestration, not a normal tool call; assert in classify unit test |
