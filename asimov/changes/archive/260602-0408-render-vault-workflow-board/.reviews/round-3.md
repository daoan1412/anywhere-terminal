# Code Review — render-vault-workflow-board — Round 3 (fresh)

- **Date:** 2026-06-02
- **Mode:** fresh spawn (all 4 agents), per user request ("review lại, fresh"). NOT a resume — the board was materially **redesigned** after round 2 (single-layer self-collapsing board: header-as-toggle, agents only as tree leaves, no cards / no "back to agents" button, bag-persisted selection, in-place "Show N more" expansion, `scrollBoardDetailToEnd`, `rerenderActiveDetail` removed). Round 2's APPROVE does not cover this new surface.
- **Reviewable lines:** ~935 tracked diff (incl. tests) + 390-line new `workflowBoard.ts`. NOTE: large change — accuracy may decrease.
- **Agents spawned:** frontend, data-security, logic, contracts (logic/contracts re-spawned on Claude after the codex provider returned 503).
- **Agents skipped:** none.
- **Gate:** `pnpm run check-types` clean · `pnpm run test:unit` 2049/2049 pass (2050 after the fixes below).
- **Verdict:** WARN → all findings ADDRESSED same round (see "Fixes applied" below). 5 fixed, 1 accepted-as-is.
- **Counts:** BLOCK 0 · WARN 3 · SUGGEST 3

## Findings

### [W1] Per-field strings (label / title / detail / model) are not length-capped
- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P3 · **Agent:** data-security
- **File:** src/vault/readers/claudeChildren.ts (`buildWorkflowBoardItem`: agent `label`, phase `title`/`detail`, `model`, `status`, `workflowName`)
- **Evidence:** Only `summary` runs through `truncate()` (`summary: truncate(summary)`). Every other human-facing string passes through raw `manifestString()` (trim + non-empty only, no length cap). Row counts are capped (`MAX_BOARD_PHASES=100`/`MAX_BOARD_AGENTS=500`, the round-1 W4 fix) but a single field is bounded only by `readManifestJson`'s 2 MiB file cap.
- **Impact:** Not a security boundary (local `~/.claude` data; `parentId`/`wfId` fully validated). A corrupt/pathological manifest could pack a multi-hundred-KB string into one `label`/`title`, shipped over structured-clone postMessage and rendered synchronously into the webview DOM. Inconsistent with the deliberate `truncate(summary)` on the sibling field.
- **Fix:** Run the other human-facing fields through `truncate()` like `summary` (e.g. `label: truncate(manifestString(obj.label) ?? agentId ?? "agent")`, same for `title`/`detail`).
- **Status:** open · **Triage:** new this round (extends the FIXED row-count W4 to per-field size). Cheap, matches existing intent.

### [W2] Synthesized phase `index` can collide with an explicit one → duplicate agent leaves
- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P4 · **Agent:** logic
- **File:** src/vault/readers/claudeChildren.ts (`const index = manifestInt(obj.index) ?? phases.length + 1;` then `phases.sort(...)`) → consumed by `groupAgents` in src/webview/vault/workflowBoard.ts:97-102
- **Evidence:** A `workflow_phase` lacking a valid `index` is synthesized as `phases.length + 1`, which can equal a *later* phase's explicit index. After `phases.sort`, two phases share an index; `groupAgents` does `byPhase.get(p.index)` for each, returning the **same** agent array → those agents render as leaves under both phase headers, and `phaseEls.set(phaseKey, …)` is last-wins (selection-restore reopens only one).
- **Impact:** Duplicate leaves + un-restorable phase open-state. No crash/data loss. Requires a manifest mixing present + absent phase indices — the CLI writer always emits sequential unique indices, so this is malformed/hand-edited-input territory.
- **Fix:** Seed synthesis above any seen explicit index (track `maxIndex`, use `Math.max(maxIndex, phases.length) + 1`), or de-dupe indices after sort.
- **Status:** open · **Triage:** new this round; defensive-only (real producer never emits this).

