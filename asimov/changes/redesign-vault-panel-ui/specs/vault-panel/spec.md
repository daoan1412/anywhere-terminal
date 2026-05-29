# vault-panel Specification

## MODIFIED Requirements

### Requirement: Searchable vault panel

The system SHALL present the aggregated session list in a webview panel. Each row SHALL show, on a single line: the agent badge rendering the agent's **real brand icon** (inline SVG themed via the agent's accent color), the title preview, a `cwd` chip (folder icon + leaf segment), a relative timestamp, and an **icon-only Resume action revealed on row hover/focus**. Rows SHALL NOT render a fork action.

### Requirement: Empty and partial-failure states

WHEN the aggregated index is empty, the panel SHALL render an empty-state message. WHEN a search or filter yields no matching rows, the panel SHALL render a **distinct no-match state** (not the empty state). WHEN the index reports N unreadable entries, the panel SHALL show a non-blocking inline notice with the count and a **"Details" affordance that, when activated, reveals the per-source reasons** those entries were skipped, without hiding the entries that did load.

## ADDED Requirements

### Requirement: Grouping modes

The panel SHALL provide a grouping control with exactly three modes — **Recent**, **Agent**, **Folder** — applied client-side over the already-loaded list (no host round-trip). Recent SHALL render a flat list ordered by modified time descending. Agent SHALL group rows by agent under a header showing the agent accent dot, display name, and entry count. Folder SHALL group rows by session `cwd` under collapsible headers and SHALL omit the per-row `cwd` chip. The selected mode SHALL persist across reloads (default: Recent).

### Requirement: Row context menu

Right-clicking a row SHALL open a context menu offering: Resume in New Tab, Open, Reveal in Finder, Copy File Path, Copy Resume Command, Open Working Directory. The file-targeting items (Open, Reveal in Finder, Copy File Path) SHALL be shown only when the session is backed by an on-disk file; for sessions stored only in a database they SHALL be omitted. Each item SHALL act by sending the entry `id` to the host (which derives any path itself); the webview SHALL NOT send a file path as the action target. There SHALL be no separate "⋯" trigger — the menu is reached only by right-click.

#### Scenario: Database-backed session hides file actions

- **WHEN** the user right-clicks a row whose agent stores sessions in a database (no session file path)
- **THEN** the context menu omits Open, Reveal in Finder, and Copy File Path, while Resume in New Tab, Copy Resume Command, and Open Working Directory remain

### Requirement: Folder-scope filter ("This folder only")

The panel SHALL provide a "This folder only" checkbox that, when checked, restricts the list to sessions whose `cwd` is equal to or inside the focused terminal pane's current working directory. The scoping cwd SHALL be the pane's REAL cwd as resolved by the host (the pane's live process cwd, else its shell-integration-tracked cwd, else its spawn cwd) — it SHALL NOT depend on the webview observing an OSC 7 sequence, so the filter works without shell integration. The panel SHALL re-scope when the focused pane changes and SHALL reflect a `cd` within the focused pane (the scoping cwd is re-resolved when the active pane emits output). The checkbox state SHALL persist across reloads (default: off). WHEN no cwd can be resolved for the pane, the filter SHALL fall back to the workspace root, and WHEN neither resolves it SHALL show all sessions rather than hiding everything.

#### Scenario: Switching the focused pane re-scopes the list

- **WHEN** "This folder only" is on and the user focuses a different terminal pane whose working directory differs
- **THEN** the list re-scopes to the newly focused pane's folder, even when neither pane emits OSC 7

#### Scenario: `cd` in the focused pane updates the scope

- **WHEN** "This folder only" is on and the user changes directory in the focused terminal
- **THEN** the list re-scopes to the new folder shortly after the prompt returns, without requiring shell integration

### Requirement: Session preview activation

Activating a row (click, Enter, or Space) SHALL open a floating session-preview overlay anchored near the activated row within the panel; pressing Esc or clicking outside SHALL close it. Opening the preview SHALL request the session's detail on demand (see the `vault-session-preview` capability). At most one preview SHALL be open at a time, and a detail response for a session that is no longer the active preview SHALL be ignored (no stale render).
