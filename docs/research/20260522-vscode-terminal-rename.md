---
topic: vscode-terminal-rename
created-by: Research request for VS Code terminal rename implementation patterns
date: 2026-05-22
libraries: [vscode, xterm.js]
used-by: []
---

# Research: vscode-terminal-rename

## Answers

### 1) Inline edit DOM pattern
- `TerminalTabList` keeps row identity stable with `identityProvider.getId: e => e?.instanceId`, and rename state lives in `ITerminalEditingService`, not in the row model. `TerminalTabbedView.setEditable(false)` calls `refresh(false)`, which re-renders the list without canceling the edit; `renderElement()` re-checks `getEditableData(instance)` and reinserts the `<InputBox>` into the existing row template.
- File refs: `src/vs/workbench/contrib/terminal/browser/terminalTabsList.ts:103-110, 125-143, 427-433, 513-516`; `src/vs/workbench/contrib/terminal/browser/terminalTabbedView.ts:566-571`; `src/vs/workbench/contrib/terminal/browser/terminalEditingService.ts:27-36`.

```ts
const editableData = this._terminalEditingService.getEditableData(instance);
template.label.element.classList.toggle('editable-tab', !!editableData);
if (editableData) {
  template.elementDisposables.add(this._renderInputBox(
    template.label.element.querySelector('.monaco-icon-label-container')!,
    instance, editableData));
  template.actionBar.clear();
}
```

### 2) Focused-terminal resolution
- Resolution order for `TerminalService.activeInstance`: first any focused host terminal from `_hostActiveTerminals.values()` (`hasFocus` wins), then the last recorded `_activeInstance`. `setActiveInstance()` routes the selected terminal to `TerminalEditorService` if `target === Editor`, otherwise to `TerminalGroupService`, so the focused pane/editor terminal is disambiguated before rename runs.
- For rename specifically: `workbench.action.terminal.rename` uses `renameWithQuickPick()` on a URI/resource or the active instance; `workbench.action.terminal.renameActiveTab` uses selected tabs from `TerminalTabList` and, if invoked from the inline-tab menu with no selection, falls back to `terminalGroupService.activeInstance`.
- Split panes are renamed per-`ITerminalInstance`, not per group. In a split group the command targets the focused pane/selected pane(s); the group label is derived from member titles (`TerminalGroup.title` concatenates pane titles), so renaming one pane updates the visible group/tab label.
- File refs: `src/vs/workbench/contrib/terminal/browser/terminalService.ts:115-127, 351-380, 382-407`; `src/vs/workbench/contrib/terminal/browser/terminalActions.ts:1471-1504, 1738-1754, 762-817`; `src/vs/workbench/contrib/terminal/browser/terminalGroup.ts:334-354, 489-508`.

```ts
get activeInstance(): ITerminalInstance | undefined {
  for (const activeHostTerminal of this._hostActiveTerminals.values()) {
    if (activeHostTerminal?.hasFocus) {
      return activeHostTerminal;
    }
  }
  return this._activeInstance;
}
```

### 3) Persistence
- There is no dedicated “custom terminal title” storage key. `TerminalStorageKeys` only contains layout/buffer and tab UI keys; titles are persisted only indirectly through persistent-session machinery, not as a standalone setting.
- Workspace scope: persistent session layout state is written to `TerminalStorageKeys.TerminalLayoutInfo` in `StorageScope.WORKSPACE` with `StorageTarget.MACHINE` (local + remote backends both do this). Per-terminal identity in that layout is `persistentProcessId`, with `activePersistentProcessId` and each pane’s `terminal: persistentProcessId` used to restore the tab/split structure.
- `TerminalService._updateTitle()` pushes the current title to the backend only when persistent sessions are enabled and the instance has `persistentProcessId`; editor terminals also serialize `title` and `titleSource` in `TerminalInputSerializer`.
- GC/cleanup: `TerminalBufferState` and `TerminalLayoutInfo` are removed after revive (`remove(..., StorageScope.WORKSPACE)` in both backends). There is no separate title-entry GC because title is not stored in its own key; it is overwritten as part of the persistent revive/update flow.
- File refs: `src/vs/workbench/contrib/terminal/common/terminalStorageKeys.ts:6-17`; `src/vs/workbench/contrib/terminal/electron-browser/localTerminalBackend.ts:313-323, 325-361`; `src/vs/workbench/contrib/terminal/browser/remoteTerminalBackend.ts:145-152, 337-361`; `src/vs/workbench/contrib/terminal/browser/terminalService.ts:727-750`; `src/vs/workbench/contrib/terminal/browser/terminalEditorSerializer.ts:18-51`; `src/vs/platform/terminal/common/terminal.ts:169-223`.

