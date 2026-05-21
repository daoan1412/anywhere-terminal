# Workflow State: track-terminal-cwd

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

Complexity: standard — touches PTY stream parsing (escape sequence handling, chunk-boundary state), SessionManager state model (add currentCwd separate from initialCwd), and openFileLink resolver (insert live-cwd step + add findFiles fallback). Three modules, escape-sequence parsing is novel for this codebase.

Escalation flags: none. No new deps (uses existing node-pty stream + vscode.workspace.findFiles). No new infra. Security-privacy NOT flagged: terminal output IS untrusted, but the worst attack is misdirecting OUR cwd state (already mitigated by the existing out-of-workspace confirm modal from add-clickable-file-paths).

Driver: discovered during manual smoke of `add-clickable-file-paths` (archived as 260521-0215). User scenario: VS Code workspace = `~/`, terminal spawned with initialCwd=`~/`, user `cd`d into project subdir, clicked relative path → "File not found" because resolver only knew initial cwd. Documented as out-of-scope in v1 proposal; this change is the follow-up.

Approach (from prior librarian + oracle research): passive OSC 7 listener as primary (zero-config when shell emits it natively, common on fish + many bash/zsh setups), guarded `vscode.workspace.findFiles` as secondary fallback. NO shell-integration script injection in v1 — wait to see if passive OSC 7 covers the common case.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-21T09:00:00Z | claude (opus-4-7) | Plan | Stage 1-2 + Gate 1 | Triage = standard (escape-sequence parser is novel; no escalation flags). Discovery via finder (architecture) + librarian (OSC 7 wire format + shell landscape; persisted to docs/research/20260521-osc7-implementation.md). Gate 1: chose OSC 7 + OSC 633 variants + findFiles first-match-only with maxResults=1. |
| 2026-05-21T09:00:00Z | claude (opus-4-7) | Plan | Stage 3-6 batch | Wrote proposal.md (M appetite, MEDIUM risk), specs/terminal-cwd-tracking/spec.md (6 ADDED requirements: OSC 7 detection, OSC 633 detection, chunk-boundary handling, pass-through guarantee, sanitization, SessionManager surface), specs/terminal-clickable-file-paths/spec.md (1 MODIFIED requirement: extended Path resolution chain), design.md (D1-D9 + interfaces + risk map), tasks.md (10 tasks across 6 sections). |
| 2026-05-21T09:30:00Z | claude (opus-4-7) | Plan | Stage 7 oracle triage | Oracle VERDICT=REVISE. Accepted all 3 findings: (1) D7 add `escapeGlob` for glob meta chars in user-controlled path + 2s timeout via `Promise.race` — applied to spec MODIFIED requirement, design D7, tasks 4_1/4_2; (2) parser tests must explicitly cover OSC 52 (clipboard) and OSC 1337 (iTerm) skip — added to task 1_2; (3) D9 pass-through strengthened to property/fuzz test (200 random sequences with mix of complete OSCs + partial + unknown + raw bytes) — added to task 1_2. Risk Map row added for glob-meta false positives. Re-validate passed. |
| 2026-05-21T03:10:00Z | claude (opus-4-7) | Implement | Tasks 1_1, 1_2, 2_1, 3_1, 3_2 done | Implemented `src/pty/oscParser.ts` (~140 lines pure parser) + 29 unit tests covering OSC 7 BEL/ST/percent-decode, OSC 633 P;Cwd=, chunk-split at every offset, MAX_PENDING overflow + recovery, OSC 0/8/52/1337 skip, 200-iteration property/fuzz. Added `currentCwd?` + `setCurrentCwd/getCurrentCwd` to SessionManager (+6 tests). Wired `setCurrentCwdSink` into PtySession with pass-through guarantee tests (+6 tests). SessionManager registers sink at spawn. Fixed one chunk-split edge case (offset-2 `\x1b]` needs wait-for-more rather than discard). |
| 2026-05-21T03:15:00Z | claude (opus-4-7) | Implement | Tasks 4_1, 4_2, 4_3, 5_1 done | Extended `OpenFileLinkDeps` with `getCurrentCwd` + `findFiles`. Resolver inserts currentCwd as step 2 before initialCwd. Added `escapeGlob` (exported) + `withTimeout` (internal) helpers; findFiles fallback wrapped with 2000ms Promise.race timeout. Both providers wire the new deps. vscode mock gains `findFiles` + `__setFindFiles` helper. openFileLink test suite +11 cases (currentCwd short-circuit, findFiles hit/miss/throw/multi-match, glob escape, fake-timer timeout). |
| 2026-05-21T03:17:47Z | claude (opus-4-7) | Implement | Verify Gate green | `./node_modules/.bin/tsc --noEmit -p tsconfig.json` clean, `biome check src/` clean, `vitest run` → 546 tests in 27 files passing (baseline 492 in 26 → +54 tests, +1 file `oscParser.test.ts`). E2E marked `[-]` per project.md (declared N/A). |
| 2026-05-21T03:25:00Z | claude (opus-4-7) | Implement | Round 1 review spawned | Logic + data-security + contracts agents in parallel. Verdict BLOCK — 2 BLOCK + 3 WARN + 2 rejected SUGGEST. Findings: B1 PtySession sink exception breaks pass-through, B2 currentCwd in trust bases bypasses modal, W1/C1 findFiles for absolute path dead-end, W2 .. traversal, W3 OSC 633 control-char filter. Saved to .reviews/round-1.md + summary.md. |
| 2026-05-21T03:27:00Z | claude (opus-4-7) | Implement | Triage round 1: 5 accepted, 2 rebutted | All 5 BLOCK/WARN findings accepted. Rejected DS4 (coalesce cwd updates) and DS5 (debounce findFiles) as premature optimization. Details: .reviews/round-1.md. |
| 2026-05-21T03:28:00Z | claude (opus-4-7) | Implement | Round 1 fixes applied | PtySession: try/catch around _oscParser.feed; sink throws no longer block pass-through. oscParser: narrowed handleOsc7 try/catch to URL parse only (was swallowing sink throws); CONTROL_CHARS reject in emitIfValid covers OSC 7 + OSC 633. openFileLink: removed currentCwd from trust bases (kept in resolution only) + added isAbsolutePath/hasTraversal guards before findFiles. Tests: +5 cases covering each fix. Re-verify gate green: 551/551 tests passing. |
| 2026-05-21T03:30:00Z | claude (opus-4-7) | Implement | Round 2 re-review | Resumed all 3 agents via SendMessage. Verdict APPROVE — B1, B2, W1, W2, W3 all SUSTAINED-FIXED, no regressions, no new BLOCK/HIGH. Two SUGGEST observations from data-security confirmed non-actionable. Saved to .reviews/round-2.md. |
| 2026-05-21T03:45:00Z | claude (opus-4-7) | Implement | Off-by-one in FilePathLinkProvider | User reported during manual smoke: underline rendered 1 row off + "File not found" on click. Root cause: `provideLinks(bufferLineNumber)` is 1-based per xterm.js convention (verified in `node_modules/@xterm/xterm/lib/xterm.mjs` and WebLinksAddon source), but `IBuffer.getLine()` is 0-based. Code passed bufferLineNumber directly to getLine → parsed text from the wrong row + link range was at the wrong row. Fixed in `src/webview/links/FilePathLinkProvider.ts:41` (`getLine(bufferLineNumber - 1)`); 1 new regression test added. Scope: fix lives in code introduced by the prior `add-clickable-file-paths` change (archived as 260521-0215) but folded into this change since both bugs are in the same click pipeline. Rebuilt webview bundle (esbuild). All 552 tests green. |
| 2026-05-21T05:30:00Z | claude (opus-4-7) | Implement | Section 7 oracle review + revisions | Oracle WARN with 6 actionable findings. Applied F1 (documented SSH precedence limitation in proposal §Out of scope), F2 (added `sanitize()` helper in processCwd validating absolute path + control bytes + ` (deleted)` suffix), F4 (regression test: liveCwd-resolved path outside trust bases still fires modal), F5 (Linux deleted-cwd → undefined). F3 confirmed (no action). F6 deferred (per oracle's own rec). +7 sanitization tests + 1 trust-boundary regression = 581 tests passing. |
| 2026-05-21T06:47:47Z | claude (opus-4-7) | Implement | Oracle review sections 9-12: triage + fixes | Oracle WARN (0 BLOCK). Accepted all 6 findings: WARN-1 cancel underlying findFiles via `vscode.CancellationTokenSource` on 2s timeout (broadened deps.findFiles signature `token?: CancellationToken`; both providers + mock updated; `withTimeout` now takes `onTimeout` callback that calls `cancelSource.cancel()`; finally block dispose). WARN-2 try/catch around `deps.getFileSearchMaxResults?.()` so a provider throw falls back to default 50 (+console.warn for support). SUGGEST-3 spec amended: step 6 explicitly skipped for absolute paths + traversal segments. SUGGEST-4 spec amended: no-workspace QuickPick labels use absolute fsPath. SUGGEST-5 added 5 tests (Infinity→default, throwing provider→default, `workspaceFolders: []` treated as undefined, file-shape with trailing slash, timeout cancels token). SUGGEST-6 package.json description warns values >200 in no-workspace mode can stall briefly. Mock CancellationTokenSource fix: dispose() must NOT wipe cancellation flag (real VS Code semantics). 608/608 tests passing. Rebuilt bundle. |
| 2026-05-21T06:39:16Z | claude (opus-4-7) | Implement | Section 12: Configurable fileSearch.maxResults (default 50) | User-driven: hardcoded cap of 20 was too low for monorepos with many duplicate filenames. Added `anywhereTerminal.fileSearch.maxResults` setting (number, default 50, min 1, max 1000) to package.json contributes.configuration. Refactored `openFileLink` to consume an optional `getFileSearchMaxResults()` deps method with clamping (`Math.min(Math.max(floor(raw), 1), 1000)`) and NaN guard falling back to the default. Both providers wire `() => vscode.workspace.getConfiguration("anywhereTerminal.fileSearch").get("maxResults", DEFAULT_FIND_FILES_MAX_RESULTS)`. Bumped 2 existing test assertions 20→50 + added 4 new tests (override respected, clamp-ceiling, clamp-min, NaN→default). 603/603 tests passing. Rebuilt bundle. |
| 2026-05-21T06:29:46Z | claude (opus-4-7) | Implement | Section 11: Reject trailing-slash paths in link provider + handler | User feedback: `external-research/` was being underlined as a link and clicking produced "File not found". Two-layer fix: (1) parser `looksLikeFile()` rejects strings ending in `/` or `\` so no underline is drawn; (2) defense-in-depth in `openFileLink()` — trailing slash → silent abort before any stat/findFiles work. +5 tests (3 parser: posix trailing `/`, nested trailing `/`, win32 trailing `\`; 2 handler: posix slash short-circuit, win32 backslash short-circuit). 599/599 tests passing. Rebuilt bundle. |
| 2026-05-21T06:20:29Z | claude (opus-4-7) | Implement | Section 10: findFiles fallback when no workspace | User feedback (DevTools trace): clicking `REQUIREMENT.md` with liveCwd=`/Users/huybuidac/Projects/ai-oss/anywhere-terminal`, `workspaceFolders=[]` → findFiles returned 0 matches because a bare `**/foo` glob has no scope when no workspace is open. Switched include-pattern construction to use `new vscode.RelativePattern(vscode.Uri.file(searchBase), "**/<escaped>")` rooted at `liveCwd ?? initialCwd` when workspaceFolders is empty; plain string glob unchanged when a workspace IS open. If neither workspace nor cwd is known, findFiles is skipped entirely (was: called with empty scope returning 0). Broadened `OpenFileLinkDeps.findFiles` signature `include: vscode.GlobPattern`. Added `RelativePattern` class to vscode mock. Updated 5 existing tests to add workspaceFolders (preserve string-pattern coverage) + added 5 new tests for no-workspace flows. 595/595 tests passing. Rebuilt bundle. |
| 2026-05-21T06:13:19Z | claude (opus-4-7) | Implement | Section 9: Directory-click silent abort | User feedback: clicking a folder path (e.g. `src/providers`) showed "File not found" toast — misleading because the path exists, just not as a file. Added `sawDirectory` flag in candidate stat loop; when `resolvedFsPath === undefined && sawDirectory` we skip findFiles AND skip the error toast (silent return with console.warn trace for support). Updated spec MODIFIED Requirement (terminal-clickable-file-paths step 5 sentence on directory handling). +4 tests: silent abort with 1 dir candidate, silent abort with multiple dir candidates, regression (file in workspace + dir in cwd still opens file), regression (legitimate not-found still shows toast). 590/590 tests passing. Rebuilt bundle. |
| 2026-05-21T06:00:00Z | claude (opus-4-7) | Implement | Section 8: QuickPick disambiguation for findFiles | User-driven: AI CLI prints paths relative to a subfolder, prior maxResults=1 silently failed when workspace had >1 file with same name. Bumped findFiles maxResults to 20. Match-count UX: 0→not found, 1→open (existing), ≥2→`vscode.window.showQuickPick` items mapped to `{label: workspaceRelative, description: absolute, fsPath}`. Cancel/ESC → silent no-op (no error toast). Multi-root workspace: label prefixed with folder basename. New `workspaceRelative` helper handles single/multi-root + out-of-workspace fallback. Wired `showQuickPick` into both providers + vscode mock + `__setShowQuickPick` test helper. Updated spec step 6, design tasks. +6 tests (1 maxResults=20 regression + 5 quickPick scenarios). 586/586 tests passing. |
| 2026-05-21T05:00:00Z | claude (opus-4-7) | Implement | Section 7: PID-based live cwd query (Option B) | User-driven pivot: after manual smoke surfaced "no workspace + no OSC 7" gap, replaced reliance on shell-side cooperation with OS-level PID-to-cwd lookup. Added `src/pty/processCwd.ts` (Linux `/proc/<pid>/cwd`, macOS `lsof -p <pid> -d cwd -Fn` capped at 500ms, Windows returns undefined). Added `SessionManager.getLiveCwd(sessionId): Promise<string \| undefined>` that delegates to `queryProcessCwd(session.pty.pid)`. Extended `OpenFileLinkDeps` with optional `getLiveCwd`. Refactored `buildCandidates` to take async-pre-resolved liveCwd and insert as step 2 (between absolute and OSC-currentCwd). Wired both providers. Updated specs (`terminal-cwd-tracking` ADDED "Live cwd query via process table"; `terminal-clickable-file-paths` MODIFIED to 6-step chain). Added D10 + D11 + 5 risk map rows. +13 processCwd tests, +3 SessionManager tests, +5 openFileLink tests, +2 dispatch contract checks. Verify gate green: 573/573 tests, TS clean, lint clean. Rebuilt bundles. |
