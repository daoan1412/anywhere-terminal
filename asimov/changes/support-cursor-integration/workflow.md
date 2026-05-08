# Workflow State: support-cursor-integration

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
- [/] 7. Validation
  - [x] `bun run asm change validate` passes
  - [-] Oracle review _(optional — recommended for cross-boundary, MEDIUM+ risk, new-dep; record triage in Revision Log)_
  - [ ] **GATE 2: user approved plan**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [/] 2. Execute tasks sequentially in dependency order
- [/] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [ ] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [ ] Type check
  - [ ] Lint
  - [ ] Test
  - [ ] E2E
- [ ] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [ ] Code Review
- [ ] 6. Findings triage: accept/rebut each finding with rationale
- [ ] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [ ] 8. Validation
  - [ ] **Gate: user approved implementation**
  - [ ] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [ ] Apply deltas: `bun run asm change apply`
- [ ] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

Complexity: standard — Cursor integration has external compatibility and distribution trade-offs beyond a single implementation path.
Escalation flags: unresolved-unknown, cross-boundary
Gate 1: Approved by user direction to continue after concrete Cursor install error showed the compatibility blocker is `engines.vscode` versus Cursor's VS Code 1.105.1 baseline.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-08T23:46:26Z | OpenCode | Implement | Task 1_3 automated verification passed: `pnpm run check-types`, `pnpm run test:unit` (418 tests), and `pnpm run vsix`; Cursor smoke blocked because `cursor` CLI is unavailable and no `/Applications/Cursor*.app` was found. | Record evidence and the remaining manual verification blocker. |
| 2026-05-08T23:43:43Z | OpenCode | Implement | Completed task 1_2; updated README requirements, Cursor VSIX fallback install steps, and Cursor smoke checklist. | Give users and maintainers a repeatable Cursor install and verification path. |
| 2026-05-08T23:43:20Z | OpenCode | Implement | Completed task 1_1; set `engines.vscode` to `^1.105.0`, pinned `@types/vscode` to `1.105.0`, and refreshed `pnpm-lock.yaml`. | Fix Cursor 3.2.21 install rejection while keeping compile-time API checks aligned to VS Code 1.105. |
| 2026-05-08T14:42:10Z | OpenCode | Validation | `bun run asm change validate support-cursor-integration` passed; oracle skipped due LOW risk and no new dependency. | Confirm artifacts are valid and ready for user approval. |
| 2026-05-08T14:40:53Z | OpenCode | Artifacts | Generated proposal, spec, design, and tasks for Cursor 1.105 compatibility. | Plan the direct install fix and verification path after Gate 1 clarification. |
| 2026-05-08T10:58:03Z | OpenCode | Discovery | Added discovery findings and Cursor integration options. | Capture research, gaps, risks, and the recommended direction before Gate 1. |
| 2026-05-08T10:48:55Z | OpenCode | Plan | Completed context and triage for `support-cursor-integration`. | Establish the planning scaffold and required ceremony before discovery. |
