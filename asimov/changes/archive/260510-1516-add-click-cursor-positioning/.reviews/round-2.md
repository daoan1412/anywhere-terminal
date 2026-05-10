# Review: add-click-cursor-positioning (Round 2)

- Date: 2026-05-09T00:10:15Z
- Reviewable lines: ~190 (handler + TerminalFactory wiring; docs skipped)
- Agents spawned: logic, frontend
- Agents skipped: data-security, contracts
- Verdict: APPROVE
- Counts after adjudication: 0 BLOCK, 0 WARN, 0 SUGGEST

## Re-review Results

### L1

- Previous Status: rejected
- Re-review Verdict: sustained
- Rationale: Logic re-review agreed that normal-buffer xterm `MoveToCell` behavior uses horizontal-only movement and avoids shell history conflicts. Frontend re-raised the same concern, but did not address the xterm normal-buffer source evidence, so chair sustains the rebuttal.

### F1

- Previous Status: rejected
- Re-review Verdict: sustained
- Rationale: The concern is theoretically valid for reused containers, but this implementation creates one container per terminal and removes it on terminal disposal. There is no evidence of container reuse or live duplicate handler accumulation in this code path.

### F2

- Previous Status: accepted
- Re-review Verdict: fixed
- Rationale: Handler now skips while xterm applies `xterm-cursor-pointer`, and tests cover the link-hover guard.

### F3

- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: frontend
- File: `src/webview/ClickCursorHandler.ts:124`
- Title: Handler still fires for non-prompt terminal content
- Evidence: There is no prompt-line/editable-region check before sending cursor movement.
- Impact: Clicking prior output in the live viewport can inject cursor navigation into the shell.
- SuggestedFix: Restrict movement to active prompt/editable line using shell integration or another prompt-boundary signal.
- Status: rejected
- Triage: Rejected. The approved scope explicitly avoids new shell integration or protocol changes, and xterm does not expose a public prompt boundary. The spec contracts conservative terminal-state guards (normal buffer, no mouse tracking, not scrolled back, no selection/drag/link), not semantic shell prompt detection.

## Session IDs

- logic: `ses_1f5f21e14ffeIS0O8b7x5eobl9`
- frontend: `ses_1f5f21df3ffeO8aM8etcfqzo4X`
- contracts: not-spawned
- data-security: not-spawned
