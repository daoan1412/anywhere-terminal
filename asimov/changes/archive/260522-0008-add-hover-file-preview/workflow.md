# Workflow State: add-hover-file-preview

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
  - [x] **GATE 1: user approved direction** — Shiki overlay; silent OOW preview; rendered markdown; lazy-load all langs
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [x] Oracle review — REVISE with 14 findings, all accepted, full revisions applied; followed by deep-research pass (librarian + finder) to firm up Shiki v4.1.0 API surface + xterm DOM model; second-round revisions applied
  - [x] **GATE 2: user approved plan**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — `asimov/project.md` § Commands:
  - [x] Type check — `pnpm run check-types` exits 0
  - [x] Lint — `pnpm run lint` (auto-format applied by package step)
  - [x] Test — 37 test files / 758 tests passing
  - [-] E2E — N/A per `asimov/project.md`
- [x] 5. Review — user requested oracle review with multiple specialists:
  - [x] Code Review (in-build) — 3 parallel oracles (resolver+reader / webview / IPC+wiring); 1 BLOCK + 5 WARN + several SUGGEST
  - [x] Code Review (round 1, persisted) — 4 parallel specialists (data-security / logic / contracts / frontend); 1 BLOCK + 7 WARN + 5 suppressed
- [x] 6. Findings triage:
  - [x] In-build: 1 BLOCK + 5 WARN accepted/fixed
  - [x] Round 1: 1 BLOCK + 7 WARN accepted; SUGGESTs deferred. User requested SCOPE EXPANSION on top (trust policy + Cmd-override + line-focus + line numbers + word-wrap + footer settings)
- [x] 7. Review Fix Loop
  - [x] Round 1 (in-build): all fixed; 766 tests
  - [x] Round 2: 7 WARNs fixed + B1 trust policy + scope expansion (C/D/E); 800 tests; bundle 2.93 MB / 3 MB
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

Complexity: standard — new UX (hover preview), webview↔host IPC contract, syntax highlighting/file rendering decision pending discovery, multiple architectural options.

