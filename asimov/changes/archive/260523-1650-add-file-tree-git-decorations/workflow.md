# Workflow State: <change-id>

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
  - [-] E2E _(project.md declares N/A)_
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
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

Complexity: standard — touches extension host (git status source), IPC, webview tree rendering, theming; needs decisions on git data source (VS Code git extension API vs raw file watcher vs `git status` shell-out) and decoration semantics (status badges, color tinting, parent-folder propagation).

Escalation flags: cross-boundary (extension host ↔ webview tree UI), new-dependency (consuming VS Code built-in git extension exported API — new integration point for this repo).

Reference codebase: VSCode source at `/Users/huybuidac/Projects/ai-oss/vscode` provided by user for pattern study (read-only — use as inspiration, not vendor target).

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-23 | claude (asimov-plan) | Stage 1 | Created change scaffold; triaged as **standard** with flags `cross-boundary` + `new-dependency` | Cross-boundary (extension host ↔ webview) + new VS Code git API integration → design.md required |
| 2026-05-23 | claude (asimov-plan) | Stage 2 | Discovery completed via 3 parallel workstreams (finder, librarian, memory recall); options A/B/C surfaced | Established codebase entry points, VSCode reference behavior, and IPC/theming constraints before planning |
| 2026-05-23 | claude (asimov-plan) | Gate 1 | User chose Option A (built-in git API) + match-VSCode UX + migrate `.is-ignored` to `gitDecoration` colors | All three recommended options accepted |
| 2026-05-23 | claude (asimov-plan) | Stages 3-6 | Batch-wrote proposal + 2 spec capabilities (git-decoration-source, file-tree-git-decorations) + design (9 decisions, 8-row risk map) + 12-task plan | Standard-complexity escalation path: every required artifact populated |
| 2026-05-23 | claude (asimov-plan) | Stage 7 | Oracle review returned 3 HIGH + 3 MEDIUM + 1 LOW findings | Independent second opinion before approval |
| 2026-05-23 | claude (asimov-plan) | Stage 7 | All 7 oracle findings ACCEPTED. Design grew to 13 decisions (added D10 revision counter, D11 single transition fn, D12 per-repo maps, D13 search lookup); spec tightened (snapshot+delta both carry revision; `deleted` no longer propagates; lifecycle covers absent/disabled/uninitialized; per-repo maps replace `startsWith`); tasks 1_1, 2_1, 2_2, 3_1, 3_2, 4_1, 4_2, 4_3, 5_1, 6_1 updated; pure-mapper task added to 2_1 scope | Oracle correctly identified 3 HIGH correctness bugs (race, refcount drift, prefix collision) that would have shipped without these fixes |
| 2026-05-23 | claude (asimov-plan) | Gate 2 | Plan approved | User signed off; ready for builder |
| 2026-05-23T14:46:50Z | claude (asimov-build) | Implement | Completed tasks 1_1 through 7_1. New code: gitDecorationProvider.ts + gitStatusMapping.ts + git.ts (host); types in messages.ts; FileSystemDataSource transition fn + delta apply + pending map; ReadOnlyFileRenderer git-* class + badge; fileTreePanel.css decoration styles; MessageRouter + FileTreeController + FileTreePanel wiring. Tests: gitStatusMapping (22), gitDecorationProvider (11), fileTreeHost (8), FileSystemDataSource (34, +20 new), ReadOnlyFileRenderer (13, +9 new), FileTreeController (2), fileTreeGitDecorations.integration (7). Verify gate: 1107 tests pass, types pass, biome lint clean (2 pre-existing warnings outside scope), bundle: 3.54 MB / 3.60 MB ceiling (98.3 %). | Standard 12-task implementation per the plan; no scope drift |
