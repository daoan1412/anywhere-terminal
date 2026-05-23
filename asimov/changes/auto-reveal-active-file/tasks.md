## 1. Schema & contracts

- [x] 1_1 Declare auto-reveal settings in `package.json`
  - **Deps**: none
  - **Refs**: specs/auto-reveal-active-file/spec.md#requirement-auto-reveal-setting-schema; design.md D1
  - **Scope**: package.json
  - **Acceptance**:
    - Outcome: `package.json` contains both new keys under `contributes.configuration.properties`. Opening VS Code Settings UI, searching "anywhereTerminal.fileTree" shows both with their descriptions and correct defaults. The `autoReveal` field is declared as a boolean+string union with `enum: [true, false, "focusNoScroll"]`, default `true`.
    - Verify: manual — open Settings UI, search "anywhereTerminal.fileTree", confirm both settings appear with defaults
  - **Plan**:
    1. Under `contributes.configuration.properties`, add `anywhereTerminal.fileTree.autoReveal` (`"type": ["boolean", "string"], "enum": [true, false, "focusNoScroll"], "default": true`, with description) and `anywhereTerminal.fileTree.autoRevealExclude` (`"type": "object", "additionalProperties": { "type": "boolean" }`, default `{ "**/node_modules": true, "**/bower_components": true }`, with description).

- [x] 1_2 Widen `RevealInFileTreeMessage` additively (the contract change)
  - **Deps**: none
  - **Refs**: specs/auto-reveal-active-file/spec.md#requirement-reveal-message-contract-extension, requirement-focusnoscroll-variant; design.md D1 (Interfaces section)
  - **Scope**: src/types/messages.ts
  - **Acceptance**:
    - Outcome: `RevealInFileTreeMessage` is `{ type, sessionId?, cwd?, absPath?, focusNoScroll?, source? }`. `sessionId` and `cwd` become optional (no longer required). TS compiles; existing OSC 7 callers that pass `sessionId` + `cwd` still type-check unchanged.
    - Verify: manual — run `pnpm run check-types` and confirm zero errors; grep `git diff` for the existing OSC 7 caller (search `"reveal-in-file-tree"`) and confirm no call sites need edits
  - **Plan**:
    1. Edit the `RevealInFileTreeMessage` interface at `src/types/messages.ts:569-573`: change `sessionId: string` → `sessionId?: string`; `cwd: string | null` → `cwd?: string | null`; add `absPath?: string`, `focusNoScroll?: boolean`, `source?: 'osc7' | 'autoReveal'`. Update the JSDoc to note the two valid shapes (OSC 7: `sessionId+cwd`; auto-reveal: `absPath`).

