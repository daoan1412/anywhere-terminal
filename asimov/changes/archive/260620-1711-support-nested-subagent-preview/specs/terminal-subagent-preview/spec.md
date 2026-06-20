# terminal-subagent-preview Specification

## MODIFIED Requirements

### Requirement: Click opens the subagent preview popup

Activating a detected subagent link (`ILink.activate(event)`) SHALL post a `requestSubagentPreview` message carrying the source `terminalId`, a correlation `requestId`, the closure‑captured `description`, and the click viewport coordinates (`event.clientX/clientY`), and SHALL open a **single** body‑mounted floating popup anchored at the click that renders the returned `VaultSessionDetail` transcript with the shared transcript renderer. The popup SHALL support nested drill‑down: a nested `subagentSession` block inside the popup SHALL be expandable, fetching the child's detail on demand by its `entryId` and rendering it nested in place — i.e. the popup SHALL use a real nested‑timeline bag (lazy fetch + cache + the same self‑referential cycle guard the panel uses), not a no‑op `populateNested`. The on‑demand fetch SHALL go through the popup's own `requestSubagentPreview` round‑trip carrying the child `entryId` (resolved host‑side by id, containment‑checked), whose response is correlated back to the requesting nested block — NOT the vault panel's detail channel. Arbitrary nesting depth SHALL be supported without eagerly loading the whole tree. Normal terminal text selection and existing file‑path links SHALL remain unaffected. Opening a new subagent popup SHALL dismiss any previously open one (at most one at a time).

#### Scenario: Nested subagent expands inside the terminal popup

- **WHEN** a clicked subagent's transcript itself spawned a sub‑subagent (a nested `subagentSession` block renders in the popup) and the user expands that block
- **THEN** the popup fetches the sub‑subagent's detail by its `entryId` and renders its transcript nested in place, without dismissing the popup
