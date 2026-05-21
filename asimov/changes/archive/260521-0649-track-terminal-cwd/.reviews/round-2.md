# Review: track-terminal-cwd (Round 2)

**Date:** 2026-05-21T03:30:00Z
**Reviewable lines:** +84 net (round 1 fixes — try/catch in PtySession, currentCwd removed from trust bases, findFiles guard for absolute/traversal, control-char reject in oscParser)
**Agents resumed:** logic (a03eb1955a97ab4d6), data-security (a636ad3e537c34d59), contracts (a9c328d4695b65623)
**Agents skipped:** frontend

## Verdict

**APPROVE** — all round-1 BLOCK/WARN findings sustained as resolved, no new issues introduced.

| Severity | Count |
|---|---|
| BLOCK | 0 |
| WARN  | 0 |
| SUGGEST | 0 (round-1 SUGGEST DS4/DS5 remain rejected) |

## Rebuttal Verdicts

| Finding | Round 1 Severity | Round 2 Verdict | Notes |
|---|---|---|---|
| B1 — Sink exception in PtySession.onData | BLOCK | **SUSTAINED-FIXED** | try/catch wraps `_oscParser.feed`; `_onDataCallback` unconditionally outside. handleOsc7's inner try narrowed to URL parse only. |
| B2 — currentCwd in trust-boundary bases | BLOCK | **SUSTAINED-FIXED** | `currentCwd` removed from bases; modal fires when resolved path escapes initialCwd ∪ workspaceFolders. Comment documents security rationale. |
| W1 — findFiles dead-end glob for absolute paths | WARN | **SUSTAINED-FIXED** | `!isAbsolutePath(msg.path)` guard added before findFiles. |
| W2 — `..` traversal in msg.path | WARN | **SUSTAINED-FIXED** | `hasTraversal()` helper + guard before findFiles. |
| W3 — OSC 633 control-char filter | WARN | **SUSTAINED-FIXED** | `CONTROL_CHARS = /[\x00-\x1f\x7f]/` rejected in `emitIfValid` (applies to both OSC 7 + OSC 633). |

## New issues introduced by fixes

None at BLOCK/HIGH.

Data-security raised two SUGGEST observations during round 2 (confirmed safe + non-actionable):
1. `hasTraversal` matches exact `..` only — `...` and unicode lookalikes ignored. Defense-in-depth only; vscode.workspace.findFiles is workspace-rooted.
2. `path.resolve(decoded)` runs before control-char check. Confirmed safe — the post-resolve check still catches null bytes; Node's `path.resolve` does not throw on NUL on macOS/Linux.

Neither needs a code change.

## Session IDs (carried over)

- data-security: a636ad3e537c34d59
- logic: a03eb1955a97ab4d6
- contracts: a9c328d4695b65623
- frontend: not-spawned
