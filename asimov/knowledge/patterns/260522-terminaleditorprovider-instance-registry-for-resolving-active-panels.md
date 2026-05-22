---
labels: [vscode-api, provider-pattern, editor-panels, command-resolution]
source: add-tab-rename
summary: TerminalEditorProvider.createPanel() initially discarded the provider instance. Adding host-side commands (like F2 rename) requires a static Map<WebviewPanel, TerminalEditorProvider> to resolve the active panel's provider.
---
# TerminalEditorProvider instance registry for resolving active panels
**Date**: 2026-05-22

## TL;DR
- `TerminalEditorProvider.createPanel()` constructed a provider but discarded the reference (was: `const _provider = new ...`)
- No instance registry existed; only `_activePanels` Set tracked WebviewPanel objects
- Adding host-side commands (rename via F2, command palette) requires resolving the active panel's provider to call `getActiveTabId()`
- Solution: add static `Map<WebviewPanel, TerminalEditorProvider>` to track instances; add `getActiveProvider()` to walk active panels

## Context
The rename command needs to resolve its target tab. For command-palette and F2 keybinding (host-side triggers), the command handler must:
1. Find the active editor panel (`panel.active === true`)
2. Get its provider
3. Call `provider.getActiveTabId()` to fetch the root tab to rename

Without the instance registry, step 2 was impossible.

## Evidence
### Anchors
- `src/providers/TerminalEditorProvider.ts` → `static readonly _instances = new Map<vscode.WebviewPanel, TerminalEditorProvider>()` (line ~100)
- `createPanel()` (line ~100+) — now: `TerminalEditorProvider._instances.set(panel, provider)`
- `getActiveProvider()` static method (line ~120+) — walks `_instances` to find `panel.active === true`
- `getActiveTabId()` instance method (line ~135+) — returns root tab of active pane in this panel

### Pattern
```typescript
export class TerminalEditorProvider {
  private static readonly _instances = new Map<vscode.WebviewPanel, TerminalEditorProvider>();

  static getActiveProvider(): TerminalEditorProvider | undefined {
    for (const [panel, provider] of this._instances) {
      if (panel.active) {
        return provider;
      }
    }
    return undefined;
  }

  getActiveTabId(): string | undefined {
    return this.sessionManager.getTabsForView(this._viewId).find(t => t.isActive)?.id;
  }

  // In createPanel():
  const provider = new TerminalEditorProvider(...);
  this._instances.set(panel, provider);
  panel.onDidDispose(() => {
    this._instances.delete(panel);
  });
}
```

## When to apply
- Any VS Code provider (View or Editor) that needs to resolve 'which instance is active' for a host-side command
- Multi-panel editor scenarios where instances coexist
- Commands keyed off focus/active state rather than a fixed context argument

## Prevention gate
- When discarding a provider instance, ask: 'Do any commands need to resolve the active instance?' If yes, add a static registry
- Clean up in `onDidDispose` so closed panels don't leak
- Parallel `TerminalViewProvider.getLastFocusedProvider()` for the sidebar pattern — uses focus tracking instead of `active` flag

## Related pattern
`TerminalViewProvider.getLastFocusedProvider()` solves the same problem for multiple sidebar providers: track focus order across instances and return the most-recently-focused visible one. Both patterns (editor active panel, view focus tracking) are needed for a robust multi-view command resolver.

