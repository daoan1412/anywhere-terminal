# Review Summary: add-click-cursor-positioning

## Round 1

- Verdict: BLOCK
- L1: rejected — normal-buffer cursor movement intentionally follows xterm `MoveToCell.ts` horizontal-only behavior.
- F1: rejected — terminal containers are one-per-instance and removed on disposal, so listener accumulation on reused containers is not expected.
- F2: accepted/fixed — handler now skips when xterm link hover state adds `xterm-cursor-pointer`.

## Round 2

- Verdict: APPROVE
- L1: sustained rebuttal — logic re-review agreed with xterm normal-buffer source evidence.
- F1: sustained rebuttal — no reused-container evidence in current lifecycle.
- F2: fixed — link-hover guard covered by tests.
- F3: rejected — prompt-boundary detection requires shell integration outside approved scope.

## Round 3

- Verdict: WARN
- F4: accepted/fixed — link-hover guard now checks wrapper and nested descendants for `.xterm-cursor-pointer`; nested xterm DOM shape covered by test.
