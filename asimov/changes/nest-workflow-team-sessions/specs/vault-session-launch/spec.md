## MODIFIED Requirements

### Requirement: Launch resolves a single entry by id

WHEN resolving the launch options for a resume or fork, the system SHALL resolve the target entry directly by its id from only the relevant agent's store (a point or locate-by-id lookup), and SHALL NOT aggregate or scan every agent's session store to find it. Resolving a single entry SHALL NOT trigger work scoped to other agents (e.g. the OpenCode version probe SHALL run only when the target entry is an OpenCode session). The agent's store location SHALL be derived from the id host-side; a webview-supplied path SHALL NOT be trusted.

Synthetic child/group/segment ids — those carrying a nesting marker (`:subagent:`, `:workflow:`, `:wfagent:`, `:turn:`) — are detail-view handles only and SHALL NOT resolve to a launchable entry: `getEntry` SHALL return null for them, so a nested view node never offers resume or fork. (An id containing `:` already fails the session-id safety check, so this holds without a separate guard.) A teammate turn (`:turn:`) is a view of a slice of a member session; the member session itself stays launchable by its plain `claude:<memberId>`.
