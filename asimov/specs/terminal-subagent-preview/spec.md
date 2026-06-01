# terminal-subagent-preview Specification
## Requirements

### Requirement: Detect subagent invocations in terminal output

The webview SHALL register a per‑terminal xterm link provider that marks each Claude CLI subagent (Task) invocation **header line** `[⏺●]? <AgentType>(<description>)` as a clickable link covering that single line. Recognition SHALL be by the **header alone** (no cross‑line join): `<AgentType>` MUST NOT be a built‑in tool display name (`Read`, `Bash`, `Edit`, `MultiEdit`, `Update`, `Create`, `Write`, `Grep`, `Glob`, `NotebookEdit`, `Search`, `Task`) nor an MCP tool (`mcp__…`) — any other name is treated as an agent type. Matching SHALL tolerate the status glyph blinking to a blank cell (`[⏺●]?`) and SHALL capture `<description>` verbatim (a prefix suffices for resolution). A header that is in fact not a previewable subagent SHALL resolve to a harmless `notFound` host‑side (no popup error noise).

> Rationale (do not weaken): the `Done (… tool uses …)` / in‑progress trailers render as **separate, non‑contiguous lines** (child `⎿` lines intervene) and xterm `ILink.range` is single‑row — so the header CANNOT be reached by back‑walking from the trailer, and a link emitted on the trailer row cannot decorate the header row. The header line is therefore matched directly. Batch tree‑line headers (`├─ <type>(<desc>)`, no glyph) are best‑effort, not required.

### Requirement: Click opens the subagent preview popup

Activating a detected subagent link (`ILink.activate(event)`) SHALL post a `requestSubagentPreview` message carrying the source `terminalId`, a correlation `requestId`, the closure‑captured `description`, and the click viewport coordinates (`event.clientX/clientY`), and SHALL open a **single** body‑mounted floating popup anchored at the click that renders the returned `VaultSessionDetail` transcript with the shared transcript renderer. For MVP the popup renders the transcript **flat** (a stub timeline bag whose `populateNested` is a no‑op); expanding nested sub‑subagents inside the popup is out of scope. Normal terminal text selection and existing file‑path links SHALL remain unaffected. Opening a new subagent popup SHALL dismiss any previously open one (at most one at a time).

### Requirement: Popup lifecycle and disposal

The popup SHALL show a loading state until the transcript arrives and SHALL render an empty/error state — never throw — when resolution fails (no running session, no matching subagent, or read error). It SHALL dismiss on Escape, on outside click, and when another subagent link is clicked. It SHALL be disposed on **every** terminal teardown path (tab close, split close, panel dispose) via an idempotent `dispose()` that leaves no orphaned `document.body` node.

