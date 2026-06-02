# Code Review — render-vault-workflow-board — Round 2 (re-review)

- **Date:** 2026-06-01
- **Mode:** resume of round-1 reviewers (frontend, logic, data-security) with the applied fixes. Contracts not re-run (no round-1 findings).
- **Verdict:** APPROVE (0 BLOCK; 1 new WARN raised and fixed)

## Round-1 finding dispositions (all confirmed RESOLVED)

| ID | Severity | Re-review verdict |
|----|----------|-------------------|
| B1 — `groupAgents` quadratic | BLOCK | RESOLVED (logic): single-pass `Map<phaseIndex,rows>` + orphans; no filter-in-map. |
| B2 — splitter listener leak | WARN | RESOLVED (frontend): `dragging` stacking guard + `!board.isConnected` force-release; both `document` listeners removed via `stop()`. |
| B3/L2 — orphan back → empty pane | WARN | RESOLVED (frontend+logic): group `phaseKey` threaded into `showAgentDetail`; back calls `showPhaseCards(phaseKey)` (NaN matched for "Other"). |
| W4 — no length cap | WARN | RESOLVED (data-security): `MAX_BOARD_PHASES=100` / `MAX_BOARD_AGENTS=500` enforced in the loop; output bounded. |
| L3 — stale agent highlight | SUGGEST | RESOLVED (logic): `showPhaseCards` clears `.vault-wfboard-agent.sel` first. |
| S6 — index normalization | SUGGEST | RESOLVED (data-security): `manifestInt` (non-negative integer) for `index`/`phaseIndex`. |

Logic + data-security reported NO new findings. Data-security noted a benign behavioral consequence of the cap (a >100-phase manifest routes overflow-phase agents to the "Other" bucket) — cosmetic, only under a pathological manifest, strictly better than the prior unbounded behavior; not a finding.

## New finding (round 2) — fixed same round

### [W7] Collapsing an open phase re-renders the right pane instead of going neutral
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3 · **Agent:** frontend
- **File:** src/webview/vault/workflowBoard.ts (phase-head click handler)
- **Evidence:** `phase.classList.toggle("is-open")` then unconditional `showPhaseCards(...)` — clicking an already-open phase collapsed the tree but still reloaded the right pane + re-asserted `head.sel`.
- **Fix applied:** Branch on `opening`; on collapse call a shared `showHint()` (also reused for the initial render) that clears agent selection + shows the neutral "Select a phase" hint. Phase head is deselected on collapse. Regression test added ("collapsing an open phase returns the right pane to the neutral hint").
- **Status:** accepted · **Triage:** Fixed in round 2 (trivial UX correctness).

## Verify after fixes
- check-types: clean
- test:unit: 2042 passed (3 new regression tests for B3/S5/B2 in round 1 + 1 for W7 in round 2)
- lint: the one full `pnpm run lint` run in this build reported 0 errors on changed files (12 pre-existing CSS-specificity warnings, none from new code); subsequent Biome invocations OOM (known environment issue) — formatting verified against the established style + that successful run.

## Session IDs
- frontend: review-render-vault-workflow-board-frontend (a7b8d6a3985429388)
- data-security: review-render-vault-workflow-board-data-security (a6b8fe007349da437)
- logic: review-render-vault-workflow-board-logic (a1eee93acde46eac9)
- contracts: review-render-vault-workflow-board-contracts (a0cac36cfd2f7669d) — not re-run (no findings)
