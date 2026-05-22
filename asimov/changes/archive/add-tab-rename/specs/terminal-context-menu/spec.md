## MODIFIED Requirements

### Requirement: Context Menu Contribution Points

The `package.json` SHALL declare the following entries under `contributes.menus.webview/context`:

| Command | Label | Group | Order | When |
|---|---|---|---|---|
| `anywhereTerminal.ctx.copy` | Copy | clipboard@1 | 1 | `webviewSection == 'splitPane'` |
| `anywhereTerminal.ctx.paste` | Paste | clipboard@1 | 2 | `webviewSection == 'splitPane'` |
| `anywhereTerminal.ctx.selectAll` | Select All | clipboard@1 | 3 | `webviewSection == 'splitPane'` |
| `anywhereTerminal.ctx.clearTerminal` | Clear Terminal | terminal@2 | 1 | `webviewSection == 'splitPane'` |
| `anywhereTerminal.ctx.newTerminal` | New Terminal | terminal@2 | 2 | `webviewSection == 'splitPane'` |
| `anywhereTerminal.ctx.killTerminal` | Kill Terminal | terminal@2 | 3 | `webviewSection == 'splitPane'` |
| `anywhereTerminal.renameTab` | Rename Tab… | tab@1 | 1 | `webviewSection == 'terminalTab'` |

Existing split-pane entries (Close Pane, Split Vertical, Split Horizontal) SHALL remain in their current groups, renumbered as needed to appear after the new entries.

The same command id (`anywhereTerminal.renameTab`) SHALL be used by both the context menu and the command palette. VS Code command-palette visibility is per-command-id (not per-menu-instance), so no `commandPalette` `when: "false"` override is needed. The label divergence — palette shows `Anywhere Terminal: Rename Tab…`, context menu shows `Rename Tab…` — is achieved by declaring the command with `title: "Rename Tab…"` + `category: "Anywhere Terminal"` (palette auto-prefixes with the category; context menus display only the `title`). See design.md D8.

#### Scenario: Right-clicking a tab shows Rename Tab, not pane commands

- **Given** the tab bar shows two tabs and the user right-clicks a tab element
- **Then** the context menu shows the `Rename Tab…` entry
- **And** the menu does NOT show Copy / Paste / Clear Terminal / Kill Terminal (those are gated to `webviewSection == 'splitPane'`)

#### Scenario: Right-clicking a terminal pane does not show Rename Tab

- **Given** the user right-clicks inside a terminal pane
- **Then** the context menu shows the existing pane entries (Copy/Paste/Clear/etc.)
- **And** the menu does NOT show `Rename Tab…` (gated to `webviewSection == 'terminalTab'`)
