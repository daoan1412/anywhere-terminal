---
topic: explorer-auto-reveal
created-by: research for anywhere-terminal auto-reveal active editor file design
date: 2026-05-23
libraries: [vscode]
used-by: []
---

# Research: explorer-auto-reveal

## Answers

1. **Setting values**
   - Canonical values are `true`, `false`, and `"focusNoScroll"`.
   - VS Code’s settings schema defines `explorer.autoReveal` as `boolean | string` with `enum: [true, false, 'focusNoScroll']`.
   - UX difference:
     - `true`: reveal, select, and scroll the file into view.
     - `false`: do not reveal or select the file.
     - `focusNoScroll`: select/focus the file, but do not scroll it into view.
   - Default is `true`.

2. **`explorer.autoRevealExclude`**
   - Purpose: exclude paths/globs from auto-reveal so opening those files does not jump the Explorer to them.
   - Default value:
     ```json
     {
       "**/node_modules": true,
       "**/bower_components": true
     }
     ```
   - It accepts glob keys relative to the workspace folder, plus optional `when` clauses for sibling-based matching.
   - Common use cases: dependency folders, generated/vendor directories, giant build outputs, or any tree region that is noisy and should not steal focus.

3. **Edge cases / known issues**
   - **Selection steals context from tree interactions**: opening a file can cause context menu actions in the Explorer to target the wrong item because auto-reveal reselects the active file (#219585).
   - **`false` / `focusNoScroll` are not always respected consistently**: users report cases where VS Code still scrolls or reveals after restart or when reopening the Explorer (#285587, #260306).
   - **Navigation from terminal/path actions can conflict with auto-reveal**: clicking a path or folder can jump to an unrelated active file instead of the intended target (#176570).
   - **Multi-window / auxiliary window confusion**: in secondary windows, auto-reveal can jump to a file from the primary window or wrong workspace folder (#200452).
   - **Users want a more explicit “active only” mode**: there is recurring demand for a setting that reveals only on explicit selection, not on mere tab activation (#237710, #224071, #175690).

4. **UX best practices from other tree-with-reveal implementations**
   - **IntelliJ** splits the behavior into two independent toggles: “Autoscroll from Source / Always Select Opened File” and “Autoscroll to Source.” This separation is a strong pattern for reducing surprise and giving keyboard users finer control.
   - **Nova** exposes three modes: reveal-and-scroll, reveal-without-scroll, and do-nothing. This mirrors VS Code’s current `true` / `focusNoScroll` / `false` trio very closely.
   - **Sublime Text** is more conservative by default: auto-sync is commonly delivered by a plugin, and those plugins often pause syncing when the sidebar is hidden or ignore user-defined patterns. That suggests a “sticky while browsing elsewhere” model can be less disruptive.

5. **Performance considerations**
   - There is no public VS Code guideline that says “debounce auto-reveal by X ms.”
   - Real-world VS Code code uses a wide range of debounces for editor-driven reactions: ~75 ms, 100 ms, 200 ms, 500 ms, and 1000 ms depending on workload.
   - For a custom tree auto-reveal, a **short debounce in the ~75–150 ms range** is a good starting point for active-editor churn, with coalescing of duplicate URIs and suppression during rapid tab thrash.
   - If reveal triggers DOM scrolling or tree expansion work, keep it idempotent and skip work when the same URI is already visible/selected.

6. **API recommendations**
   - `window.activeTextEditor` + `window.onDidChangeActiveTextEditor` is still the right API when you only care about traditional text editors.
   - For a robust solution across text editors, diff editors, notebooks, custom editors, and webviews, `window.tabGroups.activeTabGroup.activeTab` is the better source of truth, with `onDidChangeTabs` and/or `onDidChangeTabGroups` for change detection.
   - Recommended pattern for this feature:
     - Prefer `activeTextEditor.document.uri` when available.
     - Fall back to the active tab input when `activeTextEditor` is absent.
     - Only reveal when you can map the active resource to a tree item in the workspace.

7. **Custom editors / non-file URIs**
   - Do **not** try to auto-reveal arbitrary non-workspace resources such as `untitled:` or custom editor/webview-only content.
   - VS Code’s built-in Explorer only reveals resources that belong to the workspace file tree; non-workspace resources fall back to Open Editors behavior instead of Explorer reveal.
   - For remote workspaces, rely on workspace membership / resolvability, not URI scheme alone.
   - Practical rule: reveal only when the active resource is a workspace-backed file that your tree can actually represent.

## Recommended Approach

- Implement auto-reveal as a **workspace-backed, resource-aware sync** rather than a blind “active editor always scrolls tree” feature.
- Default to a **three-state preference** matching VS Code (`true`, `false`, `focusNoScroll`) and preserve `focusNoScroll` as the low-disruption middle ground.
- Add an exclude matcher early in the reveal pipeline so noisy folders never steal focus, and make sure manual reveal can still override it if you need that UX.

## UX Guidance for anywhere-terminal

- Treat auto-reveal as a **follow mode**, not a hard synchronization guarantee.
- If the user is clearly browsing elsewhere in the tree, avoid yanking the viewport unless the active item changes due to an explicit selection action.
- Keep selection separate from scrolling internally if possible; that makes it easier to reproduce VS Code’s `focusNoScroll` behavior and to support future “reveal without select” variants.
- Prefer “sticky unless explicitly changed” behavior over “always chase the editor,” especially in a custom webview tree where jumps are more visually disruptive than in the native Explorer.

## Gotchas & Constraints

- `explorer.autoRevealExclude` is pattern-based, not semantic: it will not magically know about generated code or “important” folders unless you encode that in glob rules.
- `focusNoScroll` still changes selection/focus, so context menu actions and keyboard operations will follow the revealed item even though the viewport does not move.
- If your tree is virtualized, ensure reveal can target offscreen rows without rebuilding the whole tree on every editor change.
- If the active editor changes rapidly, a naive implementation can cause scroll jitter, selection flicker, and repeated expand/collapse work.

## Gaps

- I did not find an official VS Code document that prescribes a specific debounce interval for auto-reveal.
- I did not find a canonical, first-party “best practice” document comparing VS Code directly to Sublime/IntelliJ/Nova; those patterns were inferred from their public UX/docs and plugin behavior.
- The built-in Explorer’s handling of every non-text tab type is not exhaustively documented publicly; the safest rule is still to reveal only workspace-backed file resources.

## Sources

- VS Code settings schema: `src/vs/workbench/contrib/files/browser/files.contribution.ts`
- VS Code Explorer service/view: `src/vs/workbench/contrib/files/browser/explorerService.ts`, `src/vs/workbench/contrib/files/browser/views/explorerView.ts`
- VS Code file explorer docs and release notes:
  - [VS Code 1.46 release notes](https://code.visualstudio.com/updates/v1_46)
  - [VS Code 1.74 release notes](https://code.visualstudio.com/updates/v1_74)
- GitHub issues:
  - [#219585 Wrong explorer right-click actions caused by `explorer.autoReveal`](https://github.com/microsoft/vscode/issues/219585)
  - [#260306 explorer.autoReveal not working](https://github.com/microsoft/vscode/issues/260306)
  - [#285587 explorer.autoReveal false and focusNoScroll is broken](https://github.com/microsoft/vscode/issues/285587)
  - [#176570 Can't navigate to directory from path in terminal when explorer.autoReveal is true](https://github.com/microsoft/vscode/issues/176570)
  - [#200452 Aux window workspace file explorer selects wrong file](https://github.com/microsoft/vscode/issues/200452)
  - [#175690 Separate explorer.autoReveal into 2 options](https://github.com/microsoft/vscode/issues/175690)
  - [#237710 autoReveal, but only when a file is explicitly selected](https://github.com/microsoft/vscode/issues/237710)
  - [#224071 autoReveal focus on acitvate](https://github.com/microsoft/vscode/issues/224071)
- Comparison implementations:
  - IntelliJ project view autoscroll behavior (public JetBrains support docs)
  - Nova Files Sidebar docs: [Files Sidebar](https://help.panic.com/nova/files-sidebar/) and [The Workspace](https://help.panic.com/nova/sidebar/)
  - Sublime Text synced sidebar plugin behavior: [SyncedSideBar](https://github.com/TheSpyder/SyncedSideBar)
- VS Code API usage examples from public code:
  - `window.activeTextEditor` / `onDidChangeActiveTextEditor`
  - `window.tabGroups.activeTabGroup.activeTab`
