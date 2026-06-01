# Workflow State: preview-subagent-popup

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
  - [x] **GATE 1: user approved direction** _(surface=terminal-click, map=process-tree+fallback, scope=any-on-disk-subagent)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite M, scope, risk MEDIUM, E2E NOT REQUIRED)
  - [x] Fill specs/ — terminal-subagent-preview (3 reqs) + claude-running-session-map (3 reqs)
  - [x] Fill design.md _(standard + MEDIUM risk — D1..D8 + Interfaces + Risk Map)_
  - [x] Fill tasks.md (11 tasks, dependency-ordered)
- [/] 7. Validation
  - [x] `bun run asm change validate` passes (re-validated after oracle fixes)
  - [x] Oracle review _(SHIP-WITH-FIXES; 1 blocker + 3 major + 5 minor — ALL accepted & applied; see Revision Log)_
  - [x] **GATE 2: user approved plan** _(2026-06-01 — approve & stop; build later via /asimov-build)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order _(11/11 done)_
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check _(`pnpm run check-types` — tsc clean)_
  - [-] Lint _(biome `pnpm run lint` OOMs in this repo — gated by tsc + vitest per project memory)_
  - [x] Test _(`pnpm run test:unit` — 2006 pass / 0 fail; full suite run 10× for jsdom isolation, all green)_
  - [-] E2E _(N/A — project.md § Commands → E2E: N/A; live click→preview is a manual smoke deferred to the user)_
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review _(round 1: 4 review agents — logic/data-security/frontend/contracts; 0 BLOCK, 4 WARN + 4 SUGGEST; see `.reviews/round-1.md`)_
- [x] 6. Findings triage: accept/rebut each finding with rationale _(4 accepted + fixed, 4 rebutted/deferred with rationale)_
- [x] 7. Review Fix Loop _(round 1 only — 0 BLOCK after fixes; re-verify tsc + 2006 tests green → exit)_
- [/] 8. Validation
  - [ ] **Gate: user approved implementation** _(awaiting)_
  - [ ] Extract knowledge _(after approval)_

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Complexity:** standard — cross-cutting (claude session reader + webview preview modules), MEDIUM risk, multiple design options (CLI-running detection, subagent record parsing, popup rendering reuse).

**Escalation flags:** unresolved-unknown (feasibility of "detect claude CLI running" from inside the VS Code extension; subagent→sub-session linkage in the JSONL format).

**Worktree:** Working in worktree `worktree-preview-subagent-popup` (branched from local HEAD 720923f). asm CLI run from main-repo absolute path `/Users/huybuidac/Projects/ai-oss/anywhere-terminal` (.agents gitignored, absent in worktree). NOTE: main repo has uncommitted in-flight vault decomposition (preview*/renderAtoms/vaultListView/claude*Reader modules) NOT present in the worktree — discovery reads those from the main-repo working tree.

**✅ PIVOT CONFIRMED (2026-05-31):** Surface = the **terminal (xterm) where Claude Code CLI is running**, NOT the vault panel. Trigger = **CLICK** (user-chosen, not hover) a subagent line in live CLI output (e.g. `⏺ Explore(...) · Done (...)`) → body-mounted popup previewing that subagent's sub-session. Work in **main** (worktree dropped; `asimov/` gitignored in main + reuses uncommitted vault decomposition there). Reuses xterm link-provider (`FilePathLinkProvider` pattern → new `SubagentLinkProvider`), `HoverPreviewPopup` (click-capable), vault `readClaudeSubagentDetail` + `renderNestedInto`. NEW: running-session registry reader + pty→claude-pid→sessionId resolver. discovery.md rewritten for terminal surface. xterm source available at `/Users/huybuidac/Projects/ai-oss/xterm.js`.

