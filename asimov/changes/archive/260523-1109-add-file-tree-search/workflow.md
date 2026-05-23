# Workflow State: add-file-tree-search

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
  - [-] E2E
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review
- [x] 6. Findings triage: accept/rebut each finding with rationale
- [x] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [x] 8. Validation
  - [x] **Gate: user approved implementation**
  - [ ] Extract knowledge

## Archive

- [-] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [-] Run deploy command
  - [-] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

Complexity: standard — new UI mode + search algorithm spanning webview/extension-host with perf trade-offs
Escalation flags: unresolved-unknown (VSCode port feasibility + perf), cross-boundary (webview ↔ extension host if backend indexing)

User intent:
- Add search icon to file tree header
- Click → header becomes search input (mode switch)
- Sophisticated + optimized search (fuzzy/incremental/indexed)
- Open question: should we port from /Users/huybuidac/Projects/ai-oss/vscode?

Bundle delta (5_2): pre-change webview.js = 3,691,560 bytes; post-change = 3,707,348 bytes. Delta = +15,788 bytes (~15.4 KB), well below the 50 KB internal budget. filters.ts had ALREADY been vendored transitively when the listWidget closure was pulled (see existing MANIFEST entry at line 310), so 1_1's "vendoring" was a no-op verification; the +15.4 KB is the consumer code (matching.ts adapter, renderHighlightedText, FileTreeSearchController, search bar DOM/CSS, renderer changes).

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-23T00:00:00Z | huybuidac | Stage 1 | Created change scaffold; classified standard; flags=unresolved-unknown+cross-boundary | Project context + memory + asm change list |
| 2026-05-23T00:00:00Z | huybuidac | Stage 2 | Discovery: code surface map + VSCode find widget research; persisted research note `docs/research/20260523-file-tree-search-mechanisms.md` | finder + librarian parallel workstreams |
| 2026-05-23T00:00:00Z | huybuidac | Gate 1 | Scope=active folder, algorithm=port VSCode `fuzzyScore`, display=flat list, modes=Filter+Highlight toggle | User answered Gate 1 questions |
| 2026-05-23T00:00:00Z | huybuidac | Stages 3-6 | Batch-wrote proposal, 5 specs (file-tree-search, vscode-fuzzy-scorer-vendor, file-tree-widget, file-tree-panel, file-tree-rpc), design.md (10 decisions + risk map), tasks.md (21 tasks across 5 sections) | Plan complete, ready for validation |
| 2026-05-23T00:00:00Z | huybuidac | Stage 7 (oracle) | Oracle review found 1 BLOCKER + 5 IMPORTANT + 1 NIT. ALL accepted. Applied: D11 added (enumerate `**/*` then client-side fuzzy-score, with cache); D4 redefined Highlight = up to 2000 enumerated files; D1 dropped HighlightedLabel vendoring; D3 pinned row format = `relativePath`; D7 scores against relativePath only; RPC spec dropped query from glob, added post-findFiles rootGeneration recheck + token dispose-in-finally; file-tree-search spec added edge-cases requirement (unicode, wildcards, empty query, folder match); tasks.md dropped 1_3 HighlightedLabel task, moved bundle measurement into 1_1, expanded 1_5 + 3_3 with cancellation + cache test coverage. Re-validated: pass. | Strengthen plan before build |
| 2026-05-23T09:39:00Z | huybuidac | Build | Implemented 19 tasks (5_1 manual smoke is dev-host only). Pre-existing baseline: webview.js = 3,691,560 B. Post-build: 3,707,348 B → delta = +15,788 B (~15.4 KB), well under 50 KB budget. filters.ts was already vendored transitively from listWidget (MANIFEST entry pre-existed). New files: src/providers/fileTreeSearchHandler.ts (+ tests); src/webview/fileTree/search/{FileTreeSearchController,matching,renderHighlightedText}.ts (+ tests). Modified: messages.ts (RequestFileTreeSearch + Response + Result); Tree.ts (setFilter, setFlatItems, focusNext/Previous/getFocused, ITreeFilter/IMatch/IMatchData); ITreeRenderer.ts (matchData arg); ReadOnlyFileRenderer.ts (searchRow variants); FileTreePanel.ts (search button, search bar DOM, scope resolution, keyboard wiring, controller integration); fileTreePanel.css (search-bar + match highlight styles); FileTreeHost.ts (request-file-tree-search dispatch); FileTreeController.ts + MessageRouter + main.ts (response routing); WebviewState.ts (searchMode optional field). Verify Gate: type-check pass, biome lint pass (5 pre-existing CSS-specificity warnings; not introduced by this change), 1024 vitest tests pass (was 974 before; +50 new). E2E N/A per project.md. | Build phase complete |
| 2026-05-23T09:57:00Z | huybuidac | Build (hotfix) | User reported runtime bug: search RPC silently dropped — typing in the search bar produced no results. Root cause: both `TerminalViewProvider` (line 498-499) and `TerminalEditorProvider` (line 424-425) had switch cases listing ONLY `request-read-directory` and `request-set-file-tree-position` for FileTreeHost dispatch; the new `request-file-tree-search` message type fell through unmatched and was silently ignored at the provider boundary. Added `case "request-file-tree-search":` to BOTH provider dispatch tables. Added `src/providers/fileTreeHost.test.ts` regression test asserting `handleMessage` claims the search-RPC type. 1026 vitest tests pass (+2 new). Bundle unchanged. | Restore end-to-end search functionality |
| 2026-05-23T10:04:00Z | huybuidac | Build (followup) | User requested: hidden files / system files / node_modules / gitignore-matched files should NOT appear in search results. Added `readCombinedExcludeGlob()` helper to `fileTreeSearchHandler.ts` that combines enabled patterns from BOTH `files.exclude` and `search.exclude` user settings into a brace-expansion glob, then passes it as the `exclude` arg to `findFiles`. VS Code's default `search.exclude` already covers `**/node_modules`, `**/bower_components`, `**/*.code-search`; default `files.exclude` covers `**/.git`, `**/.svn`, `**/.hg`, `**/CVS`, `**/.DS_Store`, `**/Thumbs.db`. Users can customise further via settings. Added 5 new tests (4 for `readCombinedExcludeGlob` covering empty config / dedupe / brace-wrap / single-pattern; 1 for handler forwarding the glob to findFiles). 1031 vitest tests pass. Extension bundle +345 B; webview bundle unchanged. | Hide irrelevant files from search results |
| 2026-05-23T10:07:00Z | huybuidac | Build (followup) | User asked for .gitignore-matched files also excluded ("build files, ignored things shouldn't be searched"). Added `getIgnoredPaths` injection point to `SearchVscodeApi` wired to the existing `gitIgnoreChecker.getIgnoredPaths` helper (spawns `git check-ignore -z --stdin`, 1.5s timeout, single subprocess per enumeration). Filter runs AFTER `findFiles` but BEFORE building the response — token cancellation + rootGeneration re-checked post git-call (the spawn can take up to 1.5s). Falls back to no filtering when git is missing / scope isn't a repo / call times out (empty set returned). Truncation flag still reflects `findFiles` cap rather than post-filter count so the user sees the overflow footer when the scope is too large. Added 3 new handler tests (drop ignored paths, truncated flag preserved across full-filter case, graceful gitignore-failure path). 1034 vitest tests pass. Extension bundle +223 B; webview unchanged. | Filter out build artefacts and gitignored files from search results |
| 2026-05-23T11:00:00Z | huybuidac | Review | Two-round review: (1) per-file specialists (asm-review-logic + contracts + frontend) — produced `.reviews/round-1.md`, WARN verdict, 5 WARN + 5 SUGGEST findings (type duplication, provider duplication, `renderHighlightedText` append-only naming, header-button boilerplate × 3, `maxResults` unenforced contract, synthetic-row dual encoding). Logic agent autonomously fixed 4 lifecycle bugs mid-review (B1-like remount stale, B2-like cache-on-reentry, click-on-sentinel, host disposal). (2) Oracle pass (architecture + debt + simplify) — produced `.reviews/round-1-oracle-followup.md`, REJECT verdict, surfaced 5 real bugs + 3 policy issues + ~310 LOC of dead code missed by per-file review. | User feedback "code review không hiệu quả" — depth pass with oracles |
| 2026-05-23T11:05:00Z | huybuidac | Review Fix Loop | Shipped 17 of 18 worthwhile fixes from both rounds. Bugs: B1 (remount nulls searchController), B2 (persistCurrentState merges searchMode), B3 (`isPathInside` instead of startsWith — `/repo2` no longer matches `/repo`), B4 (Enter routes through `handleActivate`), B5 (validate before cancel prior). Policy: P1 (drop OUT_OF_WORKSPACE — align with browse), P3 (`cancel-file-tree-search` message + host `cancelCurrent()`). Deletions: X1 (Tree.setFilter + ITreeFilter dead code + Tree.filter.test.ts entirely → −265 LOC), X2 (SearchClock → vi.useFakeTimers, −30 LOC), X3 (SearchVscodeApi 6 fields → 2), X4 (drop focus pass-throughs). Round-1 carryovers: S3 (dedup IMatchData ↔ ITreeMatchData, canonical in ITreeRenderer.ts), S4 (collapse RootProvider/SearchRootProvider), S5 (makeHeaderButton helper), W3 (clamp maxResults host-side [1, 5000], default 2000), W4-cheap (OVERFLOW_SENTINEL_PATH + ERROR_SENTINEL_PATH constants), W5 (renderHighlightedText self-clears via replaceChildren). Skipped (need explicit decisions): P2 (browse vs search exclude-glob asymmetry), D1 (split Tree<T> + FlatList<T>), D2 (FileTreeRow union — replaces FileNode.searchRow + sentinel paths). Verify: 1034 vitest pass, tsc clean, esbuild bundles fine. | Fix everything worth fixing per user direction |
