## MODIFIED Requirements

### Requirement: OSC Title Change Handling

The webview SHALL listen for xterm.js `onTitleChange` events on each terminal instance and update the `TerminalInstance.name` property with the new title. The webview MUST always update `name`, even when `customName` is set, so that clearing the custom name reveals the most recent auto-name without waiting for the next OSC event.

The tab bar's rendered label MUST come from the expression `customName ?? name` — that is, `customName` takes priority when non-null; otherwise the OSC-driven `name` is shown.

#### Scenario: OSC update with customName set does not change displayed label

- **Given** a tab with `customName = "build"` and `name = "Terminal 1"`
- **When** the shell emits an OSC title sequence setting the title to `"npm run dev"`
- **Then** `TerminalInstance.name` SHALL be updated to `"npm run dev"`
- **And** the tab bar SHALL continue to display `"build"`

#### Scenario: Clearing customName instantly reveals last OSC name

- **Given** a tab with `customName = "build"` and `name = "npm run dev"` (last OSC update)
- **When** the user submits an empty rename, clearing `customName` to `null`
- **Then** the tab bar SHALL display `"npm run dev"` on the next render — no shell prompt cycle required
