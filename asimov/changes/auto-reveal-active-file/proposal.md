# Proposal: auto-reveal-active-file

## Why

Users frequently switch between the active editor tab and the AnyWhere Terminal file tree panel. Today the tree never follows the editor — users must manually expand folders to locate the file they're editing. VSCode solves this with `explorer.autoReveal`; matching that behavior removes a high-friction papercut and brings the in-extension tree to feature parity.

## Appetite

M (~2–3 days). Bulk of webview surface (`Tree<T>.revealElement`, `FileTreePanel.revealPath`, `RevealInFileTreeMessage` plumbing) already exists from the OSC 7 path — net new work is a host-side listener service, two new settings, glob-exclude matching, and a `focusNoScroll` arg.

## Scope

### In scope

- Two new VS Code settings: `anywhereTerminal.fileTree.autoReveal` (`true` | `false` | `"focusNoScroll"`, default `true`) and `anywhereTerminal.fileTree.autoRevealExclude` (glob object, default `{"**/node_modules": true, "**/bower_components": true}`)
- A host-side `ActiveFileRevealer` service that listens to `vscode.window.tabGroups.onDidChangeActiveTab`, resolves the active editor's file path, applies exclude globs, and posts a `RevealInFileTreeMessage` to each webview whose file-tree panel is currently open
- A 100 ms debounce on the editor-change event to absorb tab-cycling churn
- Extension of `RevealInFileTreeMessage` with an optional `focusNoScroll?: boolean` field
- Webview wiring so `FileTreePanel.revealPath(path, { focusNoScroll })` honors the flag (selects + focuses row but skips `Tree<T>.revealElement` scroll)
- Live reload: changes to either setting take effect without reloading the window
- Unit test for the exclude glob matcher

### Out of scope

- "Smart-sticky" pause-after-user-interaction behavior (a future enhancement; tracked as a follow-up idea, not this change)
- Reveal queueing when the panel is hidden — when panel is closed, reveals are dropped silently (matches the "open the panel to see current state" mental model the existing `expandedPaths` persistence already provides)
- Auto-reveal for non-`file:` URIs (untitled, vscode-remote, custom editors with non-file `resource`) — skipped silently
- Reveal across split file-tree panels (current panel is single-instance per webview; no multi-panel concept exists)
- Interaction with the in-progress search filter (`add-file-tree-search`) — if that lands first and the target is filtered out, reveal is allowed to no-op; deeper coordination is a follow-up

## Capabilities

1. **auto-reveal-active-file** — Wires the active editor file selection into the file tree panel, with a VSCode-compatible 3-state setting plus exclude globs, debounced and gated by panel visibility.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — tree rows auto-expand and auto-select as the user changes editor tabs.
- **E2E required?** NOT REQUIRED.
- **Justification**: The project has no E2E harness (`asimov/project.md` declares E2E = N/A). Reveal logic is covered by unit tests on the host-side exclude matcher + manual smoke check (open file → see reveal). Webview integration uses an existing path already exercised in production by the OSC 7 reveal feature.

## Risk Level

**LOW–MEDIUM** — almost all moving parts are additions; the only existing-code touch is extending `RevealInFileTreeMessage` (additive field), `FileTreePanel.revealPath` signature (default arg), and `package.json` configuration. New external API surfaces (`window.tabGroups`, glob matcher) are well-understood. Primary risk is UX (reveal feels noisy) — mitigated by the `focusNoScroll` setting value and 100 ms debounce.