### [W3] A `workflowBoard` with no `timestamp` can be dropped by tail-bounding
- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P4 · **Agent:** logic
- **File:** src/vault/readers/claudeReader.ts (`extras = [...teammateTurns, ...wfNodes.boards]` → `mergeTimestampedItems` → `boundTimeline`)
- **Evidence:** `buildWorkflowBoardItem` omits `timestamp` when both `startTime` and `timestamp` are absent/non-coercible. `mergeTimestampedItems` sorts extras by `timestamp ?? 0`, so a timestamp-less board sorts to the front; `boundTimeline` keeps the most-recent `cap` (tail). A front-pinned board is the first dropped when the merged timeline exceeds `MAX_TIMELINE_ITEMS` (400).
- **Impact:** On a long parent session (>400 items) a manifest missing *both* time fields renders **no board at all** (silently absent, not mis-ordered). Bounded to the corrupt/partial-manifest case; real manifests carry `startTime`.
- **Fix:** Fall back to a sentinel timestamp (parent's last-record time, or read-time) when none resolves, so boards anchor to the recent tail; or exempt `workflowBoard` from tail-drop.
- **Status:** open · **Triage:** new this round; corrupt-manifest + very-long-session edge.

### [S4] Splitter has no proactive teardown if the board detaches mid-drag-hold (narrowed residual of round-1 B2)
- **Severity:** SUGGEST · **Confidence:** MEDIUM · **Priority:** P4 · **Agent:** frontend
- **File:** src/webview/vault/workflowBoard.ts (`attachSplitter`)
- **Evidence:** The round-1 B2 fixes are present and effective: `document` listeners are attached only during an active drag, a `dragging` guard prevents stacking, and `onMove` force-releases via `stop()` when `!board.isConnected`. The remaining window: board detached programmatically *while the button is held* AND no further mousemove/mouseup ever fires. There is no teardown hook tied to the board's own disconnection.
- **Impact:** Gesture-scoped listeners (sub-second) that **self-heal on the very next mouse event** (move → isConnected check; up → stop). Leak window is theoretical; no user-visible effect.
- **Fix (optional hardening):** Return a teardown from `attachSplitter` (or use an `AbortController`) wired to the board's lifecycle.
- **Status:** open · **Triage:** persists-narrowed from B2 (which was accepted+resolved). Downgraded WARN→SUGGEST: the core leak is fixed; this is gold-plating a self-healing gesture listener.

### [S5] Empty `else if (name === "Workflow") {}` reads as a mistake
- **Severity:** SUGGEST · **Confidence:** HIGH · **Priority:** P5 · **Agent:** logic
- **File:** src/vault/readers/detail.ts:493
- **Evidence:** The intentionally-empty branch between the `Task`/`Agent` branch and the default tool branch. Logic is correct — it skips ONLY the single `Workflow` content block, leaves sibling `text`/`thinking`/other `tool_use` blocks intact (each handled in its own loop iteration), and does not touch `toolCount` (verified by the new `detail.test.ts` D5 test). Readability/lint hazard only (`noEmptyBlockStatements`).
- **Fix:** Add a one-line comment inside the block explaining the deliberate skip (the design specified `continue`; an empty branch is the equivalent but obscure form).
- **Status:** open · **Triage:** new this round; cosmetic.

### [S6] Phase-head buttons lack `aria-expanded`
- **Severity:** SUGGEST · **Confidence:** HIGH · **Priority:** P5 · **Agent:** frontend
- **File:** src/webview/vault/workflowBoard.ts (phase-head `<button>` construction, ~line 333)
- **Evidence:** The board header sets `aria-expanded` (line 243) but the per-phase heads (which toggle `.is-open` on their subtree) do not.
- **Impact:** Screen-reader users get no expand/collapse state for phase subtrees.
- **Fix:** Set `aria-expanded` initial + toggle it in the phase-head click handler.
- **Status:** open · **Triage:** new this round; a11y polish.

## Confirmed clean (no findings)
- **Contracts (full re-run): no findings.** `workflowBoard` union matches producer (`buildWorkflowBoardItem`) and consumer (`workflowBoard.ts`) exactly; structured-clone-safe; `listClaudeWorkflowStubs` → `listClaudeWorkflowNodes` back-compat wrapper preserves the old contract and `claudeReader.ts` migrated correctly; all 3 `PreviewTimelineBag` implementers updated (`PreviewController`, `FLAT_BAG`, test stub); `BoardSelection.open` `NaN` ("Other") round-trips because it's in-memory only (never `JSON.stringify`'d); `:wfagent:` entryId grammar round-trips through `parseClaudeChildId`.
- **Path traversal / id injection: safe (data-security HIGH).** `parentId` (`isSafeSessionId`) + `wfId` (`WORKFLOW_ID_RE`) validated on BOTH the eager `listClaudeWorkflowNodes` path (re-validated at the on-disk `wfId` loop) and the lazy `readClaudeWorkflowDetail` resolver; manifest read + agents-dir read both containment-checked; `agentId` constrained to `/^[A-Za-z0-9]+$/` + `stemSet.has(...)`, never feeds a `path.join`, and is re-validated on resolve.
- **Phase-detail off-by-one correct** (1-based index → `phases[index-1]`, title-equality + positional fallback); covered by reader test.
- **`Workflow` suppression is block-local** — siblings + `toolCount` intact (logic + new D5 test).
- **Rapid A→B agent switch inert + cache re-hit** — late A reply lands on the detached container, visible pane keeps B, re-select hits cache (frontend + VaultPanel `2_4` integration test through the real `PreviewController`).
- **In-place "Show N more" expansion** — no duplicated/missing items (pin removed, revealed slice includes the conclusion); `workflowBoard` never swept into a run (`breaksRun`). Covered by `2_4b`.
- **textContent-only** for all session-derived strings (frontend).
- **`scrollBoardDetailToEnd`** is a safe no-op for non-board nested containers (frontend + `2_4c`).

