# Proposal: preview-subagent-popup

## Why
When the Claude Code CLI runs in a terminal, a subagent (Task) invocation prints as a single line (e.g. `⏺ Explore(…) · Done (21 tool uses · 56.4k tokens · 1m 20s)`) with no way to see what the subagent actually did. Let the user **click that line** to peek the subagent's full sub‑session transcript in a floating popup — reusing the terminal link‑provider + popup + vault transcript reader we already ship.

## Appetite
M (≤3d)

## Scope

### In scope
- A second per‑terminal xterm link provider (`SubagentLinkProvider`) that detects Claude subagent invocation lines and makes them clickable.
- Click → host resolves the terminal's running Claude session and the clicked subagent → returns its transcript → a body‑mounted popup renders it (reusing `FloatingWindow` + `renderNestedInto`).
- Host: running‑session detection via `~/.claude/sessions/<pid>.json` (liveness‑probed); terminal→session mapping via process‑tree walk with cwd/mtime fallback; subagent lookup by description prefix.
- New IPC pair `requestSubagentPreview` / `subagentPreviewResponse`.
- Loading / error / empty states; single popup; disposal on every terminal teardown path.
- Unit tests (parsers, resolvers, popup) + manual smoke against a live `claude`.

### Out of scope
- Any vault‑panel change (this is a terminal feature).
- **Nested expand‑in‑popup** — the popup renders the clicked subagent's transcript flat (stub timeline bag); expanding sub‑subagents/teammate nodes inside the popup is a follow‑up (host handler already exists).
- Live auto‑refresh / tailing of an in‑progress subagent — **snapshot on open** (re‑read on each click).
- Non‑Claude agents (OpenCode/Codex) — Claude CLI only for MVP.
- Windows process‑tree mapping — graceful no‑op (macOS + Linux only, matching existing `queryProcessCwd`).
- Hardening the description matcher beyond prefix‑match (deterministic `agent_progress`/`agentId` join is a future follow‑up).

## Capabilities

1. **terminal-subagent-preview** — detect subagent invocation lines in terminal output, click to open a popup that previews the sub‑session transcript.
2. **claude-running-session-map** — host: detect running Claude sessions, map a terminal to its sessionId, and resolve a clicked subagent to its transcript detail.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — a new clickable affordance on subagent lines in the terminal + a floating transcript popup.
- **E2E required?** NOT REQUIRED.
- **Justification**: No E2E harness exists (`project.md` § Commands → E2E: N/A) and true end‑to‑end needs a live Claude CLI emitting real subagent output. Parsing, session resolution, and subagent lookup are unit‑tested (pure cores); the popup is unit‑tested under jsdom; the live click→preview path is covered by a manual smoke step.

## Risk Level
MEDIUM — terminal‑text parsing is inherently fragile (blinking glyph, reflow, right‑edge clipping, trailer timing) and the terminal→session process‑tree mapping is net‑new and OS‑specific; both are mitigated by on‑demand resolution, tolerant matching, and graceful no‑op fallbacks.
