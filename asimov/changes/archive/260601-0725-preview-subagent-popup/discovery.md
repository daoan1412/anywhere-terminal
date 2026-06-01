# Discovery: preview-subagent-popup

**Feature (corrected surface):** In a terminal (xterm) where the **Claude Code CLI is running**, the user **clicks** a subagent (Task) invocation line in the live output — e.g. `⏺ Explore(Find session preview rendering code)` … `Done (21 tool uses · 56.4k tokens · 1m 20s)` — and a body‑mounted popup previews that subagent's **sub‑session transcript**. This is a **terminal feature**, NOT a vault‑panel feature. It reuses the existing xterm link‑provider (`terminal-clickable-file-paths`) + body‑mounted popup (`file-link-hover-preview`) + the vault's transcript reader/renderer.

> **Decisions already taken with the user:** surface = terminal; trigger = **click** (not hover); work in **main** (no worktree — `asimov/` is gitignored and lives in main; the in‑flight vault decomposition this reuses is uncommitted in main).

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `bun run asm memory search` (preview/popup/hover history) |
| Internal Patterns + Architecture | Done | finder subagent (read main‑repo **uncommitted** working tree) |
| External Research (real Claude Code CLI source) | Done | librarian → `docs/research/20260601-claude-cli-running-detection-and-subagent-linkage.md` (now incl. "Terminal render format + terminal→session mapping") |
| xterm.js API | Available | source at `/Users/huybuidac/Projects/ai-oss/xterm.js` — consult for exact `ILinkProvider`/`registerLinkProvider`/buffer API during design/build |
| Constraint Check | Done | no new deps; reuses existing OS process queries |

## Key Findings

### 1. Reuse — the xterm link‑provider + body popup stack does most of the work
- **Link providers are per‑terminal and additive.** `FilePathLinkProvider` is registered in `TerminalFactory.createTerminal` (`src/webview/terminal/TerminalFactory.ts:343-351`); xterm allows multiple `registerLinkProvider` calls, so a second `SubagentLinkProvider` slots in at the same site (auto‑applies to splits via `SplitTreeRenderer.ts:349-363`).
- **Click = `ILink.activate` → postMessage.** The file provider's activate posts `openFile` (`FilePathLinkProvider.ts:373-387`) handled host‑side (`TerminalViewProvider.ts:793-813`). A subagent provider posts a **new** message instead.
- **Multi‑line matches** (subagent = header line + `Done…` line): `ILink.range` must be single‑row; the existing provider already back‑walks logical lines, joins, and emits per‑row segments (`FilePathLinkProvider.ts:197-216, 242-399`) — reuse that pattern.
- **The popup can open from a click.** `HoverPreviewPopup.show(anchor, result, theme)` is hover‑agnostic — body‑mounted `position:fixed`, `z-index 1001`, anchored by `computePosition(clientX, clientY)` only (`HoverPreviewPopup.ts:299-434, 416-419`). Render fns are injected (`RenderCode`/`RenderMarkdown`/`onOpenFile`, `:176-227`) — the seam to inject the **vault transcript renderer**. Caveat: `result` is typed `FilePreviewResultMessage` (`src/types/messages.ts`) → a transcript needs a **new content variant / parallel `show()` path**.
- **Content + on‑disk resolution already exist in the vault layer** (uncommitted, in main): `resolveClaudeSubagentPath(parentId, stem)` → `<projects>/<dir>/<parentId>/subagents/<stem>.jsonl` (`claudeReaders/claudePaths.ts:100-131`); `readClaudeSubagentDetail` streams + classifies the child with `includeSidechain:true` (`claudeChildren.ts:32-49`); `renderNestedInto`/`renderTimelineInto` render the transcript (`previewTimeline.ts:33-87`). These feed the popup body.