```ts
async setTerminalLayoutInfo(layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
  const args: ISetTerminalLayoutInfoArgs = {
    workspaceId: this._getWorkspaceId(),
    tabs: layoutInfo ? layoutInfo.tabs : [],
    background: layoutInfo ? layoutInfo.background : null
  };
  await this._proxy.setTerminalLayoutInfo(args);
  this._storageService.store(TerminalStorageKeys.TerminalLayoutInfo, JSON.stringify(args), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}
```

### 4) F2 keybinding
- Yes. `RenameActiveTab` binds `F2` by default, with macOS overridden to `Enter`. The scoping `when` clause is `TerminalContextKeys.tabsFocus`, so it only fires when the terminal tabs strip has focus and does not shadow editor rename in text editors.
- File refs: `src/vs/workbench/contrib/terminal/browser/terminalActions.ts:762-780`.

```ts
keybinding: {
  primary: KeyCode.F2,
  mac: { primary: KeyCode.Enter },
  when: ContextKeyExpr.and(TerminalContextKeys.tabsFocus),
  weight: KeybindingWeight.WorkbenchContrib
},
```

### 5) Command label split
- It is not using `shortTitle` for rename. The command/action is registered once with `title: terminalStrings.rename` and the terminal action wrapper sets `category = terminalStrings.actionCategory` (`"Terminal"`), which is why the command palette shows `Terminal: Rename...`. Context menus supply their own label text per menu item, e.g. `Rename...` for the tab context menu.
- `MenuItemAction.label()` can render `shortTitle`, but rename does not define one here.
- File refs: `src/vs/workbench/contrib/terminal/browser/terminalActions.ts:145-151, 762-817`; `src/vs/workbench/contrib/terminal/browser/terminalMenus.ts:592-599, 675-681`; `src/vs/workbench/contrib/terminal/common/terminalStrings.ts:11-42`; `src/vs/platform/actions/common/actions.ts:554-560`.

```ts
export function registerTerminalAction(options: IAction2Options & ...) {
  options.f1 = options.f1 ?? true;
  options.category = options.category ?? category; // "Terminal"
  options.precondition = options.precondition ?? TerminalContextKeys.processSupported;
}
```

### 6) Quick-pick vs inline edit
- They are separate UI paths, not one handler. `workbench.action.terminal.rename` opens a quick input (`renameWithQuickPick()`), while `RenameActiveTab` uses the inline editing service (`setEditable(...)`) to place an `InputBox` in the tab row.
- They converge on the same underlying instance API (`instance.rename(...)`), and the inline-tab menu can deliberately redirect to quick-pick (`lastAccessedMenu === 'inline-tab'`).
- File refs: `src/vs/workbench/contrib/terminal/browser/terminalActions.ts:762-817, 1738-1754`.

### 7) Reset path
- Inline rename supports reset-to-default by submitting empty text: `validateTerminalName()` returns an info message (“Providing no name will reset it to the default value”), and `instance.rename('')` causes `_setTitle()` to fall back to `_processName`.
- The quick-pick path does **not** reset on empty input because it only calls `instance.rename(title)` when `title` is truthy.
- File refs: `src/vs/workbench/contrib/terminal/browser/terminalActions.ts:797, 1506-1514, 1747-1754`; `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts:2331-2345, 2056-2080`.

```ts
async rename(title?: string, source?: TitleEventSource) {
  this._setTitle(title, source ?? TitleEventSource.Api);
}

private _setTitle(title: string | undefined, eventSource: TitleEventSource): void {
  const reset = !title;
  title = this._updateTitleProperties(title, eventSource);
  ...
}
```

## Recommended Approach
- For your webview/xterm tab strip, keep row identity stable with an ID-based list identity provider and store edit state outside row data; rerender the row template and rehydrate the inline input from editing state.
- Treat rename as an instance-level operation, not a group-level one; for split panes, rename the focused pane and derive the group label from the member instances.
- If you want persistence, store the custom title with your session/instance identity key and explicitly clear it on reset; don’t rely on a generic title config to act as user override storage.

## Gotchas & Constraints
- VS Code does not expose a dedicated “reset title” command; reset is by empty inline input, not by quick-pick.
- The context menu label and command palette label are intentionally different; if you mimic this, keep the action title/category separate from the menu item title.
- Persistent title restoration in VS Code is tied to persistent sessions; closed/non-persistent terminals do not get a separate title record.

## Confidence
- High — confirmed via direct source reads across terminal list rendering, focus resolution, action registration, storage, and persistent-session code paths.
