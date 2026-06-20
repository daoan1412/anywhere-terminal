# Workflow State: fix-claude-terminal-respawn

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [/] 2. Discovery
  - [ ] Execute workstreams (parallel finder/librarian subagents)
  - [ ] Fill `discovery.md` — findings, gap analysis, options, risks
  - [ ] **GATE 1: user approved direction** _(skip for trivial)_
- [ ] 3-6. Artifact Generation (batch)
  - [ ] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [ ] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [ ] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [ ] Fill tasks.md (deps, refs, done, test, files, approach)
- [ ] 7. Validation
  - [ ] `bun run asm change validate` passes
  - [ ] Oracle review _(manual — only if user asks; triage → user confirms → fix, never auto-fix)_
  - [ ] **GATE 2: user approved plan**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [ ] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [ ] 2. Execute tasks sequentially in dependency order
- [ ] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [ ] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [ ] Type check
  - [ ] Lint
  - [ ] Test
  - [ ] E2E
- [ ] 5. Review _(manual — user runs `/asimov-review-start`; skip for trivial or doc/design-only)_:
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

**Symptom (user report):** Running `claude` (Claude Code CLI) inside an Anywhere Terminal → Claude asks to confirm a command (permission prompt) → user answers "yes" → VS Code's native/default integrated terminal opens/reopens (focus jumps away from the Anywhere Terminal).

**Pointers from user:**
- Claude bundle on disk: `/Users/huybuidac/.local/share/claude`
- Reference for extracting/de-minifying the claude bundle: `/Users/huybuidac/Projects/open/claude-code-patch-skills`

**Complexity:** standard — root cause unknown; spans PTY env spawning + Claude Code's VS Code/IDE integration + possibly VS Code command interception. Multiple candidate root causes.
**Escalation flags:** unresolved-unknown (must inspect Claude Code bundle behavior to confirm root cause & feasibility) → forces Discovery + Design.
**Required stages:** discovery, proposal, specs, design, tasks, validate.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->
<!-- Author: git user. Get it: git config user.name -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
