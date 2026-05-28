# Proposal: refine-file-tree-controls

## Why

The file tree's header chrome has accumulated controls that overlap with one another: the X (Close) button hides the panel, and the Toggle button in the view title bar does the same. Meanwhile there's no quick affordance to open a workspace folder — users with no workspace open see an empty-state but no CTA. This change simplifies the controls into a single mental model: the panel is always present (collapse the root row to "minimize"), and a new Open Folder button replaces the dual close/toggle pair.

## Appetite

S (≤1d)

## Scope

### In scope

- Remove the X (Close) button from the file tree header actions cluster.
- Remove the Toggle title-bar buttons (`anywhereTerminal.toggleFileTree.{sidebar,panel}` view/title menu entries) AND their command declarations + handlers.
- Add an Open Folder header button (icon `$(folder-opened)`) that posts `request-open-folder` and the extension host invokes `vscode.commands.executeCommand('vscode.openFolder')`.
- Add an always-visible 1px horizontal divider between the terminal area and the file tree when `position === 'bottom'`.
- Drop `open: boolean` from `FileTreeState` schema (additive removal — older persisted values are ignored on read).
- Replace the move-button → QuickPick roundtrip with an in-panel dropdown menu anchored to the move button (4 options: Top/Bottom/Left/Right; ARIA menubutton + ESC/Arrow/Enter keyboard nav + click-outside dismiss). Selecting an item calls `panel.setPosition` directly — no IPC roundtrip.
- Remove the now-dead `RequestSetFileTreePositionMessage` type + `FileTreeHost.handleMessage` case + provider fall-through entries. The command palette path (`anywhereTerminal.setFileTreePosition`) stays — it owns its own QuickPick and posts `SetFileTreePosition` directly to the webview.

### Out of scope

- Changes to top/left/right divider behavior (no new divider for those sides — existing sash stays).
- Empty-state CTA changes (the new Open Folder button in the header is always reachable; empty state stays as-is).
- A new command palette entry for Open Folder (the built-in `vscode.openFolder` is already there).
- Migrating the legacy `fileTree` deprecated slot (untouched by this change).

## Capabilities

1. **file-tree-panel** — spec deltas: drop Toggle command, drop Title-bar buttons, modify State persistence schema, modify Header search button ordering, add Open Folder header button, add Open Folder message handler, add Bottom-position visible divider.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — header buttons change, title-bar entries disappear, new divider appears at bottom position.
- **E2E required?** NOT REQUIRED — `asimov/project.md` § Commands lists E2E as N/A. Verification is by `manual` smoke + unit coverage for state-schema changes.
- **Justification**: No automated VS Code extension E2E harness exists in this repo; UI tweaks are visually verified via `pnpm run package` + manual VSIX install per project convention.

## Risk Level

LOW — Pure UI surface tweak. No new dependencies, no PTY/IPC protocol changes (one new message type added). Persistence schema change is additive removal — old values ignored, no migration script needed.
