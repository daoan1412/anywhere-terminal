# Tasks: preview-subagent-popup

Dependency-ordered. Builder reads `specs/`, `design.md`, and the research doc — not `discovery.md`. Work in **main** (reuses the uncommitted vault decomposition: `renderNestedInto`, `claudePaths`/`claudeChildren`). Verify gate: `pnpm run check-types` + `pnpm run test:unit` (biome lint OOMs — skip; sweep unused imports manually).

## 1. Host — running-session detection & resolution

- [x] 1_1 Add running-session registry reader
  - **Deps**: none
  - **Refs**: specs/claude-running-session-map/spec.md#requirement-detect-running-claude-sessions; design.md D4; docs/research/20260601-claude-cli-running-detection-and-subagent-linkage.md
  - **Scope**: src/vault/readers/runningSessions.ts (new); src/vault/readers/runningSessions.test.ts (new)
  - **Acceptance**:
    - Outcome: `listRunningClaudeSessions()` returns `{sessionId, cwd, pid, startedAt?}` for each `~/.claude/sessions/<pid>.json` whose pid passes a `process.kill(pid,0)` liveness probe; stale (ESRCH) and malformed files are skipped; keyed by sessionId.
    - Verify: unit src/vault/readers/runningSessions.test.ts
  - **Plan**:
    1. Read `~/.claude/sessions/*.json`, parse `{pid,sessionId,cwd,startedAt}` defensively (skip malformed).
    2. Probe liveness via `process.kill(pid,0)` in try/catch (ESRCH → dead, EPERM → alive).
    3. Return entries keyed by sessionId.

- [x] 1_2 Add process-tree util (pure parser + OS wrapper)
  - **Deps**: none
  - **Refs**: design.md D4, D8; src/pty/processCwd.ts (OS-query precedent)
  - **Scope**: src/pty/processTree.ts (new); src/pty/processTree.test.ts (new)
  - **Acceptance**:
    - Outcome: `parseProcessTable(text)` builds a pid→children map and `descendantPids(root)` BFS-collects descendants; macOS uses `ps -axo pid=,ppid=`, Linux `/proc`/`ps`, Windows returns `[]`.
    - Verify: unit src/pty/processTree.test.ts
  - **Plan**:
    1. Pure `parseProcessTable(text)`: parse `pid ppid` lines → `Map<number, number[]>`.
    2. `descendantPids(root)`: BFS over the map; unit-test parser + BFS on fixture text.
    3. Thin OS wrapper per platform (macOS/Linux real call, Windows `[]`).

- [ ] 1_3 Add terminal→session resolver
  - **Deps**: 1_1, 1_2
  - **Refs**: specs/claude-running-session-map/spec.md#requirement-map-a-terminal-to-its-claude-session; design.md D4
  - **Scope**: src/session/resolveClaudeSession.ts (new); src/session/resolveClaudeSession.test.ts (new); src/session/SessionManager.ts (add pid+cwd accessor if missing)
  - **Acceptance**:
    - Outcome: `resolveClaudeSession(terminalId)` returns `{sessionId, cwd}` via process-tree∩registry (tie-break newest mtime when >1), else running-by-cwd newest-mtime, else newest Claude session under cwd; null if none.
    - Verify: unit src/session/resolveClaudeSession.test.ts
  - **Plan**:
    1. Get `session.pty.pid` + current cwd from SessionManager.
    2. `descendantPids(ptyPid)` ∩ `listRunningClaudeSessions()` by pid; if >1 match, pick newest `<sessionId>.jsonl` mtime; unreadable subtree (EPERM) → treat as empty.
    3. Fallback: running entries where `cwd===terminalCwd`, pick newest `<sessionId>.jsonl` mtime; then newest claude session under cwd. Unit-test each branch with mocked fs/registry/process-table.

