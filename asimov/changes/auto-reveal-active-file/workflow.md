# Workflow State: auto-reveal-active-file

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
- [ ] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [ ] 2. Execute tasks sequentially in dependency order
- [ ] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
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

**Complexity:** standard
**Escalation flags:** `cross-boundary` (extension host editor events → IPC → webview tree), `ui-impact` (file tree behavior change + settings toggle), `perf-sensitive` (editor focus fires frequently; need debouncing + lazy folder expansion)

**User intent:**
- Auto-detect file currently focused in VS Code editor
- Auto-reveal/focus that file row in the file tree panel (expand parent folders, scroll into view, select)
- Behavior similar to VSCode's built-in `explorer.autoReveal` feature
- May research VSCode source at `/Users/huybuidac/Projects/ai-oss/vscode` to learn proven patterns

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-23 | asimov-plan | Discovery | Spawned 3 parallel workstreams (finder ×2, librarian), filled discovery.md with 4-option matrix | Stage 2 |
| 2026-05-23 | asimov-plan | Gate 1 | User chose O1 (VSCode-parity) + tabGroups trigger + default `true` + drop-when-hidden | Approved direction |
| 2026-05-23 | asimov-plan | Artifacts | Batch-wrote proposal.md, specs/auto-reveal-active-file/spec.md, design.md (7 D's), tasks.md (8 tasks in 4 groups) | Stage 3-6 |
| 2026-05-23 | asimov-plan | Validation | `bun run asm change validate` passed; oracle review verdict BLOCK with 7 findings | Stage 7 |
| 2026-05-23 | asimov-plan | Oracle triage | Accepted all 7 findings: (1) message shape — added `absPath?` + made `sessionId/cwd` optional; (2) host has no panel.open — flipped to webview-side gate via `source === 'autoReveal' && !open`; (3) multi-root — scoped v1 to first workspace folder explicitly; (4) path normalization — added D8 with separator + case rules; (5) diff inputs — explicitly excluded; (6) settings schema — boolean+string union; (7) drop `@types/minimatch`. Re-validated: passes. | Oracle round-trip |
| 2026-05-23 | asimov-plan | Gate 2 | User approved plan for handoff to builder | Stage 7 complete |
| 2026-05-23 | asimov-build | Build | Implemented all 8 code tasks (1_1, 1_2, 1_3, 2_1, 3_1, 3_2, 3_3, 4_1). 969 → 971 unit tests pass. Type-check + lint clean. Note: project's `pnpm run lint` OOMs locally; ran biome direct with `NODE_OPTIONS=--max-old-space-size=8192`. minimatch installed as devDep (matches project convention — esbuild bundles all). VS Code 1.105 has no `onDidChangeActiveTab`, so subscribed to `onDidChangeTabs` + `onDidChangeTabGroups` and read `activeTabGroup.activeTab`; spec + design updated. | Build phase |
| 2026-05-23 | asimov-review | Round 1 | 2 WARN findings: W1 schema-vs-reader drift (contracts), W2 path-prefix `..foo` false negative (logic). No BLOCK. | Round 1 review |
| 2026-05-23 | user | Manual smoke | Reported W3: auto-reveal lands row at viewport bottom instead of center | User-reported |
| 2026-05-23 | asimov-build | Triage round 1 | All 3 findings accepted + fixed: (W1) widened package.json schema for `autoRevealExclude.additionalProperties` to accept boolean OR object; (W2) replaced `rel.startsWith("..")` with explicit `rel === ".." \|\| rel.startsWith("..${sep}")` check + added 2 regression tests; (W3) added optional `relativeTop?: number` to `Tree<T>.revealElement` + threaded `0.5` for auto-reveal in `FileTreePanel.revealPath`. Spec updated with new requirement "Auto-reveal centers the row in the viewport". | Triage |
