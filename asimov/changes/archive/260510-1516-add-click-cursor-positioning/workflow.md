# Workflow State: add-click-cursor-positioning

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
  - [-] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [/] 7. Validation
  - [x] `bun run asm change validate` passes
  - [-] Oracle review _(optional — recommended for cross-boundary, MEDIUM+ risk, new-dep; record triage in Revision Log)_
  - [ ] **GATE 2: user approved plan**

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
  - [x] Code Review
- [x] 6. Findings triage: accept/rebut each finding with rationale
- [x] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [x] 8. Validation
  - [x] **Gate: user approved implementation**
  - [x] Extract knowledge

## Archive

- [-] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [-] Run deploy command
  - [-] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [x] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

- Complexity: small — one webview terminal-input domain, expected 3-10 files, no new dependency, low-to-medium UX risk.
- Escalation flags: unresolved-unknown resolved during discovery by librarian research; no forced design flag remains.
- Gate 1 recommendation: Option B, plain-click movement handler using existing input path and relative ANSI movement sequences.
- Gate 1 decision: approved Option B, plain-click movement handler.
- Design artifact skipped: low remaining risk, no new IPC/API/dependency, existing webview input architecture remains unchanged.
- Oracle review skipped: remaining risk is LOW and there is no new dependency or cross-boundary contract.
- Follow-up CLI conflict research: guard click-to-cursor to normal buffer with `mouseTrackingMode === 'none'` so OpenCode/Claude/TUI mouse handling can own clicks when active.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-08T09:13:39Z | OpenCode | Plan | Completed context, triage, and discovery for `add-click-cursor-positioning` | Establish evidence and options before Gate 1 direction approval |
| 2026-05-08T09:15:24Z | OpenCode | Plan | Generated proposal, spec delta, and dependency-ordered tasks | Convert approved direction into builder-ready artifacts |
| 2026-05-08T09:16:36Z | OpenCode | Plan | Validation passed with `bun run asm change validate add-click-cursor-positioning` | Confirm artifacts are structurally valid before Gate 2 |
| 2026-05-08T23:58:06Z | OpenCode | Plan | Added follow-up research and guards for alternate buffer and mouse tracking modes | Avoid conflicts with mouse-aware CLIs and TUI applications |
| 2026-05-09T00:02:10Z | OpenCode | Build | Completed task 1_1; `pnpm exec vitest run src/webview/ClickCursorHandler.test.ts` passed 19 tests | Add tested click-to-cursor calculation and guard behavior |
| 2026-05-09T00:03:22Z | OpenCode | Build | Completed task 1_2; `pnpm run check-types` passed and click cursor tests passed 20 tests | Wire click-to-cursor into terminal creation using existing `terminal.input` path |
| 2026-05-09T00:03:56Z | OpenCode | Build | Completed task 1_3; updated `docs/design/keyboard-input.md` and `docs/design/xterm-integration.md` | Document click-to-cursor behavior, guard conditions, and TUI/mouse-mode limits |
| 2026-05-09T00:04:50Z | OpenCode | Build | Verify gate passed: `pnpm run lint`, `pnpm run check-types`, `pnpm run test:unit` (438 tests), and `bun run asm change validate add-click-cursor-positioning`; E2E N/A | Confirm build artifacts, code, and docs are ready for review |
| 2026-05-09T00:08:33Z | OpenCode | Review | Triage round 1: 1 accepted, 2 rebutted. Details: `.reviews/round-1.md` | Fix link-click conflict while preserving xterm normal-buffer movement semantics |
| 2026-05-09T00:10:15Z | OpenCode | Review | Re-review round 2 approved; rebuttals sustained and accepted link fix verified. Details: `.reviews/round-2.md` | Close review loop with 0 remaining accepted findings |
| 2026-05-09T00:10:44Z | OpenCode | Build | Final Asimov validation passed with `bun run asm change validate add-click-cursor-positioning`; post-fix verify passed with lint, type check, and 439 unit tests | Confirm change is ready for user implementation approval |
| 2026-05-10T07:49:38Z | OpenCode | Review | Accepted and fixed round-3 F4; `pnpm exec vitest run src/webview/ClickCursorHandler.test.ts` passed 22 tests, `pnpm run check-types` passed, `pnpm run lint` passed, `pnpm run test:unit` passed 440 tests, and Asimov validation passed | Cover nested xterm link-hover DOM shape before approval |
| 2026-05-10T15:15:45Z | OpenCode | Archive | User approved implementation; knowledge extraction persisted 2 items; deploy gate skipped because project has no Deploy command | Prepare completed change for apply/archive |
| 2026-05-10T15:17:05Z | OpenCode | Archive | Prepared archive commit for `add-click-cursor-positioning` while excluding unrelated `README.md` and `CHANGELOG.md` changes | Capture apply/archive/source changes without committing unrelated worktree edits |
