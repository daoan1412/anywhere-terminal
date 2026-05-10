# Review: add-click-cursor-positioning (Round 1)

- Date: 2026-05-09T00:08:33Z
- Reviewable lines: ~180 (new handler + TerminalFactory wiring; docs skipped)
- Agents spawned: logic, frontend
- Agents skipped: data-security, contracts
- Verdict: BLOCK
- Counts: 1 BLOCK, 2 WARN

## Findings

### L1

- Severity: BLOCK
- Confidence: HIGH
- Priority: P1
- Agent: logic
- File: `src/webview/ClickCursorHandler.ts:82`
- Title: Cursor movement is computed as one horizontal escape based on linear delta
- Evidence: `createCursorMoveSequence()` converts `(row,col)` into a single linear `delta` and emits only right/left movement.
- Impact: Agent concern: clicks on a different terminal row may land in the wrong place if vertical movement is required.
- SuggestedFix: Compute row and column deltas separately and emit up/down plus left/right sequences, or use another absolute-position strategy.
- Status: rejected
- Triage: Rejected. For normal-buffer shell prompts, xterm's own `MoveToCell.ts` uses horizontal-only input in the normal buffer (`Only move horizontally for the normal buffer`, lines 32-43) and reserves vertical movement for alt buffer, which this change explicitly skips. Sending up/down would conflict with shell history navigation.

### F1

- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: frontend
- File: `src/webview/ClickCursorHandler.ts:112`
- Title: Click handlers are never cleaned up
- Evidence: `createClickCursorHandler` registers anonymous `mousedown` and `mouseup` listeners on `deps.container` and returns `void`.
- Impact: Agent concern: repeated terminal creation on the same container can accumulate listeners and synthesize duplicate cursor movement input; disposed instances may be retained through listener closures.
- SuggestedFix: Return a disposable cleanup function/object and remove listeners during terminal disposal.
- Status: rejected
- Triage: Rejected. `TerminalFactory.createTerminal()` creates a dedicated container per terminal, and disposal removes that container (`instance.container.remove()`). The same container is not reused for terminal recreation, so duplicate listeners on one live container are not expected. Removed DOM nodes and their listeners are GC-eligible when no external references remain.

### F2

- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: logic
- File: `src/webview/ClickCursorHandler.ts:124`
- Title: Plain clicks on terminal links still trigger cursor movement
- Evidence: The handler ran for every unmodified primary click and did not check whether xterm was hovering a WebLinksAddon link.
- Impact: Clicking a URL/file path could both activate the link and move the shell cursor.
- SuggestedFix: Skip cursor movement when linkification/link-hit state is active.
- Status: accepted
- Triage: Accepted and fixed by skipping movement when xterm marks the container with `xterm-cursor-pointer`; covered by `does not send input when xterm is hovering a link`.
