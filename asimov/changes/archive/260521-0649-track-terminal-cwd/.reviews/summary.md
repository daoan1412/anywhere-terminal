# Review Summary — track-terminal-cwd

## Finding Lifecycle

| ID | Title | File | Round 1 | Triage | Round 2 |
|---|---|---|---|---|---|
| B1 | Sink exception in PtySession.onData skips pass-through | src/pty/PtySession.ts | BLOCK | accepted | SUSTAINED-FIXED |
| B2 | currentCwd in trust-boundary bases bypasses out-of-workspace modal | src/providers/openFileLink.ts | BLOCK | accepted | SUSTAINED-FIXED |
| W1 | findFiles fallback runs for absolute paths (dead-end glob) | src/providers/openFileLink.ts | WARN | accepted | SUSTAINED-FIXED |
| W2 | `..` traversal in msg.path not rejected | src/providers/openFileLink.ts | WARN | accepted | SUSTAINED-FIXED |
| W3 | OSC 633 control-char filter | src/pty/oscParser.ts | WARN | accepted | SUSTAINED-FIXED |
| DS4 | Coalesce repeated cwd updates (perf) | src/session/SessionManager.ts | SUGGEST | rejected | — |
| DS5 | Debounce findFiles per session (perf) | src/providers/openFileLink.ts | SUGGEST | rejected | — |

## Outcome

- **Round 1**: BLOCK (2 BLOCK + 3 WARN accepted, 2 SUGGEST rejected).
- **Round 2**: APPROVE — all accepted findings sustained-fixed, no regressions, no new issues at BLOCK/HIGH.

Verify gate: TS clean, lint clean, 551 tests passing (baseline 492 → +59 net, including +5 from round-1 fix regression coverage).
