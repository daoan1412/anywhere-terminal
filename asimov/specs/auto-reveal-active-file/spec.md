# auto-reveal-active-file Specification
## Requirements

### Requirement: Auto-reveal setting schema

The extension SHALL declare two new keys under `contributes.configuration.properties` in `package.json`:

- `anywhereTerminal.fileTree.autoReveal`: JSON-schema union of boolean + enum string, expressed as `"type": ["boolean", "string"]` with `"enum": [true, false, "focusNoScroll"]`, default `true`. Description: "When enabled, the file tree highlights the file currently focused in the editor. Use 'focusNoScroll' to select without scrolling."
- `anywhereTerminal.fileTree.autoRevealExclude`: type `object` (glob expression — keys are glob patterns, values are `true` or `false`), default `{ "**/node_modules": true, "**/bower_components": true }`. Description: "Glob patterns whose matching files (or any ancestor folder) are excluded from auto-reveal." `when`-condition objects MAY be present in the user's config but are NOT honored in v1 (treated as plain `true` when the value is truthy).

### Requirement: Active-editor reveal trigger

The extension host SHALL register listeners on both `vscode.window.tabGroups.onDidChangeTabs` AND `vscode.window.tabGroups.onDidChangeTabGroups` (VS Code 1.105 does NOT expose a dedicated `onDidChangeActiveTab` event — the reliable signal is reading `vscode.window.tabGroups.activeTabGroup.activeTab` after either event fires). After a 100 ms debounce, the resolver SHALL read the current `activeTabGroup.activeTab`, resolve its input to an absolute file path, and, when all gates pass (see below), post a `RevealInFileTreeMessage` with `source: "autoReveal"` to every active webview.

#### Scenario: Rapid tab cycling coalesces to one reveal

- **WHEN** the user switches active tabs five times within 100 ms
- **THEN** exactly one `RevealInFileTreeMessage` SHALL be posted, carrying the final tab's path

### Requirement: Active-tab path resolution

The active-tab resolver SHALL extract a `file:`-scheme URI from `tab.input` when it is one of: `vscode.TabInputText`, `vscode.TabInputCustom`, `vscode.TabInputNotebook`. For any other input type (including `TabInputTextDiff`, `TabInputNotebookDiff`, `TabInputTerminal`, `TabInputWebview`) or for a non-`file:` URI scheme, the resolver SHALL skip reveal silently. Diff inputs are excluded because they represent review surface rather than the file the user is editing.

### Requirement: Workspace-root membership check

The resolver SHALL drop the reveal silently when the resolved absolute path is not contained inside the FIRST workspace folder (`vscode.workspace.workspaceFolders?.[0]`). Multi-workspace-folder behavior is OUT OF SCOPE for v1 because the file tree itself only roots at the first folder (see `FileTreeHost.workspaceRoot`). Containment is checked by `path.relative(root, file)` returning a value that does NOT start with `..` and is NOT an absolute path.

### Requirement: Exclude glob evaluation with ancestor walk

When `anywhereTerminal.fileTree.autoRevealExclude` contains any pattern that matches the workspace-relative path OR any of its ancestor folder paths, the reveal SHALL be skipped silently.

Path inputs to the matcher SHALL be normalized:

