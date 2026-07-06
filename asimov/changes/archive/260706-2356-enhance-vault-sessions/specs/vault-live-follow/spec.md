## ADDED Requirements

### Requirement: Follow the previewed session

While a session preview is open, the system SHALL watch that session's underlying store and SHALL fetch newly appended messages as they arrive, debounced, reusing the existing bounded session-detail read. The system SHALL re-render only when the session's content actually changed (new timeline items or a newer last-message timestamp).

### Requirement: Auto-scroll when at bottom

WHEN the preview is scrolled at, or within a small pixel threshold of, the bottom and new messages arrive, the system SHALL append the new messages and auto-scroll so the latest message stays visible.

#### Scenario: Reading the tail

- **WHEN** the user is at the bottom of an open preview and the agent appends a new message
- **THEN** the new message is appended and the view scrolls to keep it visible, with no manual action

### Requirement: New-message indicator when scrolled up

WHEN the preview is scrolled away from the bottom (beyond the threshold) and new messages arrive, the system SHALL show a "N new messages" indicator instead of auto-scrolling. Activating the indicator SHALL scroll to the newest message and clear the indicator; the count SHALL reflect the number of messages arrived since the user last saw the bottom.

### Requirement: Stop following on close or switch

Closing the preview, or opening a different session, SHALL stop watching the previously followed session so no orphaned watcher remains.