**User research questions (must answer in discovery.md):**
1. Can we detect that the Claude CLI is currently running (live session)?
2. How to parse the session UI/records to resolve the correct subagent (e.g. `Explore(...)` Task invocation → its sub-session transcript).
3. What can be reused from existing file preview (`file-link-hover-preview`) and session preview (`vault-session-preview`)?
4. OSS references (no guessing): `/Users/huybuidac/Projects/ai-oss`, `/Users/huybuidac/Projects/ai-oss/claude-code`.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-31T22:44:51Z | claude | Stage 1 | Scaffolded change, classified standard + unresolved-unknown, recorded research questions | Context + triage complete, entering discovery |
| 2026-05-31T23:32:56Z | claude | Stage 2 | Ran discovery (finder + librarian ×2); user pivoted surface vault→terminal-click + work-in-main; rewrote discovery.md for terminal surface | Corrected feature framing; ready for Gate 1 on mapping precision + clickable scope |
| 2026-05-31T23:49:23Z | claude | Stage 3-7 | Gate 1 approved (A1 process-tree+fallback, B1 any-on-disk); wrote proposal+2 specs+design+tasks (11 tasks); `asm change validate` passed | Plan drafted + validated; at Gate 2 (oracle offered) |
| 2026-06-01T02:36:48Z | claude | Stage 7 | Oracle review (SHIP-WITH-FIXES). Accepted+applied all: #1 BLOCKER header-only match (no trailer join, ILink.range single-row); #2 stub-bag flat render (nested expand out of MVP); #3 reuse listClaudeSubagentStubs, drop cwd (no encodeProjectDir); #4 multi-claude mtime tie-break + cwd-alias note; #5 activate(event) signature; #6/#7 disposal granularity (factory-singleton, not per-session); #8/#9 no-change. Re-validated OK | Oracle hardened the plan; awaiting Gate 2 approval |
| 2026-06-01T02:43:15Z | claude | Gate 2 | User approved plan (approve & stop). Plan phase complete; build deferred to /asimov-build | Plan signed off |
| 2026-06-01T03:08:46Z | claude | Build | Tasks 1_1/1_2/1_4/2_1 done (tsc + 23 unit tests green). Interface refinements synced to design.md: async signatures (list/descendant), `startedAt:number`, DI deps on runningSessions/resolveClaudeSession, optional options/limit on resolveSubagentDetail, exported pure `collectDescendants` | Host readers + IPC types landed |
| 2026-06-01T03:20:00Z | claude | Build | Tasks 1_3 (resolver, 8 tests) + 2_2 (host handler, both providers) done; tsc clean. 2_2 = thin wiring over unit-tested cores → manual smoke per plan. No SessionManager change needed (TerminalSession.pty.pid is public); editor provider needs no vaultService (uses readers directly) | Host side complete (1_1–2_2) |
| 2026-06-01T03:45:00Z | claude | Build | Webview tasks 3_1 (parser+provider, 23 tests) / 3_2 (factory register+activate) / 4_1 (SubagentPreviewPopup, 9 jsdom tests) / 4_2 (router+factory+main wiring) / 4_3 (dispose on tab+split teardown). Deviations recorded: D6 popup is lightweight fixed element NOT FloatingWindow (transient — no resize/move/persist); 4_2 scope += MessageRouter.ts (idiomatic routing table, mirrors vault* cases). Verify gate: tsc clean, vitest 2006 pass ×10 (jsdom isolation OK), biome skipped (OOM), E2E N/A. Live click→preview smoke = manual, deferred to user | All 11 tasks code-complete; entering review |
| 2026-06-01T04:05:00Z | claude | Review | Round 1 (4 agents). 0 BLOCK. Accepted+fixed: deterministic mtime tie-breaks in resolveClaudeSession + subagentLookup (lexical 2nd key); dispose popup on keyboard switchTab; SubagentPreviewResponseMessage → strict XOR (mirror VaultSessionDetailResponse). Rebutted: clipped-`)` no-link (out-of-MVP, false-positive regression); unbounded existing readers (out of scope, user-owned data); description clamp + first-paint flash (harmless). Re-verify tsc + 2006 tests green. Triage: round 1: 4 accepted, 4 rebutted. Details: .reviews/round-1.md | Review complete; 0 BLOCK → done |
| 2026-06-01T04:30:00Z | claude | Build (rework) | User feedback: popup looked inconsistent with the session preview (only the transcript body was reused). User chose "Reuse full shell". Reworked SubagentPreviewPopup to reuse `.vault-preview` card + `FloatingWindow` (resize/move/maximize, in-memory geometry) + session-style header (claude badge + `@agentType` chip + description title + maximize/close + Activity meta) + `PreviewScrollNav`. Threaded `agentType` parser→`SubagentLinkProvider.onActivate`→`handleSubagentClick`→`open`. Updated design.md D6 (full-shell final decision supersedes the interim lightweight note) + tasks.md 4_1 note + popup test. Re-verify: tsc clean, vitest 2007 pass ×10 (jsdom isolation OK) | Popup now visually consistent with session preview |
| 2026-06-01T05:22:20Z | claude | Build (de-dup refactor) | User flagged "two UIs for one problem": the full-shell-reuse build reused leaf components but DUPLICATED the card-assembly, close-listeners, and the header (hand-rolled `buildHeader`). Extracted ONE shared `FloatingPreviewShell` (card + FloatingWindow + PreviewScrollNav + close-listeners + tooltip disposers + render/show/hide/dispose) and genericized `buildPreviewHeader(model, cb)` (vault-only prev/next/resume render only when callback supplied). Composed BOTH `PreviewController` (public API unchanged) and `SubagentPreviewPopup` (deleted duplicated chrome) onto them. New §6 tasks (6_1–6_4). Updated design.md D6 + Interfaces. Verify: tsc clean; vitest 2024 pass (added FloatingPreviewShell 11 + previewHeader 6; VaultPanel 100 + popup 10 unchanged); 10× full-run isolation OK; biome skipped (OOM) | One preview UI, two consumers — cannot diverge |
| 2026-06-01T05:40:00Z | claude | Review (round 2) | De-dup refactor reviewed by 3 agents (frontend, logic, contracts; data-security skipped — no data/IPC/auth surface). 0 BLOCK / 0 WARN / 0 SUGGEST. All HIGH-confidence clean: close-path no-recursion, listener attach/detach symmetry, vault regression preserved (VaultPanel 100 green + logic agent re-ran tsc+vitest), DOM/class parity, geometry survival, clean composition + unchanged PreviewController API. One out-of-scope pre-existing observation noted (resume btn native `.title` alongside custom tooltip — not introduced here). Details: .reviews/round-2.md | APPROVE — clean review, 0 BLOCK |
