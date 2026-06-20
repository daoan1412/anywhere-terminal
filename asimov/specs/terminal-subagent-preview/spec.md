# terminal-subagent-preview Specification
## Requirements

### Requirement: Detect subagent invocations in terminal output

The webview SHALL register a per‑terminal xterm link provider that marks each Claude CLI subagent (Task) invocation **header line** `[⏺●]? <AgentType>(<description>)` as a clickable link covering that single line. Recognition SHALL be by the **header alone** (no cross‑line join): `<AgentType>` MUST NOT be a built‑in tool display name (`Read`, `Bash`, `Edit`, `MultiEdit`, `Update`, `Create`, `Write`, `Grep`, `Glob`, `NotebookEdit`, `Search`, `Task`) nor an MCP tool (`mcp__…`) — any other name is treated as an agent type. Matching SHALL tolerate the status glyph blinking to a blank cell (`[⏺●]?`) and SHALL capture `<description>` verbatim (a prefix suffices for resolution). A header that is in fact not a previewable subagent SHALL resolve to a harmless `notFound` host‑side (no popup error noise).

> Rationale (do not weaken): the `Done (… tool uses …)` / in‑progress trailers render as **separate, non‑contiguous lines** (child `⎿` lines intervene) and xterm `ILink.range` is single‑row — so the header CANNOT be reached by back‑walking from the trailer, and a link emitted on the trailer row cannot decorate the header row. The header line is therefore matched directly. Batch tree‑line headers (`├─ <type>(<desc>)`, no glyph) are best‑effort, not required.

### Requirement: Click opens the subagent preview popup

Activating a detected subagent link (`ILink.activate(event)`) SHALL post a `requestSubagentPreview` message carrying the source `terminalId`, a correlation `requestId`, the closure‑captured `description`, and the click viewport coordinates (`event.clientX/clientY`), and SHALL open a **single** body‑mounted floating popup anchored at the click that renders the returned `VaultSessionDetail` transcript with the shared transcript renderer. The popup SHALL support nested drill‑down: a nested `subagentSession` block inside the popup SHALL be expandable, fetching the child's detail on demand by its `entryId` and rendering it nested in place — i.e. the popup SHALL use a real nested‑timeline bag (lazy fetch + cache + the same self‑referential cycle guard the panel uses), not a no‑op `populateNested`. The on‑demand fetch SHALL go through the popup's own `requestSubagentPreview` round‑trip carrying the child `entryId` (resolved host‑side by id, containment‑checked), whose response is correlated back to the requesting nested block — NOT the vault panel's detail channel. Arbitrary nesting depth SHALL be supported without eagerly loading the whole tree. Normal terminal text selection and existing file‑path links SHALL remain unaffected. Opening a new subagent popup SHALL dismiss any previously open one (at most one at a time).

#### Scenario: Nested subagent expands inside the terminal popup

- **WHEN** a clicked subagent's transcript itself spawned a sub‑subagent (a nested `subagentSession` block renders in the popup) and the user expands that block
- **THEN** the popup fetches the sub‑subagent's detail by its `entryId` and renders its transcript nested in place, without dismissing the popup

### Requirement: Popup lifecycle and disposal

The popup SHALL show a loading state until the transcript arrives and SHALL render an empty/error state — never throw — when resolution fails (no running session, no matching subagent, or read error). It SHALL dismiss on Escape, on outside click, and when another subagent link is clicked. It SHALL be disposed on **every** terminal teardown path (tab close, split close, panel dispose) via an idempotent `dispose()` that leaves no orphaned `document.body` node.

