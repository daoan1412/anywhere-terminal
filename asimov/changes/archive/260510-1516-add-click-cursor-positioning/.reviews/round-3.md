# Review: add-click-cursor-positioning (Round 3)

- Date: 2026-05-10T07:47:52Z
- Reviewable lines: ~190 (handler + TerminalFactory wiring; docs skipped)
- Agents spawned: unavailable in this environment; asimov-review skill loaded and workflow executed inline
- Agents skipped: data-security, contracts
- Verdict: WARN
- Counts after adjudication: 0 BLOCK, 1 WARN, 0 SUGGEST

## Findings

### F4

- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: chair
- File: `src/webview/ClickCursorHandler.ts:57`
- Title: Link-hover guard checks the wrapper instead of the xterm element
- Evidence: `TerminalFactory.createTerminal()` passes the dedicated wrapper `container` to `createClickCursorHandler()` after `terminal.open(container)`, while xterm creates and owns its terminal DOM element inside that wrapper. `isLinkClick()` only checks `container.classList.contains("xterm-cursor-pointer")`, so it will miss the normal xterm link-hover class when that class is applied to the nested xterm element rather than the wrapper. The unit test adds the class directly to the wrapper, so it does not cover the production DOM shape.
- Impact: Plain primary clicks on terminal links can still synthesize cursor movement input while link handling is active, preserving the round-1 link-click conflict in real webview usage.
- SuggestedFix: Check the actual xterm element as well as the wrapper, for example by passing `terminal.element`/a link-state predicate into the handler or by querying descendants for `.xterm-cursor-pointer`; add a test where the class exists on a child xterm element.
- Status: accepted
- Triage: Accepted and fixed. `isLinkClick()` now checks both the wrapper and nested descendants for `.xterm-cursor-pointer`, covering the production xterm DOM shape. Added `does not send input when a nested xterm element is hovering a link`.

## Verification

- `pnpm exec vitest run src/webview/ClickCursorHandler.test.ts` passed: 22 tests
- `pnpm run check-types` passed
- `pnpm run lint` passed; no fixes applied
- Post-fix full suite: `pnpm run test:unit` passed: 440 tests
- Post-fix Asimov validation: `bun run asm change validate add-click-cursor-positioning` passed

## Session IDs

- logic: unavailable; no subagent tool exposed
- frontend: unavailable; no subagent tool exposed
- contracts: not-spawned
- data-security: not-spawned
