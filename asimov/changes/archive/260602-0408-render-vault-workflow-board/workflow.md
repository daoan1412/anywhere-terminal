# Workflow State: render-vault-workflow-board

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [x] 2. Discovery
  - [x] Execute workstreams (parallel finder/librarian subagents)
  - [x] Fill `discovery.md` — findings, gap analysis, options, risks
  - [x] **GATE 1: user approved direction** _(skip for trivial)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [x] Oracle review _(optional — recommended for cross-boundary, MEDIUM+ risk, new-dep; record triage in Revision Log)_
  - [x] **GATE 2: user approved plan**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check
  - [x] Lint
  - [x] Test
  - [-] E2E
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review _(round 1: 4 reviewers — frontend/data-security/logic/contracts)_
- [x] 6. Findings triage: accept/rebut each finding with rationale _(all 6 accepted, .reviews/round-1.md)_
- [x] 7. Review Fix Loop _(2 rounds — all fixed; round 2 re-review APPROVE, .reviews/round-2.md)_
- [x] 8. Validation
  - [x] **Gate: user approved implementation** _(round-3 fresh review WARN→all addressed; user: "fix được gì fix đi rồi archive")_
  - [x] Extract knowledge

## Archive

- [-] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_: N/A — no Deploy command in project.md
  - [-] Run deploy command
  - [-] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

**Complexity:** standard — cross-cutting reader+webview, new UI component (two-pane board) + new timeline item kind.
**Escalation flags:** none — no new dep, no external API contract, no data migration, no security/privacy change (existing safe-render constraint preserved).

**Key decisions (see design.md D1-D8):**
- D1/D8: new `workflowBoard` timeline item kind, dispatched standalone (breaksRun + renderTimelineItem case) — not an enriched `subagentSession`.
- D2: reader maps manifest `workflowProgress` → board; agentId→`agent-<id>` stem cross-checked vs dir; absent `workflowProgress` → existing first-prompt fallback.
- D3: agent detail REUSES `bag.populateNested`→`renderNestedInto` (session-detail preview); board owns only chrome (per knowledge decision extracted-shell-header-builder).
- D4: board selection by local DOM (no PreviewController rerender) to avoid `pendingNested` churn.
- D5: suppress raw `Workflow` tool_use in classify (skip, not relabel).
- D6: no run-state / no done-total (user directive — post-hoc sessions, not live).

**Gate 1 (direction):** user-approved. Product direction approved earlier via interactive HTML mockup + AskUserQuestion (full board, dedup blob, reuse session-detail, drop state). Gate 1 confirmed Option A architecture (workflowBoard item + reuse populateNested) over enriching subagentSession.