- [x] 1_3 Add `FileTreeSettingsReader` module
  - **Deps**: 1_1
  - **Refs**: specs/auto-reveal-active-file/spec.md#requirement-disabled-state, requirement-settings-live-reload; design.md D7
  - **Scope**: src/settings/FileTreeSettingsReader.ts (new file)
  - **Acceptance**:
    - Outcome: `readFileTreeSettings()` returns `{ mode: 'reveal' | 'none' | 'focusNoScroll', excludePatterns: ReadonlyArray<string> }`. Normalizes `true`/`"true"` → `'reveal'`; `false`/`"false"` → `'none'`; `"focusNoScroll"` → `'focusNoScroll'`; missing or invalid → `'reveal'` (default). Exclude object: keep keys whose value is truthy.
    - Verify: unit src/settings/__tests__/FileTreeSettingsReader.test.ts (cases: default missing → `reveal`+default excludes; boolean true → reveal; boolean false → none; string "focusNoScroll" → focusNoScroll; custom exclude object kept)
  - **Plan**:
    1. Create file. Export `type AutoRevealMode = 'reveal' | 'none' | 'focusNoScroll'`, `interface FileTreeAutoRevealConfig { mode, excludePatterns }`, `function readFileTreeSettings(): FileTreeAutoRevealConfig`.
    2. Read via `vscode.workspace.getConfiguration('anywhereTerminal.fileTree')`. Use `.get<boolean | string>('autoReveal', true)` and normalize.
    3. Read `.get<Record<string, unknown>>('autoRevealExclude', defaults)`; keep keys with truthy value; log a one-time warn (use a module-level boolean) if any value is a non-boolean object (the `when` condition shape we don't honor in v1).

## 2. Webview plumbing

- [x] 2_1 Plumb `absPath`/`focusNoScroll`/`source` through `MessageRouter → FileTreeController → FileTreePanel.revealPath` with webview-side panel-hidden gating
  - **Deps**: 1_2
  - **Refs**: specs/auto-reveal-active-file/spec.md#requirement-focusnoscroll-variant, requirement-panel-hidden-behavior-is-webview-gated, requirement-reveal-message-contract-extension; design.md D1 D5
  - **Scope**: src/webview/messaging/MessageRouter.ts, src/webview/fileTree/FileTreeController.ts, src/webview/fileTree/FileTreePanel.ts
  - **Acceptance**:
    - Outcome: When a `RevealInFileTreeMessage` arrives with `absPath`, the controller bypasses cwd resolution and calls `panel.revealPath(msg.absPath, { focusNoScroll, source })`. When `source === 'autoReveal'` AND `panel.open === false`, `revealPath` no-ops silently (no open, no scroll). When `focusNoScroll === true`, the panel expands ancestors + calls `setSelection` + `domFocus` but does NOT call `revealElement` (no scroll). All existing OSC 7 behavior preserved bit-for-bit (no `absPath`, no `source` → old code path runs).
    - Verify: manual — (a) trigger reveal via OSC 7 (terminal pane right-click "Reveal in File Tree") and confirm tree still opens and scrolls as before; (b) construct an `absPath`-only message via devtools to confirm new path works
  - **Plan**:
    1. `MessageRouter.ts` (line ~155): in the dispatch for `"reveal-in-file-tree"`, pass the full message (or all four new optional fields) to `onRevealInFileTree`. Keep handler signature: `onRevealInFileTree(msg: RevealInFileTreeMessage)`.
    2. `FileTreeController.handleReveal` (line ~157-168): add an early branch — `if (msg.absPath) { return this.panel.revealPath(msg.absPath, { focusNoScroll: msg.focusNoScroll, source: msg.source }); }` — leave the existing cwd-resolution block untouched after that guard.
    3. `FileTreePanel.revealPath` (line ~206-264): change signature to `revealPath(absPath: string, opts?: { focusNoScroll?: boolean; source?: 'osc7' | 'autoReveal' }): Promise<void>`. At the very top, add `if (opts?.source === 'autoReveal' && !this.open) return;`. Keep the existing `if (!this.open) this.setOpen(true);` block for the OSC 7 path. In the two `tree.revealElement(...)` call sites (out-of-root branch ~L223; in-root branch ~L261), branch on `opts?.focusNoScroll` — skip the `revealElement` call when true; keep `setSelection` + `domFocus` calls.

## 3. Extension host service

- [x] 3_1 Add `minimatch` as a direct npm dependency (no `@types/minimatch`)
  - **Deps**: none
  - **Refs**: design.md D4
  - **Scope**: package.json, pnpm-lock.yaml
  - **Acceptance**:
    - Outcome: `import { minimatch, Minimatch } from 'minimatch'` resolves with bundled types. `pnpm install && pnpm run check-types` succeeds.
    - Verify: manual — run `pnpm install && pnpm run check-types`; confirm `minimatch` appears under `dependencies` (not `devDependencies`) and that the imported symbols type-check without `@types/minimatch`
  - **Plan**:
    1. `pnpm add minimatch` (current major ships its own types). If types are missing for some reason, add `pnpm add -D @types/minimatch` and document why in the commit message — but expect this NOT to be needed.

- [x] 3_2 Implement `ActiveFileRevealer` class with debounce, gates, ancestor-aware exclude, path normalization
  - **Deps**: 1_2, 1_3, 3_1
  - **Refs**: specs/auto-reveal-active-file/spec.md#requirement-active-editor-reveal-trigger, requirement-active-tab-path-resolution, requirement-workspace-root-membership-check, requirement-exclude-glob-evaluation-with-ancestor-walk, requirement-settings-live-reload; design.md D2 D3 D6 D8
  - **Scope**: src/providers/ActiveFileRevealer.ts (new file)
  - **Acceptance**:
    - Outcome: A class implementing `vscode.Disposable`. Constructor `(workspaceRoot: () => string | null, post: (msg: RevealInFileTreeMessage) => void, readSettings?: () => FileTreeAutoRevealConfig)`. Subscribes to BOTH `window.tabGroups.onDidChangeTabs` AND `onDidChangeTabGroups` (VS Code 1.105 has no dedicated `onDidChangeActiveTab`). On either event: schedule single 100 ms `setTimeout`. `flush()`: (a) re-read settings, return if `mode === 'none'`; (b) read `window.tabGroups.activeTabGroup.activeTab`, return if undefined; (c) extract `file:` URI from `TabInputText` | `TabInputCustom` | `TabInputNotebook`, otherwise return; (d) resolve workspaceRoot, return if null; (e) compute relative path via `path.relative(root, fsPath)`, return if `startsWith('..')` or `path.isAbsolute(rel)`; (f) normalize separators to `/`, build ancestor candidates, test each against cached `Minimatch` instances (case rule from D8); return if any matches; (g) `post({ type: 'reveal-in-file-tree', absPath: fsPath, focusNoScroll: mode === 'focusNoScroll', source: 'autoReveal' })`. On `onDidChangeConfiguration` filtered to `anywhereTerminal.fileTree.autoRevealExclude`: rebuild `Minimatch` cache. `dispose()` clears timer + disposes all three subscriptions.
    - Verify: unit src/providers/__tests__/ActiveFileRevealer.test.ts (cases: rapid burst → single post after debounce; mode='none' → no post; non-file URI → no post; outside first workspace root → no post; ancestor exclude matches → no post; focusNoScroll mode → post with focusNoScroll:true; Windows-shape backslash path → normalized to `/` before match)
  - **Plan**:
    1. Create file with class skeleton + the three constructor params above.
    2. Implement extraction helper `extractFileUri(input: unknown): vscode.Uri | null` using `instanceof vscode.TabInputText | TabInputCustom | TabInputNotebook` and `.uri.scheme === 'file'` check.
    3. Implement matcher cache `Map<string, Minimatch>`; build with `new Minimatch(p, { dot: true, nocase: process.platform !== 'linux' })`; wrap construction in try/catch; track invalid patterns in a `Set<string>` so each is logged only once.
    4. Implement `matchesExclude(relPosix: string): boolean` building ancestor list (D8 algorithm) and testing each candidate against each cached matcher.
    5. Wire `onDidChangeActiveTab`: clear pending timer, set new 100ms timer that calls private `flush(tab)`.
    6. Wire `onDidChangeConfiguration`: if `e.affectsConfiguration('anywhereTerminal.fileTree.autoRevealExclude')`, rebuild matcher cache from `settings().excludePatterns`.
    7. `dispose()`: clear timer, dispose both subscriptions, clear matcher cache.

- [x] 3_3 Construct `ActiveFileRevealer` inside `FileTreeHost.attach()` (or alongside it)
  - **Deps**: 3_2
  - **Refs**: design.md D6
  - **Scope**: src/providers/fileTreeHost.ts
  - **Acceptance**:
    - Outcome: For each AnyWhere Terminal webview, an `ActiveFileRevealer` is created when the host attaches and disposed in the same `Disposable` chain. Auto-reveal works end-to-end: opening the file tree, switching editor tabs → tree row gets selected and scrolled.
    - Verify: manual — open extension dev host (F5), open the file tree panel, switch between two open editor files; observe the active file's row becomes selected and the tree scrolls to it
  - **Plan**:
    1. Extend `FileTreeHost.attach(deps)` to accept a third callback `settings: () => FileTreeAutoRevealConfig` (or read it lazily from `readFileTreeSettings`).
    2. Inside `attach`, after registering the workspace-folder subscription, instantiate `new ActiveFileRevealer(() => this.workspaceRoot, readFileTreeSettings, deps.post)`.
    3. Return a combined `vscode.Disposable.from(workspaceFolderSub, revealer)` so the caller's existing single-`push(disposable)` pattern still works.
    4. No changes to the provider call sites except — if needed — passing `readFileTreeSettings` through `attach()` deps; prefer direct import from inside `ActiveFileRevealer` to avoid widening the `attach` signature.

## 4. Verification

- [x] 4_1 Unit-test the ancestor-aware exclude matcher (extracted as pure function)
  - **Deps**: 3_2
  - **Refs**: specs/auto-reveal-active-file/spec.md#requirement-exclude-glob-evaluation-with-ancestor-walk; design.md D8
  - **Scope**: src/providers/ActiveFileRevealer.ts (extract `matchesExclude` to an exported helper), src/providers/__tests__/ActiveFileRevealer.test.ts
  - **Acceptance**:
    - Outcome: Pure helper `matchesExclude(relPosix: string, matchers: ReadonlyArray<Minimatch>): boolean` is exported. Test cases pass: (a) `node_modules/foo/bar.ts` with `**/node_modules` → true; (b) `src/foo.ts` with `**/node_modules` → false; (c) `.git/HEAD` with `**/.git` (dot:true) → true; (d) malformed `[unclosed` pattern produces no Minimatch (caller drops); test simulates this by passing only the valid matchers; (e) Windows path normalized: input is already POSIX (the caller's responsibility), test asserts the helper treats `\` as literal.
    - Verify: unit src/providers/__tests__/ActiveFileRevealer.test.ts (the matcher cases above)
  - **Plan**:
    1. Promote `matchesExclude` from a private method to an exported standalone function in the same file. Internal helper stays internal; only the matcher is testable in isolation.
    2. Write Vitest cases above. No vscode-api mocks needed for the matcher itself.

- [ ] 4_2 Manual smoke verification
  - **Deps**: 1_1, 2_1, 3_3
  - **Refs**: proposal.md (UI Impact section)
  - **Scope**: none (verification-only)
  - **Acceptance**:
    - Outcome: Manual checklist passes in extension dev host:
      1. With default settings, opening a workspace file expands ancestors and selects the row.
      2. Setting `autoReveal` to `"focusNoScroll"`: row is selected but the tree does NOT scroll.
      3. Setting `autoReveal` to `false`: no reveal occurs on tab switches.
      4. Opening a file inside `node_modules/`: no reveal (default exclude).
      5. Adding `"**/dist": true` to exclude and opening `dist/foo.js`: no reveal (live-reload works).
      6. Tab-cycling rapidly (Cmd+Opt+Right ×5): only the final file is revealed (debounce).
      7. Closing the file tree panel and switching tabs: no error in console; reopening the panel does NOT auto-jump to the latest tab (panel-hidden gate is honored).
      8. Opening an image (custom editor): no error; reveal happens because `tab.input` is `TabInputCustom` with `file:` scheme.
      9. Opening an untitled file or diff (`Cmd+\` to compare with another file): no reveal, no console error.
      10. OSC 7 reveal still works (terminal pane right-click "Reveal in File Tree" still opens panel and scrolls).
    - Verify: manual — run through the 10-step checklist; record pass/fail in workflow.md Revision Log
  - **Plan**:
    1. `pnpm run check-types && pnpm run lint`; launch extension dev host; perform the 10 checks above.