- Computed as `path.relative(workspaceRoot, absPath)`
- Path separators converted to forward-slash `/` (Windows `\` → `/`)
- Compared case-insensitively on `process.platform === 'win32'` and `darwin` (HFS+/APFS default case-insensitive), case-sensitively on Linux

Matching SHALL use `minimatch` with options `{ dot: true, nocase: <derived from platform>, matchBase: false }`.

#### Scenario: Excluded ancestor blocks reveal

- **WHEN** the active file is `node_modules/foo/bar.ts` and exclude contains `**/node_modules`
- **THEN** the resolver SHALL NOT post a reveal message (because the ancestor segment `node_modules` matches)

#### Scenario: Structurally-invalid pattern is dropped, others still apply

- **WHEN** the exclude object contains `{ "": true, "**/node_modules": true }` (or any other pattern whose `Minimatch.makeRe()` returns `false`)
- **THEN** the invalid pattern SHALL be logged once at warn level and dropped; `**/node_modules` SHALL still match. (Note: `minimatch` v10 is intentionally lenient about glob syntax — patterns like `[unclosed` are treated as literal strings rather than rejected. Only patterns that fail to compile to a regex are dropped here.)

### Requirement: focusNoScroll variant

The `RevealInFileTreeMessage` payload SHALL be extended additively with an optional `focusNoScroll?: boolean` field. The host SHALL set `focusNoScroll: true` when the resolved `autoReveal` mode is `"focusNoScroll"`. The webview `FileTreePanel.revealPath(absPath, options)` SHALL accept `options?: { focusNoScroll?: boolean; source?: 'osc7' | 'autoReveal' }`; when `focusNoScroll` is true, the panel SHALL expand all ancestor folders and call `Tree<T>.setSelection(node)` + `Tree<T>.domFocus()` but SHALL NOT call `Tree<T>.revealElement(node)` (no scroll).

### Requirement: Auto-reveal centers the row in the viewport

When `FileTreePanel.revealPath` scrolls a row into view for an auto-reveal call (`opts.source === 'autoReveal'`) AND `focusNoScroll` is NOT set, the panel SHALL anchor the row at the vertical center of the viewport (relativeTop ≈ 0.5). This matches VS Code's explorer auto-reveal and prevents the row from landing at the top or bottom edge.

For OSC 7 calls (`source === 'osc7'` or omitted) the panel SHALL keep the underlying list widget's minimum-scroll behavior — existing right-click reveal UX is unchanged. `Tree<T>.revealElement` SHALL accept an optional `relativeTop?: number` argument that maps to the vendored `list.reveal(index, relativeTop)` contract (`0` = top, `0.5` = center, `1` = bottom; omitted = minimum-scroll).

### Requirement: Panel-hidden behavior is webview-gated

The webview `FileTreePanel.revealPath` SHALL accept the call and short-circuit (no-op silently, NOT open the panel) when `options.source === "autoReveal"` AND `this.open === false`. For `source === "osc7"` (or omitted, matching today's call sites), the existing behavior of opening the panel before revealing SHALL be preserved.

The host SHALL NOT track panel-open state — gating lives where the state already lives, in the webview.

### Requirement: Reveal message contract extension

The `RevealInFileTreeMessage` interface SHALL be extended additively with:

- `absPath?: string` — when present, the controller SHALL use it directly and SKIP the existing `sessionId → instanceCwd → workspaceRoot` resolution chain
- `focusNoScroll?: boolean` — see [focusNoScroll variant]
- `source?: 'osc7' | 'autoReveal'` — discriminator the webview uses for panel-hidden gating

`sessionId` SHALL become optional (`sessionId?: string`). The auto-reveal path SHALL set `absPath` and OMIT `sessionId`; the existing OSC 7 path SHALL continue to set `sessionId` and OMIT `absPath` — both contracts remain valid.

`FileTreeController.handleReveal` SHALL branch: if `msg.absPath` is present, call `panel.revealPath(msg.absPath, { focusNoScroll: msg.focusNoScroll, source: msg.source })`; otherwise run the existing cwd-resolution path unchanged.

### Requirement: Settings live-reload

The extension host SHALL listen for `workspace.onDidChangeConfiguration` and:

- Rebuild the in-memory cache of `minimatch` instances when `anywhereTerminal.fileTree.autoRevealExclude` changes
- Re-read the `autoReveal` mode synchronously inside the resolver (after the debounce, before posting), so a setting toggled during the debounce window takes effect immediately

No window reload SHALL be required.

### Requirement: Disabled state

When the resolved `autoReveal` mode is `"none"` (corresponding to user-configured `false`/`"false"`), the resolver SHALL return early before computing the path. The `onDidChangeActiveTab` subscription SHALL remain registered for the lifetime of the host — the early-return cost is negligible.