- [x] 1_4 Add subagent transcript lookup by description
  - **Deps**: none
  - **Refs**: specs/claude-running-session-map/spec.md#requirement-resolve-a-clicked-subagent-to-its-transcript-detail; design.md D5
  - **Scope**: src/vault/readers/subagentLookup.ts (new); src/vault/readers/subagentLookup.test.ts (new)
  - **Acceptance**:
    - Outcome: `resolveSubagentDetail(sessionId, description)` (NO cwd) enumerates stubs via `listClaudeSubagentStubs(sessionId)`, prefix-matches `description` (tie-break newest mtime), reads the chosen stub via `readClaudeSubagentDetail` (containment-checked), returns `VaultSessionDetail` or null.
    - Verify: unit src/vault/readers/subagentLookup.test.ts
  - **Plan**:
    1. `listClaudeSubagentStubs(sessionId)` → `{entryId, description}[]`; recover each `stem` by splitting `entryId` on `:subagent:` (SUBAGENT_MARKER).
    2. Prefix-match the clicked description against stub descriptions; tie-break by newest mtime.
    3. `readClaudeSubagentDetail(parentId=sessionId, stem, …)` → `VaultSessionDetail`; null on no-match. Do NOT derive an encoded-cwd path (no encoder exists).

## 2. Host — IPC

- [x] 2_1 Add subagent-preview message types
  - **Deps**: none
  - **Refs**: design.md "Interfaces"
  - **Scope**: src/types/messages.ts
  - **Acceptance**:
    - Outcome: `RequestSubagentPreviewMessage` (`terminalId,requestId,description,x,y`) and `SubagentPreviewResponseMessage` (`requestId,detail?,error?`) exist and are members of the webview→host / host→webview unions.
    - Verify: none — types only (tsc gate)
  - **Plan**:
    1. Add both interfaces near `VaultSessionDetailResponseMessage` and include them in the discriminated unions.

- [x] 2_2 Add host handler for requestSubagentPreview
  - **Deps**: 1_3, 1_4, 2_1
  - **Refs**: specs/claude-running-session-map/spec.md#requirement-resolve-a-clicked-subagent-to-its-transcript-detail; design.md D3
  - **Scope**: src/providers/TerminalViewProvider.ts; src/providers/TerminalEditorProvider.ts
  - **Acceptance**:
    - Outcome: a `requestSubagentPreview` message resolves the terminal's session (1_3) → subagent detail (1_4) → posts `subagentPreviewResponse {requestId, detail|error}`; unknown terminal / no match → `error` marker, never throws.
    - Verify: manual — click a subagent line in a running claude terminal and observe a response in the webview devtools
  - **Plan**:
    1. Add `case "requestSubagentPreview"` to the message switch (mirror in editor/panel provider).
    2. `resolveClaudeSession(terminalId)` → `resolveSubagentDetail(...)`.
    3. postMessage `subagentPreviewResponse`; wrap in try/catch → `error`.

## 3. Webview — link provider + click

