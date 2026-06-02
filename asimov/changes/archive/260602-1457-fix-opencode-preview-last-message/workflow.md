# Workflow State: fix-opencode-preview-last-message

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
  - [x] **GATE 1: user approved direction** _(fastlane: Option B head+tail, user confirmed "chọn cái tốt nhất")_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — added `vault-session-preview` requirement "Bounded detail retains both transcript ends" + scenario
  - [-] Fill design.md _(skipped — small + LOW risk + no escalation flags; decisions captured in tasks.md Plan)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [-] Oracle review _(skipped — fastlane; small, LOW risk, no new deps, single-file fix)_
  - [x] **GATE 2: user approved plan** _(fastlane auto-approve; build to be run by user for manual test)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [/] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check — `pnpm run check-types` clean
  - [-] Lint — Biome OOMs in this env (known); swept manually (no dead refs to removed constants)
  - [x] Test — `pnpm run test:unit` 119 files / 2052 tests pass (+2 new)
  - [-] E2E — N/A per project.md
- [-] 5. Review (adaptive — skipped per user directive after manual verification; small/LOW-risk single-function fix, full unit coverage + 2052 tests green):
  - [-] Code Review
- [-] 6. Findings triage: accept/rebut each finding with rationale
- [-] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [/] 8. Validation
  - [x] **Gate: user approved implementation** _("ok rồi đó archive đi")_
  - [x] Extract knowledge _(memory below)_

## Archive

- [-] Deploy Gate _(N/A — no Deploy command in project.md § Commands)_:
  - [-] Run deploy command
  - [-] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Goal:** opencode session preview does not render the final assistant (AI) message of a user turn — claude preview does. Make opencode preview render the trailing assistant message with the same handling as claude preview.

**Context refs:** opencode upstream source available at `/Users/huybuidac/Projects/ai-oss` for cross-checking the opencode session/message format.

Complexity: small — parity fix in the opencode session reader/preview path mirroring existing claude reader behavior; localized to reader/preview modules, LOW risk. (Confirmed small after discovery: fix is contained to `readOpenCodeDetail`.)
Escalation flags: none

**Root cause (confirmed):** `readOpenCodeDetail` loads only the transcript head — `message ASC LIMIT 2000`, `part ASC LIMIT 5000` (`opencodeReader.ts:28-29,485-486`). Claude keeps head+tail via `createBoundedRecordBuffer` (`detail.ts:52`). The `part` cap is the practical trigger (many parts/turn), so the final assistant message's text parts fall outside the window → no `latestMessage`, no trailing `message` timeline item. Short sessions (unit tests) pass.

**Fastlane decisions:** Gate 1 → Option B (head ASC ∪ tail DESC, de-dup by id; total read budget unchanged). design.md skipped (LOW risk). Oracle skipped. Mode: stop at build phase for user manual test.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-06-02T00:00:00Z | claude | Plan (fastlane) | Discovery + proposal + spec delta + tasks for OpenCode head+tail detail read | OpenCode preview drops the final AI message on long sessions (head-only ASC read); mirror Claude's head+tail buffer |
| 2026-06-02T00:00:00Z | claude | Build 1_1 | `readOpenCodeDetail`: head(ASC)∪tail(DESC) per table + `dedupeById` + `windowTruncated`; removed DETAIL_*_LIMIT, added DETAIL_*_HEAD/TAIL; +2 unit tests (long-session, short-overlap) | Fix root cause; verify gate green (tsc + 2052 tests) |
