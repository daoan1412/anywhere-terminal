## MODIFIED Requirements

### Requirement: Session Data Model

The `SessionManager` SHALL maintain a `TerminalSession` interface with the following fields:
- `id: string` — unique session identifier (UUID via `crypto.randomUUID()`)
- `viewId: string` — which view this session belongs to
- `pty: PtySession` — the PTY process wrapper
- `name: string` — auto-derived display name (default `"Terminal N"`; mutated by OSC title events)
- `customName: string | null` — user-supplied display name; when non-null, takes display priority over `name`
- `isActive: boolean` — whether this is the active tab in its view
- `number: number` — assigned terminal number (for name, recycling, and `customName` persistence key)
- `outputBuffer: OutputBuffer` — per-session output buffer
- `scrollbackCache: string[]` — cached scrollback lines for view restore
- `createdAt: number` — timestamp of session creation
- `cols: number` — current terminal columns
- `rows: number` — current terminal rows
- `disposables: Array<{ dispose(): void }>` — per-session event subscriptions

The `SessionManager` MUST maintain these internal maps:
- `sessions: Map<string, TerminalSession>` — all sessions indexed by ID
- `viewSessions: Map<string, string[]>` — view ID → ordered list of session IDs
- `usedNumbers: Set<number>` — terminal numbers currently in use

## ADDED Requirements

### Requirement: Rename Session API

`SessionManager.renameSession(sessionId: string, input: string | null): void` SHALL be the single public mutation entry point for `TerminalSession.customName`. It MUST:

1. No-op silently when `sessionId` is unknown (matches `writeToSession`/`resizeSession` convention).
2. No-op silently when the resolved session has `isSplitPane === true` — split panes are not valid rename targets (defensive; provider command handlers should already resolve to root tab ids).
3. Apply the normalization rules defined in `tab-rename` (`null`/trim/empty→null/truncate-to-80) to `input`.
4. Update the session's `customName` field with the normalized value.
5. Push the normalized `customName` to the owning webview via `{ type: "tabRenamed", tabId, customName }`.
6. Persist (fire-and-forget per design.md D9): upsert into the `workspaceState` record at key `anywhereTerminal.tabCustomNames` (keyed by `String(session.number)`) when normalized is non-null; delete the entry when normalized is null. The persist write SHALL log on failure but MUST NOT block the return.

The method returns synchronously; persistence completes asynchronously in the background.

#### Scenario: Rename unknown session is no-op

- **Given** no session `"xyz"` exists
- **When** `renameSession("xyz", "foo")` is called
- **Then** no error is thrown and no `workspaceState` write occurs

### Requirement: Persisted Custom Name Hydration

`SessionManager.createSession` MUST, after `findAvailableNumber()` returns the new session's `number` **AND only when the new session is NOT a split pane (`isSplitPane === false`)**, look up `anywhereTerminal.tabCustomNames[String(number)]` in `workspaceState`. If a value is present, the newly created session's `customName` SHALL be initialized to that value and included in the `tabCreated` payload sent to the webview.

Split-pane session creation MUST skip this hydration entirely. Reason: split panes consume `usedNumbers` but are not user-visible tab identities — applying a persisted root-tab name to them would later leak that name onto an unrelated root tab when the number recycles.
