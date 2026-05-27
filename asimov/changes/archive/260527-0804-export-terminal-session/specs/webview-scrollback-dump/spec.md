## ADDED Requirements

### Requirement: Request/response IPC for full xterm scrollback

The system SHALL define two new IPC messages: extension → webview `{ type: "requestScrollbackDump", tabId, requestId }` and webview → extension `{ type: "scrollbackDump", tabId, requestId, data, lineCount, truncated }`. The webview SHALL serialise the xterm.js scrollback for the requested `tabId` via the existing xterm.js serialisation addon used by snapshot persistence (concrete addon + module choice in `design.md` D4), then reply with the resulting string in `data`, the count of scrollback lines serialised in `lineCount`, and `truncated = true` iff the xterm `scrollback` setting capped the output.

#### Scenario: Unknown tabId

- **WHEN** the webview receives `requestScrollbackDump` for a `tabId` that does not match a live xterm instance
- **THEN** the webview MUST reply with `{ type: "scrollbackDump", tabId, requestId, data: "", lineCount: 0, truncated: false }` rather than dropping the request. The extension-side caller MUST treat an empty string as a valid empty buffer.

### Requirement: Extension-side promise wrapper with session-dispose safety

The system SHALL expose, on `SessionManager`, an async method `requestScrollbackDump(sessionId: string): Promise<{ data: string; lineCount: number; truncated: boolean }>` that internally generates a `requestId`, posts the message, awaits the matching reply, and resolves. If the session is disposed before the reply arrives, the promise MUST reject with a typed error `ScrollbackDumpAbortedError` rather than hang indefinitely; a per-request timeout of 15 seconds MUST apply as a backstop, rejecting with `ScrollbackDumpTimeoutError`.

#### Scenario: Concurrent dump requests for the same session

- **WHEN** two callers invoke `requestScrollbackDump` for the same `sessionId` before the first completes
- **THEN** the webview MUST reuse a single in-flight serialisation for that `tabId` and reply to BOTH `requestId`s with identical `data`, `lineCount`, and `truncated` values. The system MUST NOT trigger a second serialisation against the same Terminal until the first has completed.
