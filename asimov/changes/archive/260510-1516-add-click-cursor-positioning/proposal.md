# Proposal: add-click-cursor-positioning

## Why

Moving the terminal cursor with arrow keys is slow when editing longer commands. Plain click-to-cursor gives users a direct way to reposition the prompt cursor inside AnyWhere Terminal without leaving the existing xterm.js/PTY input model.

## Appetite

S (≤1d)

## Scope

### In scope
- Add plain primary-click cursor movement for active, live terminal prompts.
- Preserve existing split-pane click-to-focus behavior.
- Preserve mouse selection, modified-click behavior, and scrolled-back viewport behavior.
- Preserve app-owned mouse handling when xterm is in alternate buffer or mouse tracking mode.
- Cover coordinate mapping and movement sequence generation with unit tests.

### Out of scope
- Supporting arbitrary cursor repositioning inside fullscreen or mouse-aware TUI apps such as vim, nano, htop, less, OpenCode TUI screens, or Claude Code alternate-screen UI states.
- Adding a new VS Code setting unless implementation reveals a concrete need.
- Adding new IPC message types or changing extension-host PTY routing.
- Changing xterm selection, context menu, or drag/drop path insertion behavior beyond necessary guards.

## Capabilities

1. **click-cursor-positioning** — Plain click in the live terminal viewport emits cursor movement input toward the clicked cell while avoiding selection and scrollback conflicts.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES
- **E2E required?** NOT REQUIRED
- **Justification**: The project has no E2E target, and this behavior can be covered by unit tests for click guards/coordinate conversion plus manual verification in the VS Code webview.

## Risk Level

LOW — The change is contained to webview-side terminal input behavior and reuses the existing raw input path; the main risks are UX conflicts with selection and mouse-aware apps, mitigated by explicit guards.