- [x] 3_1 Add SubagentLinkProvider + pure line parser
  - **Deps**: 2_1
  - **Refs**: specs/terminal-subagent-preview/spec.md#requirement-detect-subagent-invocations-in-terminal-output; design.md D1, D2; /Users/huybuidac/Projects/ai-oss/xterm.js (ILinkProvider)
  - **Scope**: src/webview/links/SubagentLinkProvider.ts (new); src/webview/links/subagentLineParser.ts (new); src/webview/links/subagentLineParser.test.ts (new)
  - **Acceptance**:
    - Outcome: pure parser matches a SINGLE header line `^[⏺●]?\s*<Name>\(<desc>\)\s*$` where `<Name>` is not a built-in tool name (`Read|Bash|Edit|MultiEdit|Update|Create|Write|Grep|Glob|NotebookEdit|Search|Task`) nor `mcp__…`, returning `{name, description, range}`; the provider marks that line clickable. NO cross-line/trailer join (oracle #1).
    - Verify: unit src/webview/links/subagentLineParser.test.ts
  - **Plan**:
    1. Pure `parseSubagentHeader(lineText)`: regex header, reject built-in/mcp names, capture `description` (verbatim) + column range.
    2. `SubagentLinkProvider.provideLinks(y, cb)`: read the row text (`translateToString`), run the parser, emit one single-row `ILink` covering the header columns.
    3. Unit-test parser: agent headers (Explore/Plan/Agent/custom) match; Read/Bash/Edit/mcp__ excluded; blink-blank glyph tolerated; description with nested parens.

- [x] 3_2 Register provider + click activate
  - **Deps**: 3_1, 2_1
  - **Refs**: specs/terminal-subagent-preview/spec.md#requirement-click-opens-the-subagent-preview-popup; design.md D1, D3
  - **Scope**: src/webview/terminal/TerminalFactory.ts
  - **Acceptance**:
    - Outcome: each terminal (incl. splits) registers a `SubagentLinkProvider` whose `ILink.activate(event)` posts `requestSubagentPreview {terminalId, requestId, description, x, y}`; file-path links unaffected.
    - Verify: manual — a subagent line is underlined/clickable in a terminal
  - **Plan**:
    1. After the `FilePathLinkProvider` registration (~`TerminalFactory.ts:351`), `terminal.registerLinkProvider(new SubagentLinkProvider({...}))`.
    2. `activate(event)` (xterm signature `(event, text)`) → `x=event.clientX, y=event.clientY`; `description` from the link closure; postMessage with a fresh requestId + terminalId.

## 4. Webview — popup

- [x] 4_1 Add SubagentPreviewPopup (FloatingWindow shell + transcript body)
  - **Deps**: none
  - **Refs**: specs/terminal-subagent-preview/spec.md#requirement-click-opens-the-subagent-preview-popup; specs/terminal-subagent-preview/spec.md#requirement-popup-lifecycle-and-disposal; design.md D6
  - **Scope**: src/webview/links/SubagentPreviewPopup.ts (new); src/webview/links/SubagentPreviewPopup.test.ts (new)
  - **Build note**: FULL shell reuse (user "Reuse full shell") — `.vault-preview` card + `FloatingWindow` (resize/move/maximize, in-memory geometry) + session-style header (badge + `@agentType` chip + description title + maximize/close + Activity meta) + `PreviewScrollNav` + `renderNestedInto`. Click-anchored (`computePosition`), no Resume. agentType threaded parser→provider→popup (also touches SubagentLinkProvider.ts + TerminalFactory.ts, already in the change). See design.md D6 final decision.
  - **Acceptance**:
    - Outcome: a body-mounted popup anchored at given click coords renders a `VaultSessionDetail` via `renderNestedInto(container, detail, entryId, stubBag)` where `stubBag.populateNested` no-ops and `isNestedExpanded`→false (FLAT render, oracle #2), with loading and error/empty states; idempotent `dispose()` removes the body node + listeners.
    - Verify: unit src/webview/links/SubagentPreviewPopup.test.ts
  - **Plan**:
    1. Create a fresh body element; instantiate `FloatingWindow` on it; place at click coords (clamp to viewport — reuse `computePosition` math).
    2. Body states: `loadingBody` → `renderNestedInto(detail, stubBag)` (nested nodes render as non-expandable) → `emptyState` on error/notFound.
    3. Idempotent `dispose()`; test MUST `afterEach` clean `document.body` + listeners (jsdom isolation — else flakes the whole suite).

- [x] 4_2 Wire response → popup (single, anchored)
  - **Deps**: 4_1, 3_2, 2_2
  - **Refs**: specs/terminal-subagent-preview/spec.md#requirement-click-opens-the-subagent-preview-popup; design.md D3, D7
  - **Scope**: src/webview/terminal/TerminalFactory.ts; src/webview/main.ts; src/webview/messaging/MessageRouter.ts (added — idiomatic routing table for the new extension→webview message; mirrors the `vault*` cases)
  - **Acceptance**:
    - Outcome: clicking a subagent line opens one popup (replacing any prior) in loading state; `subagentPreviewResponse` routes by `requestId` and fills it; Escape / outside-click / another-click dismiss.
    - Verify: manual — click a subagent line in a running claude terminal → popup shows the sub-session
  - **Plan**:
    1. On activate: open `SubagentPreviewPopup` (loading) at coords; track current `requestId`.
    2. Route `subagentPreviewResponse` in `main.ts` (near hover-controller routing) → `popup.setContent(detail|error)` when requestId matches.
    3. Enforce single popup (dispose prior); add Escape/outside-click dismiss.

- [x] 4_3 Dispose popup on every terminal teardown
  - **Deps**: 4_2
  - **Refs**: specs/terminal-subagent-preview/spec.md#requirement-popup-lifecycle-and-disposal; design.md D7
  - **Scope**: src/webview/terminal/TerminalFactory.ts; src/webview/main.ts; src/webview/split/SplitTreeRenderer.ts
  - **Acceptance**:
    - Outcome: the factory-singleton popup is disposed on open-replace and on any terminal teardown (removeTerminal/removeTab `main.ts:403,416`, split-pane close `main.ts:532,539`, panel dispose) with no orphaned `document.body` node; it is NOT tied to per-session `disposeHoverController` (oracle #7).
    - Verify: unit src/webview/links/SubagentPreviewPopup.test.ts
  - **Plan**:
    1. Own the single popup on `TerminalFactory`; dispose-on-open-replace (new click kills prior).
    2. Dispose on every terminal teardown site (NOT inside per-session `disposeHoverController`); idempotent guard; closing any pane dismissing an A-pane popup is acceptable.

## 5. Verification

- [x] 5_1 Verify gate + live smoke _(automated gate green: `pnpm run check-types` + `pnpm run test:unit` 2006 pass, 10× clean for jsdom isolation; biome lint skipped — OOMs; **live click→preview smoke against a real `claude` = manual, deferred to user**)_
  - **Deps**: 1_1, 1_2, 1_3, 1_4, 2_1, 2_2, 3_1, 3_2, 4_1, 4_2, 4_3
  - **Refs**: asimov/project.md § Commands
  - **Scope**: none (run gates only)
  - **Acceptance**:
    - Outcome: `pnpm run check-types` and `pnpm run test:unit` pass; manual smoke — start `claude` in a terminal, run a Task subagent, click its line, see the sub-session popup (running + finished).
    - Verify: manual — tsc + vitest green; click-to-preview works against a live claude session
  - **Plan**:
    1. `pnpm run check-types`; `pnpm run test:unit` (run webview suite 10× for jsdom-isolation stability).
    2. Manual smoke against a real running `claude` (in-progress + completed subagent).

## 6. De-dup refactor — extract shared `FloatingPreviewShell` (post-rework)

> Added 2026-06-01 after the user flagged "two UIs for one problem": the full-shell-reuse build (§4) reused leaf components but DUPLICATED the card-assembly, close-listeners, and header. This section extracts ONE shell + ONE header builder so the vault preview and the subagent popup cannot diverge. Behavior unchanged for both; gated by the existing `VaultPanel.test.ts` regression net. See design.md D6 (final decision).

- [x] 6_1 Extract `FloatingPreviewShell` (shared chrome) + test
  - **Scope**: src/webview/vault/FloatingPreviewShell.ts (new); src/webview/vault/FloatingPreviewShell.test.ts (new)
  - **Acceptance**: Outcome — a vault-agnostic shell owns the `.vault-preview` card + `FloatingWindow` + `PreviewScrollNav` + document close-listeners + tooltip disposers + `render`/`show`/`hide`/`dispose`; close path is single (`onRequestClose`), `hide()` never recurses, listeners parameterized (`shouldCloseOnEscape`, `outsideCloseExclude`, `captureCloseListeners`). Verify — unit src/webview/vault/FloatingPreviewShell.test.ts (11 tests).
- [x] 6_2 Genericize `buildPreviewHeader(model, cb)` — one builder, vault-only actions optional
  - **Scope**: src/webview/vault/previewHeader.ts; src/webview/vault/previewHeader.test.ts (new); src/webview/vault/PreviewController.ts (caller map)
  - **Acceptance**: Outcome — `buildPreviewHeader` takes a normalized `PreviewHeaderModel` + optional `onPrevUser`/`onNextUser`/`onResume` (button renders only when supplied); vault DOM byte-identical. Verify — unit previewHeader.test.ts (6 tests, both shapes) + VaultPanel.test.ts unchanged.
- [x] 6_3 Compose the shell into `PreviewController` (public API unchanged)
  - **Scope**: src/webview/vault/PreviewController.ts
  - **Acceptance**: Outcome — `get element()`/render/close/header/scroll all delegate to the shell; pagination, nested lazy-load, accent, scroll-to-first, Esc context-menu guard, `.vault-row` outside-exclude preserved. Verify — VaultPanel.test.ts (100 tests) green.
- [x] 6_4 Compose the shell into `SubagentPreviewPopup`; delete duplicated chrome
  - **Scope**: src/webview/links/SubagentPreviewPopup.ts
  - **Acceptance**: Outcome — popup holds a `FloatingPreviewShell`, header via shared `buildPreviewHeader`; bespoke `renderShell`/`buildHeader`/dismiss-listeners + `floatingWindow`/`scrollNav`/`tooltipDisposers`/`keyListener`/`outsideListener` fields removed; `isOpen()` = mounted. Verify — SubagentPreviewPopup.test.ts (10 tests) unchanged + green.