### 2. Parsing the subagent line (research Q2 — exact, source‑backed)
- **Header:** `[⏺●] <AgentType>(<description>)`. Glyph `⏺` (darwin) / `●` else (`constants/figures.ts:4`) — **same glyph for ALL tool calls**; it **blinks** (glyph↔blank) while running, so match `[⏺●]?` tolerantly. `<AgentType>` = the subagent_type verbatim (`Explore`, `Plan`, `verification`, …), except `general-purpose`/`worker` → `Agent` (`AgentTool/UI.tsx:760-775`). Parens literal (`AssistantToolUseMessage.tsx:210,228`).
- **Discriminator (vs `⏺ Read(...)`/`⏺ Bash(...)`):** **only agents emit the trailer `Done (N tool uses · X tokens · Ym Zs)`** (`UI.tsx:376-377`, sep `·` U+00B7). Secondary: the name word is an agent type, never a built‑in tool name (`Read`/`Bash`/`Update`/`Create`/`Edit`). **Match on the `Done (… tool uses …)` trailer** as primary signal.
- **`(description)` is VERBATIM** = Task `input.description` = on‑disk `agent-*.meta.json.description` (`UI.tsx:411-421`, `runAgent.ts:738-742`). No component truncation; only risk is Ink right‑edge clipping when narrow → **use prefix/`startsWith` match against meta description**, not equality. Descriptions are 3–5 words by schema.
- **In‑progress variants:** no header timer; progress shows as child lines (`Initializing…`; `In progress… · N tool uses · X tokens · (ctrl+o to expand)`, `UI.tsx:495-502`) and batch (`Running N agents…`). The on‑disk subagent file already exists and is appended live, so an in‑progress subagent is previewable (partial‑aware renderer handles it).
- **Persisted `tool_use.name`** = `Agent` (modern) / `Task` (legacy) — distinct from the displayed agent‑type word.

### 3. Terminal → running session mapping (research Q1 — the one genuinely new piece)
- **Running registry (ungated):** `~/.claude/sessions/<pid>.json` → `{ pid, sessionId, cwd, startedAt }`; liveness via `process.kill(pid, 0)`; stale files filtered. **This path does not exist in the extension yet — net‑new host work.**
- **`<pid>` is claude's node REPL pid** (`main.tsx:2530`) and is a **descendant of the pty's direct child (the shell)** — so it ≠ `session.pty.pid`. Mapping options: walk the pty's process subtree to the claude node pid → registry → exact `sessionId`; OR filter the registry by the terminal's `cwd`.
- **No env/argv exposes the sessionId** for interactive sessions (`getSessionId` is in‑memory; no `CLAUDE_SESSION_ID`; `--session-id`/`--resume` only present if explicitly passed) → `/proc/<pid>/environ` won't help. Registry + process‑tree (or cwd) is the path.
- **Tie‑break (same cwd, multiple live):** newest `<sessionId>.jsonl` transcript **mtime** (current activity), then `startedAt`.
- **Extension already does OS process queries** — `queryProcessCwd(pid)` via `/proc/<pid>/cwd` (Linux) / `lsof` (macOS) (`pty/processCwd.ts:46-66`), and `session.pty.pid` (`PtySession.ts:71-73`) + `SessionManager.getCurrentCwd/getLiveCwd` (`SessionManager.ts:658-697`). A process‑tree walk reuses this OS‑query precedent.

### 4. Net‑new vs reused
- **New (host):** running‑registry reader; pty‑pid→claude‑pid→sessionId resolver (process‑tree + cwd/mtime fallback); a click‑handler that resolves `(terminal → sessionId, clicked description)` → subagent transcript `detail` and returns it.
- **New (webview):** `SubagentLinkProvider` (parse header+`Done` lines, emit clickable range, activate→IPC); a popup‑content variant that renders a transcript via `renderNestedInto`; wiring the click to open `HoverPreviewPopup` with that content.
- **New (types):** `requestSubagentPreview` / `subagentPreviewResponse` message pair.
- **Reused verbatim:** popup shell + positioning/disposal (`HoverPreviewPopup`), link‑provider back‑walk/range pattern (`FilePathLinkProvider`), `readClaudeSubagentDetail` + `resolveClaudeSubagentPath` + `renderNestedInto`, host IPC handler pattern (`TerminalViewProvider` requestVaultSessionDetail).

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Detect subagent line in terminal | `FilePathLinkProvider` back‑walk/range pattern | `SubagentLinkProvider` (header+`Done` regex, agent‑type discriminator) | **Medium** — parsing robustness (blink glyph, reflow, clip) |
| Click → action | `ILink.activate`→postMessage seam | new `requestSubagentPreview` activate + host handler | **Small** |
| Terminal → running sessionId | `pty.pid`, `queryProcessCwd`, OS‑query precedent | registry reader + process‑tree/cwd resolver | **Medium** — net‑new, OS‑specific, tie‑breaks |
| Subagent transcript content | `readClaudeSubagentDetail` + `renderNestedInto` | resolve clicked `description`→stem→detail | **Small** (prefix match) |
| Popup host + position + dispose | `HoverPreviewPopup` (click‑capable) | transcript content variant (not `FilePreviewResultMessage`) | **Small‑Medium** — new content path/typing |
| Disposal on teardown | popup `dispose()` idempotent | hook every terminal teardown (split/tab close) | **Small** — known pattern (`[[project_body_overlay_disposal]]`) |