Escalation flags: new-dependency (likely syntax highlighter — Shiki or similar), cross-boundary (new webview→host IPC for file content/render), unresolved-unknown (feasibility of reusing VSCode's built-in renderer; needs research against /Users/huybuidac/Projects/ai-oss/vscode source).

Required stages: discovery + proposal + specs + design + tasks (full ceremony).

User intent (verbatim):
- "hover vào file link file thì hiện dialog preview luôn file"
- "thử xem có dùng được cái file render mặc định của vscode ko thì sẽ có format đẹp đẽ luôn"
- reference VSCode source at /Users/huybuidac/Projects/ai-oss/vscode

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-21T00:00:00Z | planner | Plan/1 | Created change scaffold; triaged complexity=standard; flags=new-dependency, cross-boundary, unresolved-unknown | User asked to plan hover-preview popup over file links; explore VSCode rendering reuse |
| 2026-05-21T00:00:00Z | planner | Plan/2 | Ran 2 parallel discovery workstreams (finder + librarian); wrote discovery.md; persisted research at docs/research/20260521-vscode-file-preview-rendering.md | Map existing plumbing + assess VSCode-internal vs external renderer options |
| 2026-05-21T00:00:00Z | planner | Plan/Gate1 | User approved Option B (Shiki overlay), silent OOW preview, rendered markdown via @shikijs/markdown-it, lazy-load all langs | Direction set for artifact batch |
| 2026-05-21T00:00:00Z | planner | Plan/3-6 | Batch-wrote proposal.md, specs/file-link-hover-preview/spec.md, design.md (9 decisions + risk map), tasks.md (4 sections, 12 tasks) | Standard ceremony per escalation flags |
| 2026-05-21T00:00:00Z | planner | Plan/7 | Oracle review returned REVISE: 3 plan-killers + 11 findings | Cross-boundary + MEDIUM risk + new-dep warranted independent review |
| 2026-05-21T00:00:00Z | planner | Plan/7 | Accepted: switch to STATIC curated grammar bundle (D1 rewritten); two-tier file-read cap (D6 rewritten — 1 MB hard + 200 KB preview); cancellation split into webview stale-id + host supersession (D9 rewritten); added D10 (lifecycle) + D11 (early bundle gate); spec adds absPath header, a11y/inertness, lifecycle, host-token-map cleanup, z-index, max popup dimensions; tasks add 1_1b early bundle gate, fix bundle path to media/webview.js, tighten 2_2 read cap with no-readFile-on-large assertion, 2_3 session-close cleanup, 3_2 a11y/click-outside/Escape, 3_3 static-import audit, 3_5 dispose integration tests, 4_1 smoke checklist expanded to 14 items including all 4 theme kinds; user reconfirmed silent OOW preview + curated static bundle at GATE 1.5 | Address feasibility + correctness issues before build phase |
| 2026-05-21T00:00:00Z | planner | Plan/7 | `bun run asm change validate` passed post-revisions | Verify revised plan still meets schema |
| 2026-05-21T00:00:00Z | planner | Plan/7 | Deep-research pass: librarian verified Shiki v4.1.0 import paths + light-plus/dark-plus availability + esbuild static-import tree-shaking (persisted to docs/research/20260521-shiki-v3-api.md); finder verified xterm `xterm-hover` detection logic, confirmed popup must parent to `terminal.element` (NOT screenElement), found xterm decoration z-indices ≤ 8 | Firm up Shiki API surface + xterm DOM model before build |
| 2026-05-21T00:00:00Z | planner | Plan/7 | Applied research findings: bumped z-index to 1000 (above xterm decoration layers); switched markdown rendering from @shikijs/markdown-it (CSS-var 2-theme model) to markdown-it's `highlight` callback calling shared Shiki renderer (preserves 4-way theme model); added D12 (markdown rendering pivot) + D13 (languageId via curated map); pinned deps to shiki@^4.1.0, @shikijs/langs@^4.1.0, @shikijs/themes@^4.1.0, markdown-it@^14.1.1; dropped @shikijs/markdown-it from task 1_1 | Eliminate remaining build-time surprises |
| 2026-05-21T00:00:00Z | planner | Plan/7 | `bun run asm change validate` passed final-revision | Verify plan still meets schema |
| 2026-05-21T00:00:00Z | planner | Plan/Gate2 | User approved plan — ready for /asimov-build | Plan stage complete |
| 2026-05-21T00:00:00Z | builder | Build/1_1 | Installed shiki@^4.1.0, @shikijs/langs@^4.1.0, @shikijs/themes@^4.1.0, markdown-it@^14.1.1, @types/markdown-it@^14.1.2. @shikijs/markdown-it NOT installed. pnpm install clean, check-types green | Task 1_1 acceptance |
| 2026-05-21T00:00:00Z | builder | Build/1_1b | Added probe + scripts/check-bundle-size.mjs. Probe pulls in 20 grammars + 4 themes + createHighlighterCore. SCOPE EXPANSION: tsconfig.json moduleResolution changed from "Node16" → "Bundler" because Shiki v4 is pure ESM and Node16 resolution rejects named ESM imports from .ts files. esbuild handles actual module format at bundle time. Tests + check-types still green | Mechanical fix to enable approved Shiki integration |
| 2026-05-21T00:00:00Z | builder | Build/1_1b | First production build measured `media/webview.js` = 2.74 MB. EARLY GATE FAIL at 1.6 MB ceiling. Root cause: webview build skips identifier/syntax minification (`esbuild.js:95-103`) for xterm v6 compat; Shiki TextMate grammars carry many long property names that an identifier-minifier would normally mangle | Real risk caught by D11 early-gate design |
| 2026-05-21T00:00:00Z | builder | Build/Gate1.5 | User approved: raise ceiling 1.6 → 3 MB, keep 20 grammars. Rationale: webview loads from local disk not network; VSCode itself ships hundreds of MB; preserves the language breadth users implicitly want. Updated check-bundle-size.mjs, design.md D1 + D11 + Risk Map, tasks.md 1_1b + 4_2 | Bundle ceiling adjustment after measurement |
| 2026-05-21T00:00:00Z | builder | Build/1_1b | Re-ran gate: 2.74 MB / 3 MB = 91% — OK | Task 1_1b acceptance |
| 2026-05-21T11:20:00Z | builder | Build/1_2 | Added RequestFilePreviewMessage / FilePreviewResultMessage / ThemeChangedMessage + FilePreviewStatus to src/types/messages.ts; extended both IPC unions | Task 1_2 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/2_1 | Extracted buildCandidates + isAbsolutePath + hasTraversal + escapeGlob to src/providers/pathResolution.ts (+12 new tests); openFileLink.ts now imports the shared helpers; existing 15 openFileLink tests still pass | Task 2_1 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/1_3 | Wired theme bridge in both TerminalViewProvider + TerminalEditorProvider (themeKindFor, postMessage on init + onDidChangeActiveColorTheme, disposable tracking). Added 4 tests covering all 4 theme kinds + dispose path. Added ColorThemeKind + activeColorTheme + onDidChangeActiveColorTheme mocks to src/test/__mocks__/vscode.ts | Task 1_3 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/2_2 | Wrote previewFileLink + readFileForPreview (two-tier cap 1MB hard / 200KB preview; binary heuristic NUL in first 8KB; UTF-8 fatal=false; cancellation token check between awaits; languageIdFromUri curated map). 24 new tests across both modules | Task 2_2 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/2_3 | Wired requestFilePreview dispatcher + Map<sessionId, CancellationTokenSource> in both providers; cancel on supersession, on closeTab/requestCloseSplitPane, on webview dispose. SCOPE NOTE: SessionManager doesn't emit session-close, so cleanup hooks attach to user-driven close messages instead — full session-close events would require SessionManager changes outside scope. 6 new dispatcher tests. Upgraded vscode mock's CancellationTokenSource to actually fire listeners on cancel | Task 2_3 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/3_1 | Wrote HoverPreviewController (300ms debounce, activeRequestId tracking, stale-result drop, mousedown/wheel/Escape/blur dismissal, dispose chain). 8 jsdom tests including fake-timer debounce, stale-response drop, dispose mid-flight | Task 3_1 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/3_2 | Wrote HoverPreviewPopup (role=tooltip, absPath header, position math with right-edge clamp + bottom-edge flip, max dims 560x360, z-index 1000, mousedown/Escape/wheel dismissal). Added CSS rules to webviewHtml.ts. 17 DOM tests | Task 3_2 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/3_3 | Wrote syntaxRenderer.ts — static curated bundle of 20 grammars (TS/TSX/JS/JSX/JSON/YAML/HTML/CSS/MD/Python/Go/Rust/C/C++/Java/Kotlin/Shellscript/SQL/Ruby/PHP) + 4 themes (github-light, light-plus, github-dark, dark-plus); JavaScript regex engine; aliases for ts/js/bash/etc. Replaced __bundle_probe.ts with real renderer + main.ts preloadSyntaxHighlighter() kickoff. 8 tests including static-import audit | Task 3_3 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/3_4 | Wrote markdownRenderer.ts using markdown-it + highlight callback delegating to syntaxRenderer (per D12, no @shikijs/markdown-it). html=false, linkify=false, validateLink=()=>false. 7 tests | Task 3_4 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/3_5 | Wired everything in TerminalFactory (controller + popup + renderers per terminal, hoverControllers map for routing) + main.ts (themeStore, getHoverPreviewTheme, onFilePreviewResult + onThemeChanged route handlers, disposeHoverController on removeTerminal). MessageRouter extended with onFilePreviewResult + onThemeChanged. FilePathLinkProvider accepts hoverController dep + has dispose() that propagates. 3 new wiring tests | Task 3_5 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/4_2 | Wired build:check-size npm script + chained from compile + package scripts. Production build now exits 1 if media/webview.js > 3 MB. Final size 2.93 MB / 3 MB (97.6%) | Task 4_2 acceptance |
| 2026-05-21T11:20:00Z | builder | Build/Verify | All gates green: check-types ✓, lint (auto-fix) ✓, 758 unit tests pass (37 files), bundle gate ✓. E2E skipped (N/A per project.md) | Verify gate complete |
| 2026-05-21T11:20:00Z | builder | Build/4_1 | Manual smoke pass deferred to user (extension dev host) — requires interactive VSCode. Documented checklist in tasks.md task 4_1 covers 14 items: hover .ts/.md → popup, dismiss triggers (move/leave/scroll/mousedown/Escape), binary/too-large/not-found/OOW states, all 4 theme kinds, CSP errors check, terminal-close mid-request | Task 4_1 partial — manual run pending |
| 2026-05-21T11:20:00Z | builder | Build/Tooling | SCOPE EXPANSION: tsconfig.json moduleResolution Node16 → Bundler (required by Shiki v4 ESM-only exports). Mechanical fix to enable approved Shiki integration; esbuild handles actual module format at bundle time. Tests + check-types still green | Build infra adjustment |
| 2026-05-21T11:50:00Z | builder | Build/Review/Round1 | Spawned 3 parallel oracle reviews (resolver+reader / webview controller+popup+renderers / IPC+wiring). Webview oracle stalled at 600s and was re-spawned with a tighter scope. Triaged + applied findings: (1) [WARN] TerminalEditorProvider missing requestCloseSplitPane cancellation handler → mirrored from TerminalViewProvider; (2) [WARN] hover findFiles divergence from openFile — using path.posix.join string instead of vscode.RelativePattern, missing basename fallback → added relativePatternFactory dep + click-flow-parity basename fallback to previewFileLink (+ shared withTimeout); (3) [BLOCK] popup mousedown inside popup bubbled to controller dismiss → popup's capture-phase listener now calls stopPropagation; (4) [WARN] popup self-dismiss left controller state stale → wired onDismiss = () => controller.dismiss() in TerminalFactory (closes over forward-declared variable); (5) [WARN] popup header empty for non-ok states without absPath → added `path` echo to FilePreviewResultMessage (now required field), popup uses absPath ?? path. Added 8 new tests covering: basename fallback, RelativePattern factory wiring, no-cwd no-rp falls through, supersession-with-non-null-late-result drop, mousedown-inside-popup-no-dismiss, onDismiss wiring across 3 paths, header fallback to result.path. All 766 unit tests pass. Bundle stable at 2.93 MB / 3 MB | Triage round 1 — 1 BLOCK + 5 WARN accepted/fixed |
| 2026-05-21T11:50:00Z | builder | Build/Verify | Re-verify after triage: check-types ✓ (1 fix: added `path` to all FilePreviewResultMessage literals), lint (auto-fix on package), 766 unit tests pass, bundle 2.93 MB / 3 MB. Ready for user approval | Re-verify gate post-triage |
| 2026-05-21T13:00:00Z | builder | Build/Review/Round2-prep | Build failure diagnosed: `build:check-size` was wired into `compile` (dev build, unminified 3.27 MB > 3 MB ceiling). Fix: only run size gate in `package` (production) — dev bundles legitimately larger because they skip identifier+syntax minification. Documented in scripts/check-bundle-size.mjs header. | Unblock the build before round-2 review |
| 2026-05-21T13:00:00Z | reviewer | Build/Review/Round1 | Round 1 review (4 parallel oracles: data-security / logic / contracts / frontend). VERDICT: BLOCK. 1 BLOCK + 7 WARN + 5 suppressed-by-priority-cap. Persisted to .reviews/round-1.md. BLOCK: hover silently previews out-of-workspace files via shell-controlled OSC 7 cwd — regression of click flow's explicitly-documented trust boundary at openFileLink.ts:457-462 | Independent re-review per user request |
| 2026-05-21T13:30:00Z | builder | Build/Review/Round1/Triage | User accepted all 8 findings + requested SCOPE EXPANSION: (a) block auto-preview for dotfiles + known-sensitive dirs (.git/.ssh/.aws/node_modules) + out-of-workspace; (b) "Hold Cmd/Ctrl to preview" override; (c) line-focus on `:LineNo`/`#LineNo`; (d) line-number gutter; (e) word-wrap at 120 col; (f) footer toolbar with wrap/auto/delay settings; (g) `contributes.configuration` for all 4 settings. AskUserQuestion clarified: trust policy = dotfiles+sensitive+OOW, modifier = platform-aware Cmd/Ctrl, settings = contributed + footer toggles | User-driven scope expansion + accepted review findings |
| 2026-05-21T13:30:00Z | builder | Build/Review/Round1/Fixes | W7 deps moved to devDependencies (clarification: vsce already uses --no-dependencies so vsix wasn't bloated — moving still right for intent). W5 added post-readFile size assertion (TOCTOU defense). W3 added isValidPreviewRequest helper with length caps + NUL rejection in both providers (+9 tests). W6 deferred CTS dispose from cancelPreviewToken to owning finally (in-flight token checks remain safe). W2 removed module-scope `_currentTheme` from markdownRenderer; per-render `buildMd(theme)` builds MarkdownIt with theme captured in closure (+1 test). W4 added isHighlighterReady/whenHighlighterReady exports; TerminalFactory wraps renderCode/renderMarkdown with re-render-on-ready (+2 tests). W1 refactored FilePreviewResultMessage into a discriminated union on `status` (`ok` requires all 8 content fields, `binary`/`too-large` require absPath+totalBytes+languageId+isMarkdown, `not-found`/`ambiguous`/`error` are base-only). Updated previewFileLink to build typed variants. Updated all test fixtures with `makeOkResult()` helper | 7/7 WARNs fixed |
| 2026-05-21T13:30:00Z | builder | Build/Review/Round1/B1 | Added trust policy: classifyTrust(absPath, trustBases) returns dotfile / sensitive-dir / out-of-workspace / null. Trust bases = initialCwd + workspaceFolders (NOT currentCwd, which is OSC-7-injectable). previewFileLink returns `requires-confirmation` status when policy blocks. Added `override?: boolean` field to RequestFilePreviewMessage. Webview HoverPreviewController watches for Cmd (macOS) / Ctrl (Win/Linux) keydown during active hover; re-posts with override=true. One-shot per hover; budget resets on new hover. Popup `renderPlaceholderText` shows "Hold Cmd/Ctrl to preview" with platform-detected key (+10 tests) | Critical BLOCK addressed with security-first trust policy + user-grantable override |
| 2026-05-21T13:45:00Z | builder | Build/ScopeExp/C | Line-focus + scroll-to-line: filePathParser suffix regex extended to accept `#L42` / `#42` (GitHub permalink style); FilePathLinkProvider threads parsed `line` to controller; controller forwards in `requestFilePreview`; previewFileLink echoes `line` back via FilePreviewResultBase; popup wraps each plain-text line in `<span class="line">` (matching Shiki's structure); popup scrolls Nth line into view via scrollIntoView({block:center}) and adds `anywhere-hover-preview-line-active` class for highlight (+4 tests) | User-requested feature: focus on referenced line |
| 2026-05-21T13:50:00Z | builder | Build/ScopeExp/D | Line-number gutter + word-wrap at 120 col: CSS counter on `.line` increments per line; `::before { content: counter(anywhere-line) }` renders inline gutter (no DOM mutation, works for Shiki + plaintext); `anywhere-hover-preview-body-numbers` class always applied; `anywhere-hover-preview-body-wrap` class applied conditionally to set `white-space: pre-wrap; max-width: 120ch`. Popup deps: `getWordWrap` callback drives the wrap class (+3 tests) | User-requested feature: line numbers + 120-col wrap |
| 2026-05-21T14:00:00Z | builder | Build/ScopeExp/E | Settings contribution + footer toolbar: added 4 `contributes.configuration` entries (`anywhereTerminal.hoverPreview.enabled/.delay/.wordWrap/.blockSensitive`). New IPC pair: host → `hoverPreviewSettings` (posted on init + onDidChangeConfiguration); webview → `updateHoverPreviewSetting` (footer-driven, host persists via getConfiguration().update). New helper `hoverPreviewSettings.ts` for host-side read/update + change detection. `previewFileLink` accepts optional `settings: { enabled, blockSensitive }`; `enabled: false` → requires-confirmation with new reason "disabled"; `blockSensitive: false` → skip trust check. Webview: `hoverPreviewSettingsStore` in main.ts; controller `setDebounceMs()`; popup renders footer with 2 toggles + delay number input; footer mousedown stopPropagation to avoid self-dismiss (+4 tests) | User-requested feature: full settings + footer UI |
| 2026-05-21T14:10:00Z | builder | Build/Verify | Round 2 verify gate green: check-types ✓, lint (biome --write --unsafe) ✓, 800 unit tests pass (38 files), bundle 2.93 MB / 3 MB. Net change since round 1: +34 tests, +1 status variant, +1 IPC message pair (settings), +4 contributed settings, +1 helper module, dotfile/sensitive/OOW trust policy, line-focus, line numbers, word-wrap, footer | Re-verify post-round-2 |
