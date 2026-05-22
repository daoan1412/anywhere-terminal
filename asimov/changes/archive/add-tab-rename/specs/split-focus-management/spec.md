## MODIFIED Requirements

### Requirement: Tab Bar Reflects Active Pane

When a tab has split panes, the tab bar's *active-pane awareness* MUST continue to drive focus, input routing, and visual focus indicators within the tab content area. For the **tab label** specifically, display priority SHALL be:

1. `customName` (when non-null) — wins unconditionally, regardless of which pane is active.
2. Otherwise, the active pane's session `name` — preserves existing process-name-follows-active-pane behavior.

In other words, a user's custom rename always wins over per-pane process-name display. Switching the active pane SHALL still trigger a tab-bar re-render so that step 2 takes effect when `customName` is null.

#### Scenario: Switching active pane with customName set does not change label

- **Given** a tab with `customName = "build"` and two split panes (`panel-a` = `"npm"`, `panel-b` = `"vim"`)
- **When** the user focuses `panel-b`
- **Then** the tab bar continues to display `"build"`

#### Scenario: Switching active pane without customName tracks the pane

- **Given** a tab with `customName = null` and panes `panel-a` (`name = "npm"`) and `panel-b` (`name = "vim"`)
- **When** the user focuses `panel-b`
- **Then** the tab bar displays `"vim"`