## Options

### Decision A — Terminal→session mapping precision
- **A1 — Process‑tree exact + cwd/mtime fallback (Recommended).** Walk the pty subtree to the claude node pid → registry → exact `sessionId`; if the walk fails (perms/edge), fall back to registry‑filtered‑by‑cwd, newest‑mtime. Most correct, handles multiple sessions per cwd. Cost: an OS process‑tree query per click (cheap, on‑demand).
- **A2 — cwd + newest‑mtime heuristic only.** Skip the process‑tree walk: terminal cwd → live registry entries for that cwd → newest transcript mtime. Simpler, no tree walk; wrong when two live sessions share a cwd and both are active.
- **A3 — Registry‑by‑cwd, no liveness/tree.** Simplest; can pick a stale/wrong session. Not recommended.

### Decision B — Which subagent lines are clickable
- **B1 — Any subagent line resolvable on disk for the terminal's session, running or finished (Recommended).** Resolve the terminal's session (running via A; if claude already exited, newest session in cwd), then preview any of its subagents (in‑progress or completed). Matches scrollback reality; most useful.
- **B2 — Running‑session only.** Only clickable while a live registry entry maps the terminal; finished‑session lines no‑op. Tighter to the "while running" framing but dead clicks on scrollback confuse.

### Decision C — Popup content typing (Recommended, not a question)
Reuse `HoverPreviewPopup` with an added **transcript content variant** (new `show()` path / message content type) rendered by `renderNestedInto`, rather than a second popup class. Settled by finding §1.

### Platform (Recommended, not a question)
macOS + Linux (matches existing `queryProcessCwd`); Windows process‑tree best‑effort or disabled with a graceful no‑op. User is on darwin.

## Risks

1. **Terminal‑text parsing fragility** — blinking glyph (may render blank mid‑line), ANSI/reflow, right‑edge clipping of long `name(desc)`, and the `Done` trailer arriving on a later frame than the header. *Mitigation:* match on the `Done (… tool uses …)` trailer as the anchor; tolerant glyph regex `[⏺●]?`; prefix‑match description; validate against real `translateToString` output; verify `ILinkProvider` semantics against `/Users/huybuidac/Projects/ai-oss/xterm.js`.
2. **Process‑tree mapping cost/permissions** — walking the subtree per click; OS‑specific (`ps`/`/proc`); sandbox/perm limits. *Mitigation:* on‑demand only, reuse `queryProcessCwd` OS pattern, fall back to cwd+mtime (A1), graceful no‑op on failure.
3. **Description collision / ambiguity** — two subagents with the same description in one session. *Mitigation:* prefix match + disambiguate by order/most‑recent; if still ambiguous, pick newest by file mtime; never throw.
4. **Popup content coupling** — `HoverPreviewPopup.result` is `FilePreviewResultMessage`. *Mitigation:* add a discriminated transcript variant or a parallel `showTranscript()` path; don't overload file typing.
5. **Body‑overlay disposal on every teardown** — split close / tab close / panel dispose, not just explicit close (`[[project_body_overlay_disposal]]`). *Mitigation:* single idempotent `dispose()` wired into the terminal teardown path; one popup at a time.
6. **jsdom test isolation** (`[[project_webview_jsdom_test_isolation]]`) + **biome OOM gate** (`[[feedback_biome_oom_verification_gate]]`). *Mitigation:* afterEach DOM/listener cleanup, validate 10× full runs; gate with `tsc` + vitest, sweep unused imports manually.
7. **Reuses uncommitted vault decomposition** (`renderNestedInto`, claude subagent readers). *Mitigation:* working in main where it's present; builder must not branch off a HEAD that lacks it.

## Open Questions (for Gate 1)
- **Q‑A:** Mapping precision — A1 (process‑tree + fallback) vs A2 (cwd+mtime only)?
- **Q‑B:** Clickable scope — B1 (any on‑disk subagent of the terminal's session) vs B2 (running‑session only)?
- **Appetite:** A1+B1 ≈ **M (≤3d)**; A2+B2 trims toward **S–M**. Confirm.
