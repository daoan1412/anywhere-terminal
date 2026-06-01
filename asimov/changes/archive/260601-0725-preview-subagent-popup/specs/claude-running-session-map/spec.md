# claude-running-session-map Specification

## ADDED Requirements

### Requirement: Detect running Claude sessions

The host SHALL enumerate the Claude session PID registry at `~/.claude/sessions/<pid>.json` (each carrying `pid`, `sessionId`, `cwd`, `startedAt`), and SHALL treat a session as running only when `process.kill(pid, 0)` confirms the process is alive (an `ESRCH` error marks it stale and SHALL be ignored). Malformed registry files SHALL be skipped without failing the scan. The result SHALL be keyed by `sessionId`.

### Requirement: Map a terminal to its Claude session

The host SHALL resolve the Claude `sessionId` a given terminal is showing, in this order:

1. Walk the terminal's pty process subtree (from `session.pty.pid`) and intersect the descendant pids with the running registry (the registry `pid` is the `claude` node process, a descendant of the pty's shell, never the pty pid itself). A single match yields the exact `{ sessionId, cwd }`; WHEN more than one running registry pid is found in the subtree (e.g. two `claude` processes), the one with the most‑recently‑modified `<sessionId>.jsonl` transcript SHALL be chosen.
2. WHEN the subtree walk yields no match, fall back to running registry entries whose `cwd` equals the terminal's current cwd, choosing the most‑recently‑modified `<sessionId>.jsonl`. (Note: the terminal's live cwd is the shell's cwd and MAY differ from the registry's launch cwd if the shell has `cd`'d; a miss here SHALL degrade to step 3, not error.)
3. WHEN no running session matches the cwd, fall back to the most‑recently‑modified Claude session under that cwd (so a terminal whose CLI has already exited still resolves).

It SHALL return null when nothing resolves, and SHALL derive every path from the cwd within the Claude store — never from a webview‑supplied path. On platforms without a supported process‑table query (e.g. Windows) the subtree walk SHALL no‑op and resolution SHALL use the cwd fallbacks only.

### Requirement: Resolve a clicked subagent to its transcript detail

GIVEN a resolved parent `sessionId` and a clicked `description`, the host SHALL enumerate that session's subagent stubs via the existing `listClaudeSubagentStubs(sessionId)` (which scans the parent's `subagents/` directory and reads each `agent-*.meta.json` `description`), **prefix‑match** `description` against those stub descriptions (ties broken by most‑recent file mtime), and read the chosen stub via the existing Claude subagent detail reader (including its `isSidechain` records). It SHALL reply with a `subagentPreviewResponse` carrying the same `requestId` plus either the `VaultSessionDetail` or an `error`/`notFound` marker. Resolution SHALL reuse the existing containment‑checked path resolvers (`resolveClaudeSubagentPath`) — it MUST NOT derive an encoded‑cwd path (no such encoder exists; the readers locate the parent by `sessionId`, so `cwd` is not an input to this step).
