# Review Summary — export-terminal-session

| Round | Date | Verdict | Block | Warn | Suggest | File |
|------:|------|--------:|------:|-----:|--------:|------|
| 1     | 2026-05-27 | WARN  | 0 | 5 | 3 | [round-1.md](./round-1.md) |
| 2     | 2026-05-27 | BLOCK | 1 | 4 | 3 | [round-2.md](./round-2.md) |

## Finding lifecycle

**Round-1 → Round-2**: all 8 round-1 findings (W1–W5, S1–S3) verified `fixed` in commit `d5ac02d`. See round-2.md § "Round-1 finding lifecycle" for per-finding status.

**Round-2 new findings**:
- **[B1]** OSC parser advances tracker state before chunk reaches `appendOutput` → short single-chunk commands persist with empty output. Ship-blocking — directly breaks the change's primary user value.
- **[W1]/[W4]**: round-1 [W3]/[W4] fixes were correct in shape but incomplete in coverage (self-poisoning hole on `unknownFields` literal key; ctx-shape guard validates value but not type).
- **[W2]/[W3]**: integration correctness issues only visible across the full implementation arc (truncated-flag off by viewport-rows; ANSI-preference fork driven by extension instead of save-dialog filter as spec D8 mandates).
- **[S1]/[S2]/[S3]**: defense-in-depth (animationend listener accumulation, char/byte naming, scrollback-reply sender validation).

**Recommended next pass**: fix [B1] via parser-driven segmentation (the parser emits ordered text/event callbacks, tracker only captures text between B and D markers). Bundle [W1]/[W4] as one-line tightenings of the existing round-1 fixes. [W2]/[W3] are independent two-line corrections. [S1]–[S3] can roll into a single quality pass.

**All 8 round-2 findings fixed** in the commit immediately following the review. Parser segmentation (B1) refactored the OSC parser to emit `text` events between consumed OSC sequences; `CommandTracker.handleEvent` routes them through `appendOutput`; `SessionManager.onData` no longer drives tracker capture. Each finding has its own targeted regression test:
- B1 → `oscParser.test.ts` "[B1] single-chunk \`[B][output][D]\` preserves the output text BEFORE the D event" + `SessionManager.trackedCommands.test.ts` "[B1] full single-chunk command lifecycle preserves output".
- W1 → `SessionStorage.test.ts` "[W1] literal top-level \`unknownFields\` key on disk is re-bucketed, not self-promoted".
- W2 → `scrollbackDumpHandler.test.ts` "[W2] does NOT report truncated when buffer is exactly \`rows\` lines below the scrollback cap".
- S3 → `SessionManager.test.ts` "[S3] handleScrollbackDump with mismatched senderSessionId is silently dropped".
