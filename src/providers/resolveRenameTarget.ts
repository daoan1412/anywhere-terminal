// src/providers/resolveRenameTarget.ts — Tab id resolution for the rename
// command. See add-tab-rename design.md D5.
//
// Resolution chain:
//   1. Context-menu payload's `tabId` if present (and non-empty).
//   2. Active editor-area provider (`panel.active === true`) → its active root tab.
//   3. Most recently focused view provider (sidebar/panel) → its active root tab.
//   4. undefined (silent no-op).
//
// Extracted from the command callback for unit-testability — the function takes
// provider lookups as dependencies so tests can stub them.

/** Minimal shape any provider must expose for the rename command. */
export interface RenameTargetSource {
  getActiveTabId(): string | undefined;
}

export function resolveRenameTargetTabId(
  arg: { tabId?: string } | undefined,
  getActiveEditorProvider: () => RenameTargetSource | undefined,
  getLastFocusedViewProvider: () => RenameTargetSource | undefined,
): string | undefined {
  if (arg && typeof arg.tabId === "string" && arg.tabId.length > 0) {
    return arg.tabId;
  }
  const editor = getActiveEditorProvider();
  if (editor) {
    const tid = editor.getActiveTabId();
    if (tid) {
      return tid;
    }
  }
  const view = getLastFocusedViewProvider();
  if (view) {
    return view.getActiveTabId();
  }
  return undefined;
}