**Prototype:** throwaway `.wf-mockup*` files at repo root (verified by user); task 3_1 deletes them.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-06-01T13:08:06Z | claude | Plan 1-6 | Triaged (standard), discovery, Gate 1 (Option A), batch-wrote proposal/spec/design/tasks | Plan workflow-board preview feature |
| 2026-06-01T13:08:06Z | claude | Validation | asm validate passed; oracle review (HIGH conf, no CRITICAL) — accepted all 7 findings | Independent plan review |
| 2026-06-01T13:54:05Z | claude | Implement | Built all 8 tasks (1_1→3_1) in dep order. New `workflowBoard` timeline kind (types.ts); reader maps manifest workflowProgress→board + first-prompt fallback (claudeChildren.ts) w/ 2 new fixtures (wfboard/wfempty); suppressed raw Workflow tool_use (detail.ts D5); new two-pane renderer workflowBoard.ts (+test) reusing populateNested; dispatch in previewTimeline.ts; CSS in vaultPanel.css; integration test in VaultPanel.test.ts; deleted .wf-mockup* | Implement approved plan |
| 2026-06-01T13:54:05Z | claude | Verify Gate | check-types clean; lint 0 errors (12 pre-existing CSS specificity warnings, none from new code; Biome auto-formatted 17 files incl. new ones); test:unit 2038/2038; webview/vault 5× stable; E2E N/A | All gate commands pass |
| 2026-06-01T13:54:05Z | claude | Verify Gate | Reverted 14 unrelated files that the full `pnpm run lint` auto-formatted (pre-existing drift, outside change scope) to keep the change focused | Hygiene — no unrelated churn |
| 2026-06-01T14:10:00Z | claude | Review | Round 1: 4 reviewers; 1 BLOCK (groupAgents O(n²)) + 3 WARN (splitter leak, orphan back-nav, no length cap) + 2 SUGGEST (stale highlight, index normalization). Triage: all 6 accepted. | Independent code review |
| 2026-06-01T14:10:00Z | claude | Review Fix Loop | R1 fixes: single-pass Map grouping; splitter stacking-guard + detach-release; group phaseKey threaded to back-nav; MAX_BOARD_PHASES/AGENTS caps; clearSelection in showPhaseCards; manifestInt for index/phaseIndex. +3 regression tests. Round 2 re-review (resumed reviewers): all RESOLVED, 1 new WARN (collapse re-render) fixed + test. APPROVE. | 0 BLOCK; loop complete (2 rounds) |
| 2026-06-01T14:10:00Z | claude | Verify Gate (post-review) | check-types clean; test:unit 2042/2042; workflowBoard 12/12. Biome OOMs on re-run (known env); formatting per earlier clean full-lint run. | Re-verify after review fixes |
| 2026-06-01T15:30:00Z | claude | Manual-test fix round | User manual-tested; 5 issues. (1/2/3) Redesigned board to single-layer master-detail: dropped the right-pane agent cards + "← Agents" back button + phase-detail paragraph; agents now live ONLY in the collapsible Phases tree, picking a leaf fills the right pane with that agent's transcript (agent meta moved to the detail header, disclosure caret added). (4) Run-expansion (onExpandRun→rerenderActiveDetail) rebuilt the whole body and reset the board to its hint — added wfId to the item + controller-persisted board selection (open phases + open agent) via 2 new bag methods, so a rebuild restores the open agent + its now-expanded run. (5) Verified vs real ~/.claude data: NOT a bug — each agent loads its own distinct transcript; prompts are genuinely near-identical because the orchestrator front-loads identical boilerplate (the label is the differentiator). Rewrote workflowBoard.test.ts (13) + reworked VaultPanel 2_4 + added e2e 2_4b for issue 4. | Fix user-reported manual-test issues |
| 2026-06-01T15:30:00Z | claude | Verify Gate (fix round) | check-types clean; test:unit 2044/2044; webview/vault 5× stable; self-reviewed delta (persistence reentrancy, multi-board keying, removed-code stragglers). | Re-verify after manual-test fixes |
| 2026-06-01T16:15:00Z | claude | Manual-test fix round 2 | 3 more issues. (#1) Removed the redundant outer "Workflow:" collapsible: progress-bearing runs now build an INLINE workflowBoard merged directly into the parent timeline (new listClaudeWorkflowNodes returns {boards,stubs}; readClaudeDetail threads boards with teammateTurns before bounding); fallback runs keep the lazy group stub. Extracted shared workflowAgentStems leaf. Added wfId to the item. (#4) "Show N more steps" no longer triggers a full preview rebuild (which reset the board's inner-pane scroll) — renderRun now reveals the hidden items IN PLACE (insert at the button, drop button+pin); onExpandRun is record-only; removed rerenderActiveDetail. Updated the dup-entryId test to use a load-more rebuild as its re-render vehicle. (#5) No code change — the board already labels each agent by its distinct workflow label (the orchestrator's own identifier), shown as the leaf + detail heading; the identical first message is shared boilerplate and irrelevant to identity. Added reader test for the inline board. | Fix user-reported manual-test issues (round 2) |
| 2026-06-01T16:15:00Z | claude | Verify Gate (fix round 2) | check-types clean; test:unit 2045/2045; webview/vault 5× stable; self-reviewed (#1 containment + eager-cost + coexistence of inline boards & fallback stubs; #4 in-place ordering vs pinned conclusion, recorded-state survives load-more rebuild). | Re-verify after round-2 fixes |
| 2026-06-01T17:00:00Z | claude | Manual-test fix round 3 | 3 more issues. (#1 regression) Inlining the board (round 2) removed the `.vault-preview-subagent.is-open` ancestor that the transcript container's reused `.vault-preview-subagent-body` class needs for `display`, so the agent detail rendered but was `display:none` — invisible (jsdom has no CSS, so tests missed it). Fix: reverted the inline approach — runs are collapsible "Workflow:" group nodes again (restoring both the title and the ancestor); decoupled the detail container (own `.vault-wfboard-detail-body` with explicit `display:block`). (#2) The collapsible "Workflow: <name> · <status>" group head is back; slimmed the board's inner header to summary + meta (dropped the duplicated name + status chip; dropped agent-count from the head label). (#3) On agent open, the controller now jumps the board's right pane to the last message (scrollBoardDetailToEnd at both renderNestedInto sites). Reverted listClaudeWorkflowNodes→listClaudeWorkflowStubs; updated reader/label/header tests; added e2e 2_4c (scroll). | Fix user-reported manual-test issues (round 3) |
| 2026-06-01T17:00:00Z | claude | Verify Gate (fix round 3) | check-types clean; test:unit 2046/2046; webview/vault 5× stable; CSS braces balanced (243/243); self-reviewed (display-coupling root cause, slim-header dedup, scroll no-op on detached/non-board containers). | Re-verify after round-3 fixes |
| 2026-06-02T07:20:00Z | claude | Manual-test fix round 4 | Clarification: "collapsible" means the board folds ITSELF — NOT a wrapper layer (round 3's group wrapper was wrong). Re-inlined the board (listClaudeWorkflowNodes → boards inline + fallback stubs; claudeReader merges boards) and made it self-collapsing: the header is now a "Workflow: <name>" + status toggle (caret), the foldable body holds summary + meta + the two panes. Starts collapsed (= the old group-head look, but one layer); expand reveals the board inline; selecting an agent auto-expands. Persisted `expanded` in BoardSelection so a re-render restores fold state. One layer total — collapsed it looks identical to the prior wrapper head, minus the extra nesting + duplicate inner header. | Fix #1 (collapsible ≠ extra layer) |
| 2026-06-02T07:20:00Z | claude | Verify Gate (fix round 4) | check-types clean; test:unit 2048/2048; webview/vault 5× stable; CSS braces balanced (251/251); self-reviewed (re-inline display-fix interplay, collapsed-default + auto-expand-on-select, expanded persistence across rebuild). | Re-verify after round-4 fix |
| 2026-06-02T08:50:00Z | claude | Manual-test polish round 5 | Two presentation tweaks. (a) Framed the description: the expanded board's summary + run meta now sit in a bordered `.vault-wfboard-desc` box. (b) Collapsed peek: the header now carries a one-line summary subtitle (shown only while collapsed) so the session view shows a bit of description, not just the name. Header restructured to a head-row (caret · name · status) + subtitle, all spans (valid inside the button). | Fix presentation requests |
| 2026-06-02T08:50:00Z | claude | Verify Gate (round 5) | check-types clean; test:unit 2049/2049; webview/vault 5× stable; CSS braces balanced (255/255). | Re-verify after round-5 polish |

**Oracle triage (all ACCEPTED):**
1. MODIFY existing spec — added `specs/agent-session-index/spec.md` MODIFIED "Surface workflow sub-agents" (was "list by first prompt"). Did NOT modify vault-session-preview (its nested fetch-by-entryId mechanism is unchanged; board specifics owned by new cap) — minimal-delta choice.
2. Async reuse seam under-tested — added task 2_4 integration test (VaultPanel.test.ts): expand→board→select agent→transcript, + rapid A→B switch inert.
3. Fallback condition — tasks 1_2 now builds board only for non-empty workflowProgress with ≥1 workflow_agent (was `Array.isArray`); test for `[]`.
4. Phase-detail off-by-one — design D2 + task 1_2: `manifest.phases[phaseIndex-1]?.detail` (1-based progress vs 0-based array); fixture test.
5. D5 wording — clarified `continue` of content-block loop (not return); task 1_3 test with text+Workflow+Bash siblings, toolCount===1.
6. D8 proof — task 2_2 test surrounds board with tools to prove `breaksRun` (not a lone-item false pass).
7. agentId guard — design D2 + task 1_2: build stem only when agentId is non-empty alphanumeric.
