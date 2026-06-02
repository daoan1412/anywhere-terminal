# Code Review — render-vault-workflow-board — Round 1

- **Date:** 2026-06-01
- **Reviewable lines:** ~440 tracked (+ ~310 new `workflowBoard.ts`); CSS 227
- **Agents spawned:** frontend, data-security, logic, contracts
- **Agents skipped:** none
- **Verdict:** BLOCK
- **Counts:** BLOCK 1 · WARN 3 · SUGGEST 2

## Findings

### [B1] `groupAgents` is O(phases × agents) — `.filter()` inside `.map()`
- **Severity:** BLOCK · **Confidence:** HIGH · **Priority:** P2 · **Agent:** logic
- **File:** src/webview/vault/workflowBoard.ts:86 (`groupAgents`)
- **Evidence:** `item.phases.map(p => ... indexed.filter(x => x.agent.phaseIndex === p.index))` — quadratic.
- **Impact:** A large/corrupt manifest (bounded only by the 2 MiB file cap) can make board build scale quadratically and jank the webview.
- **Fix:** Single pass → `Map<phaseIndex, rows[]>`, then look up per phase; collect orphans from the leftover.
- **Status:** accepted · **Triage:** Fixing. Severity kept BLOCK per expert HIGH + complementary B-tier DS1; realistic inputs are tiny but the cliff is real and the fix is cheap.

### [B2] Splitter `document` listeners stack / leak
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P2 · **Agent:** frontend
- **File:** src/webview/vault/workflowBoard.ts (`attachSplitter`, mousedown handler)
- **Evidence:** Each mousedown adds `document` mousemove/mouseup with no stacking guard; if the overlay closes mid-drag, `onUp` never fires so the listeners persist on `document` and act on a detached subtree.
- **Impact:** Leaked handlers fire on every mouse move webview-wide, retain the detached board (GC), waste work.
- **Fix:** Guard `if (dragging) return;` on mousedown; in `onMove`, `if (!board.isConnected) { onUp(); return; }`.
- **Status:** accepted · **Triage:** Fixing. Matches the project invariant that body/document-level overlay listeners need a disposal path on every teardown.

### [B3] Orphan-agent back button lands on an empty pane
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3 · **Agents:** frontend + logic (same finding, merged)
- **File:** src/webview/vault/workflowBoard.ts (`showAgentDetail` back button → `showPhaseCards(agent.phaseIndex)`)
- **Evidence:** Orphan agents render under a group whose `phaseKey` is `NaN`; back passes `agent.phaseIndex` (a real number that matches no group), so `showPhaseCards` shows "No agents in this phase."
- **Impact:** After opening an orphan agent's transcript, "← Agents" no longer returns to the card list.
- **Fix:** Thread the active group's `phaseKey` into `showAgentDetail`; back calls `showPhaseCards(groupKey)`.
- **Status:** accepted · **Triage:** Fixing.

### [W4] No length cap on `phases`/`agents`
- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P3 · **Agent:** data-security
- **File:** src/vault/readers/claudeChildren.ts (`buildWorkflowBoardItem` mapping loop)
- **Evidence:** `workflowProgress` mapped 1:1 into `phases`/`agents` with no cap; shipped as one IPC item. Bounded only by the 2 MiB manifest cap (still ~thousands of entries possible).
- **Impact:** Oversized IPC message + large synchronous DOM build for a pathological/corrupt manifest. Not a security boundary (user's own `~/.claude` data).
- **Fix:** Cap mapped rows defensively (a few hundred), mirroring the reader's bounded-window discipline.
- **Status:** accepted · **Triage:** Fixing (complements B1).

### [S5] Stale agent `.sel` highlight after selecting a phase
- **Severity:** SUGGEST · **Confidence:** HIGH · **Priority:** P4 · **Agent:** logic
- **File:** src/webview/vault/workflowBoard.ts (`showPhaseCards`)
- **Evidence:** `showPhaseCards` swaps the right pane but doesn't clear `.vault-wfboard-agent.sel`, so a previously selected leaf stays highlighted while the right pane shows a different phase.
- **Fix:** `clearSelection(".vault-wfboard-agent")` at the start of `showPhaseCards`.
- **Status:** accepted · **Triage:** Fixing (trivial).

### [S6] `index`/`phaseIndex` not integer/range-normalized
- **Severity:** SUGGEST · **Confidence:** MEDIUM · **Priority:** P4 · **Agent:** data-security
- **File:** src/vault/readers/claudeChildren.ts (`buildWorkflowBoardItem`)
- **Evidence:** `manifestNumber` accepts any finite number; a fractional/negative `index`/`phaseIndex` survives into equality-based grouping (lands agents in the orphan bucket).
- **Fix:** Coerce to non-negative integers (else positional fallback / 0).
- **Status:** accepted · **Triage:** Fixing (trivial).

## Confirmed clean (no findings)
- textContent-only rendering for all session-derived strings (frontend).
- Path traversal / id injection: safe — agentId guard + stemSet membership at build, double re-validation (`parseClaudeChildId` + `resolveClaudeWorkflowAgentPath` + containment) on resolve (data-security).
- Defensive manifest parsing; containment checks preserved; fallback null-on-missing-dir intact (data-security).
- Phase-detail off-by-one correct; `Workflow` suppression block-local (siblings/counts intact); rapid A→B switch inert + cache re-hit; fallback branches (absent/`[]`/phase-only) correct; splitter clamp NaN-safe (logic).
- `workflowBoard` union matches design Interfaces exactly; structured-clone-safe; emitted detail shape + entryId + fallback contracts hold; dispatch handles the new kind (contracts).

## Session IDs
- frontend: review-render-vault-workflow-board-frontend (a7b8d6a3985429388)
- data-security: review-render-vault-workflow-board-data-security (a6b8fe007349da437)
- logic: review-render-vault-workflow-board-logic (a1eee93acde46eac9)
- contracts: review-render-vault-workflow-board-contracts (a0cac36cfd2f7669d)