## Fixes applied (same round)

All on the user's "fix được gì fix đi rồi archive" directive. Gate after fixes: `check-types` clean · `test:unit` **2050 pass** (+1 aria test) · webview/vault 5× stable (160 each).

- **W1 — FIXED** (`claudeChildren.ts`): agent `label`, phase `title`/`detail`, `model`, run-level `status`/`workflowName` now run through `truncate()` like `summary`. Identity on normal short values (no test impact); bounds the pathological field.
- **W2 — FIXED** (`claudeChildren.ts`): added a pre-scan of explicit phase indices + a `synthPhaseIndex()` that returns the lowest unused index, so a synthesized index can never collide with an explicit one. (Duplicate *explicit* indices — even rarer, and unfixable without desyncing the agent→phase linkage — remain out of scope.)
- **W3 — FIXED** (`claudeChildren.ts`, eager path only): when a board has no manifest timestamp, fall back to the manifest file's `mtimeMs` (gated — zero extra I/O on the common path) so it threads near the recent tail instead of sorting to 0 and being tail-dropped.
- **S5 — FIXED** (`detail.ts:493`): added a one-line comment explaining the deliberate empty `Workflow` branch.
- **S6 — FIXED** (`workflowBoard.ts`): phase heads now set/toggle `aria-expanded` (build-time, click handler, and `ensurePhaseOpen`); new test asserts it.
- **S4 — ACCEPTED AS-IS** (not fixed): the round-1 B2 mitigations (gesture-scoped listeners + `dragging` guard + `!board.isConnected` force-release) already make the splitter self-healing. The only residual is a held-button + programmatic-detach + no-further-event window that self-heals on the next event; a proper teardown hook would require plumbing board lifecycle from `PreviewController` — invasive gold-plating for a theoretical, self-correcting window. Documented, deliberately deferred.

## Net change vs round 2
All 7 round-1/2 findings (B1, B2, B3, W4, S5/L3, S6, W7) remain **FIXED** in the redesigned code. Round 3's findings are all NEW (or a narrowed residual of B2), and all are **defensive / corrupt-manifest-only / polish** — none affect the happy path or real CLI-produced manifests, none block the feature.

## Session IDs
- frontend: review-render-vault-workflow-board-frontend (ae91f689111309532)
- data-security: review-render-vault-workflow-board-data-security (a2fc3868a3945083c)
- logic: review-rvwb-logic3 (aa986bd411b0a5cf9) — codex 503 → re-run on Claude
- contracts: review-rvwb-contracts3 (a323fd611440da8f4) — codex 503 → re-run on Claude
