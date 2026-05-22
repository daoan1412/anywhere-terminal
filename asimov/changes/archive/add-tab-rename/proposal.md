# Proposal: add-tab-rename

## Why

Users can't give a terminal tab a meaningful name. Default labels are `Terminal N` and the OSC-title auto-rename (`process-title-tracking`) overwrites anything else on every shell prompt. A planned `rename` IPC message was reserved in `docs/design/message-protocol.md` §11.1 and the `260306-1542-add-multi-tab-ui` proposal explicitly cut renaming as a follow-up — this change delivers it.

## Appetite

**M (≤3 days, upper end)** — single capability touching webview UI (overlay inline-edit module) + IPC + host data model + workspaceState persistence + editor-provider instance registry + package.json contributions. No new dependencies. The editor-provider work (new static registry to enable F2/command-palette in editor-area webview panels) and the overlay-input module are the two cost drivers.

## Scope

### In scope

- New `customName?: string` field on `TerminalSession` (host) and `TerminalInstance` (webview), with custom-wins-over-auto render priority.
- Three rename entry points: double-click on tab (inline `<input>` edit), tab right-click context menu (`Rename Tab…`), command palette command `anywhereTerminal.renameTab`.
- Default keybinding `F2` when an Anywhere Terminal webview is focused.
- IPC: new `renameTab` message (WV→Ext); custom name carried in `init` and `tabCreated` payloads (Ext→WV).
- Workspace-scoped persistence in `ExtensionContext.workspaceState`, keyed by terminal number, **root-tab sessions only** (split panes excluded — see design.md D3). Recycled numbers reclaim their persisted name.
- Reset path: empty (after trim) input clears the custom name → tab reverts to live auto-name.
- Validation: trim whitespace, max 80 chars, oversize input rejected silently at the host.

### Out of scope

- Per-pane rename inside split layouts (custom name lives on the root tab; active-pane process names are suppressed when a custom name is set).
- Drag-to-reorder tabs.
- Tab pinning, color tagging, or any other tab metadata.
- Cross-workspace (global) persistence — would require a different key model and bleeds context between projects.
- Variable substitution / templated names (`${cwd}`, `${branch}`, etc.).

## Capabilities

1. **tab-rename** *(new)* — End-to-end rename feature: triggers (dblclick / context menu / command / F2), IPC message contract, custom-name field semantics, validation rules, persistence model.
2. **session-manager-core** *(modified)* — Add `customName?: string` to `TerminalSession`; expose `renameSession(sessionId, name | null)` and rename-aware persistence.
3. **process-title-tracking** *(modified)* — OSC title events continue to update the live process name field, but the rendered tab label is subordinated to `customName` when set.
4. **tab-bar-component** *(modified)* — Tab DOM carries `webviewSection='terminalTab'`; tab renderer displays `customName ?? name`; dblclick spawns inline edit.
5. **terminal-context-menu** *(modified)* — Adds `Rename Tab…` in a new `tab@1` group keyed by the new `terminalTab` webviewSection.
6. **split-focus-management** *(modified)* — Custom name on the root tab session overrides active-pane process-name display.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — new visible affordances (inline edit, context menu entry, command), and visible label override semantics.
- **E2E required?** NOT REQUIRED — project has no E2E harness (`asimov/project.md` § Commands → `E2E: N/A`). Manual smoke check covers the user-facing flow.
- **Justification**: Inline edit, IPC, host state, and persistence are individually unit-testable (Vitest). Visual integration is verified manually per the project's standard workflow.

## Risk Level

**MEDIUM** — single-capability scope but crosses host↔webview boundary, mutates shared `TerminalSession` data model, adds first-of-its-kind webviewState→workspaceState persistence for session metadata, and changes the rendered tab-label contract that two existing specs (`process-title-tracking`, `split-focus-management`) depend on.
