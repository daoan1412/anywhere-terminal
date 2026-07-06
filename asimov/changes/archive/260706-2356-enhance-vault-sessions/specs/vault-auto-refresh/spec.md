## ADDED Requirements

### Requirement: Automatic list refresh on store change

The system SHALL watch the on-disk session stores for all supported agents (Claude projects dir, Codex sessions dir + state DB, OpenCode DB) and SHALL automatically refresh the vault list when a store changes, without requiring the manual refresh control. Automatic refreshes SHALL be debounced/coalesced (single trailing refresh per burst) and SHALL reuse the existing incremental stale-while-revalidate path with its single-flight guard, so overlapping store changes do not trigger concurrent full rescans.

#### Scenario: New session appears without clicking refresh

- **WHEN** a watched agent store changes (a session is created or updated on disk) while the vault view is open
- **THEN** the vault list updates automatically after the watcher event or a window-focus rehydrate — typically within the debounce/coalescing window — reflecting the change, with the manual control remaining as a fallback

### Requirement: Non-disruptive auto-update

An automatic refresh SHALL preserve the user's current list scroll position and selection, and SHALL NOT close, reset, or reload an open session preview.

### Requirement: Manual refresh preserved

The manual refresh control SHALL remain available and functional as a fallback for on-demand refresh.
