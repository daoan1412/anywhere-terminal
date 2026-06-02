# Proposal: fix-opencode-preview-last-message

## Why

The vault session preview for OpenCode does not show the final assistant (AI) message of a session, unlike the Claude preview. Cause: the OpenCode detail reader loads only the **earliest** `message`/`part` rows (`ORDER BY time_created ASC LIMIT`), so once a real session exceeds the part budget the tail — the final assistant message and its text parts — is dropped.

## Appetite

S (≤1d)

## Scope

### In scope
- Make `readOpenCodeDetail` retain both the **head and tail** of the `message`/`part` streams (mirroring Claude's `createBoundedRecordBuffer` head+tail), so `firstPrompt` and the final assistant message both survive long sessions.
- De-duplicate the head∪tail union by row `id`; set `truncated: true` when the middle was dropped.
- Unit coverage for the long-session and small-session (overlap) cases.

### Out of scope
- `mapOpencodeRows` mapping logic (unchanged — it already sorts ascending and is feed-order agnostic).
- Claude / Codex readers (Claude already correct; Codex unaffected).
- Webview rendering (`PreviewController` / `renderTimelineInto`) — the gap is in the data, not the render.
- The genuinely tool-only final turn (no text part to show — same as Claude; not a parity gap).

## Capabilities

1. **vault-session-preview** — sharpen the on-demand detail contract: a bounded read SHALL retain both transcript ends so the final assistant message survives a long session.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — the preview will now render the trailing AI message for long OpenCode sessions.
- **E2E required?** NOT REQUIRED
- **Justification**: The fix is a pure host-side data-read change with a deterministic mapping; `project.md` declares E2E N/A and the behavior is fully covered by unit tests over `readOpenCodeDetail` (mocked SQLite). The user will manually verify the preview during the build phase.

## Risk Level

LOW — single host-side function, read budget unchanged (~2100 messages / 5000 parts, just split head/tail), `mapOpencodeRows` untouched, regression-guarded by existing + new unit tests.
