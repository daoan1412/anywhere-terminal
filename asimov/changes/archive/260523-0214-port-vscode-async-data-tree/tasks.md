## 1. Vendor list widget + build plumbing

- [x] 1_1 Add `vs/*` path alias to tsconfig + esbuild + vitest + biome
  - **Deps**: none
  - **Refs**: design.md D2; specs/vscode-list-widget-vendor/spec.md#requirement-path-alias-for-vendored-imports; specs/vscode-list-widget-vendor/spec.md#requirement-biome-ignores-vendored-sources
  - **Scope**: `tsconfig.json`, `esbuild.js`, `vitest.config.mts`, `biome.json`
  - **Acceptance**:
    - Outcome: `import {} from 'vs/base/common/lifecycle'` resolves to `src/vendor/vscode/base/common/lifecycle.ts` in ALL of: type-check, bundle, and vitest unit-test runs. `pnpm run lint` does NOT touch or warn about files under `src/vendor/**`.
    - Verify: manual `pnpm run check-types && node esbuild.js --production && pnpm run test:unit && pnpm run lint` all succeed with a stub `src/vendor/vscode/base/common/lifecycle.ts` (`export {};`), a stub test importing it, and the stub file containing no Biome-conformant formatting.
  - **Plan**:
    1. Add `"paths": { "vs/*": ["./src/vendor/vscode/*"] }` to `tsconfig.json` `compilerOptions`.
    2. Add `alias: { vs: path.resolve(__dirname, 'src/vendor/vscode') }` to BOTH the dev and prod webview build blocks in `esbuild.js`.
    3. Extend `vitest.config.mts` `test.alias` to include `vs: path.resolve(__dirname, 'src/vendor/vscode')`.
    4. Extend `biome.json` `files.includes` to include `"!src/vendor/**"`.
    5. Create stub `src/vendor/vscode/base/common/lifecycle.ts` (deliberately not Biome-formatted, to verify the exclude works) and a stub `src/test/vendor-import-stub.test.ts` that imports it. Run all four commands; revert the stub test after verifying.

- [x] 1_1b Tsconfig flags + vendored typings for upstream compatibility *(retroactive — discovered during 1_2)*
  - **Deps**: 1_1
  - **Refs**: Wave 2 surprise — upstream `vs/` sources require flags our tsconfig didn't have; see workflow.md Revision Log 2026-05-22 Wave 2.
  - **Scope**: `tsconfig.json`, `src/vendor/vscode/typings/**` (NEW)
  - **Acceptance**:
    - Outcome: `tsconfig.json` adds `experimentalDecorators: true`, `useUnknownInCatchVariables: false`, and `DOM.Iterable` to `lib`. `src/vendor/vscode/typings/` contains 3 upstream-vendored ambient `.d.ts` files (`vscode-globals-product.d.ts`, `vscode-globals-ttp.d.ts`, `editContext.d.ts` — MS copyright preserved) + 2 our-own stubs (`base-common-stub.d.ts` for `Timeout`/`IdleDeadline` without the upstream phantom-typed `TimeoutHandle` that collides with `@types/node`; `trusted-types-stub.d.ts` for `TrustedTypePolicy(Options)`). `pnpm run check-types` is clean.
    - Verify: manual `pnpm run check-types`.
  - **Plan**:
    1. Vendor 3 upstream typings byte-for-byte from `/Users/huybuidac/Projects/ai-oss/vscode/src/typings/`.
    2. Write the 2 stubs.
    3. Amend tsconfig with the 3 flags.

- [x] 1_2 Vendor `vs/base/browser/ui/list/` + minimum transitive deps with MANIFEST
  - **Deps**: 1_1
  - **Refs**: design.md D1, D9; design.md § Target Layout; specs/vscode-list-widget-vendor/spec.md#requirement-vendored-vs-code-list-widget; specs/vscode-list-widget-vendor/spec.md#requirement-vendor-manifest
  - **Scope**: `scripts/vendor-vscode-list.mjs` (NEW vendoring tool), `src/vendor/vscode/**/*.ts` (NEW directory tree; expected ~40-60 files), `src/vendor/vscode/nls.ts`, `src/vendor/vscode/MANIFEST.json`
  - **Acceptance**:
    - Outcome: `node scripts/vendor-vscode-list.mjs --dry-run` prints the full closure (TS files + CSS side-effect imports + any `.js`-extension relative imports it had to resolve to `.ts`) and exits 0 without modifying the filesystem. `node scripts/vendor-vscode-list.mjs` then writes the closure to `src/vendor/vscode/` and produces `MANIFEST.json` listing every copied file with its upstream path and SHA. After the run, `import { List } from 'vs/base/browser/ui/list/listWidget'` type-checks.
    - Verify: unit `src/test/vendor-import.test.ts` — calls `await import('vs/base/browser/ui/list/listWidget')` and asserts `typeof imported.List === 'function'`.
  - **Plan**:
    1. Write `scripts/vendor-vscode-list.mjs`: recursive resolver starting at `listWidget.ts`. Handle: `import './foo.js'` → resolve to `foo.ts`; `import './foo.css'` → record as CSS side-effect; `import 'vs/…'` paths → resolve relative to upstream `src/vs/`; type-only `import type` → still copy the source file (since esbuild may include it).
    2. Implement `--dry-run` mode: log every resolved file + the per-file list of CSS imports it triggers; exit without filesystem writes.
    3. Implement live mode: copy each resolved file preserving the Microsoft copyright header byte-for-byte; emit `MANIFEST.json` with `{ files: [{ src, dest, upstreamSha, copiedAt }], cssImports: [...] }`.
    4. Implement `src/vendor/vscode/nls.ts` with both `localize` and `localize2` per D9.
    5. Run vendoring; re-run type-check; if missing transitive deps, add them as additional entry points to the script and re-run.

- [x] 1_3 Audit license headers on every vendored file
  - **Deps**: 1_2
  - **Refs**: specs/vscode-list-widget-vendor/spec.md#requirement-license-attribution; design.md Risk Map (vendoring closure correctness)
  - **Scope**: `scripts/check-vendor-headers.mjs`, `package.json` (add to `build:check` chain)
  - **Acceptance**:
    - Outcome: every `.ts` file under `src/vendor/vscode/` except `nls.ts` contains the substring "Copyright (c) Microsoft Corporation". `node scripts/check-vendor-headers.mjs` returns exit 0 and prints "OK: N files checked"; if any file is missing the header, exits non-zero with a clear path list.
    - Verify: manual run of the check script.
  - **Plan**:
    1. Write `scripts/check-vendor-headers.mjs`: walk `src/vendor/vscode/**/*.ts`, read first 5 lines, fail if "Microsoft Corporation" not present (skip `nls.ts`).
    2. Add `"build:check-vendor": "node scripts/check-vendor-headers.mjs"` to `package.json` scripts.
    3. Chain into the existing `build:check` script via `&&`.

- [x] 1_4 Add THIRD_PARTY_NOTICES.md
  - **Deps**: 1_2
  - **Refs**: specs/vscode-list-widget-vendor/spec.md#requirement-license-attribution; docs/research/20260522-vscode-vendoring-license-attribution.md
  - **Scope**: `THIRD_PARTY_NOTICES.md` (NEW), `README.md` (one-line reference)
  - **Acceptance**:
    - Outcome: file exists at repo root with (a) full MIT license text verbatim from `microsoft/vscode/LICENSE.txt`, (b) URL `https://github.com/microsoft/vscode`, (c) upstream commit SHA (also recorded in MANIFEST.json), (d) list of vendored top-level paths.
    - Verify: none — docs-only.
  - **Plan**:
    1. Copy MIT text from `/Users/huybuidac/Projects/ai-oss/vscode/LICENSE.txt`.
    2. Add provenance section referencing the SHA from MANIFEST.json.
    3. Add a one-line reference in `README.md`.

- [x] 1_5 Inline-inject vendored list CSS via webviewHtml
  - **Deps**: 1_2
  - **Refs**: design.md D7; specs/vscode-list-widget-vendor/spec.md#requirement-vendored-vs-code-list-widget; design.md Risk Map (vendoring closure correctness)
  - **Scope**: `src/providers/webviewHtml.ts`, `esbuild.js` (add `loader: { '.css': 'text' }` if needed)
  - **Acceptance**:
    - Outcome: every CSS file recorded in `MANIFEST.json` `cssImports` is concatenated into the `<style>` block in `webviewHtml.ts`. Running webview shows `.monaco-list` and `.monaco-scrollable-element` style rules present in DevTools.
    - Verify: manual — launch `pnpm run watch:webview`, open dev host (F5), inspect webview DOM, confirm rules visible.
  - **Plan**:
    1. Add `loader: { '.css': 'text' }` to esbuild config if not present.
    2. Import each CSS file recorded in MANIFEST as a string literal; concatenate into the existing inline `<style>` block.
    3. Verify no rule conflicts with existing webview CSS by spot-checking computed styles.

- [x] 1_6 Raise bundle-size ceiling to 3.6 MB
  - **Deps**: 1_2
  - **Refs**: design.md Risk Map (bundle ceiling); specs/vscode-list-widget-vendor/spec.md#requirement-bundle-size-budget
  - **Scope**: `scripts/check-bundle-size.mjs`
  - **Acceptance**:
    - Outcome: `CEILING_BYTES` raised from `3 * 1024 * 1024` to `3.6 * 1024 * 1024`. Script comment updated to reference this change. `pnpm run build:check-size` succeeds after vendoring; if vendored bundle exceeds 3.6 MB, build fails with clear message.
    - Verify: manual `pnpm run build:check-size` after task 1_2.
  - **Plan**:
    1. Update the constant.
    2. Update the comment in the file to reference change `port-vscode-async-data-tree` and the oracle-measured pre-vendor baseline of 3,089,435 bytes.

- [x] 1_7 Build + test smoke — instantiate List from vendor under all toolchains
  - **Deps**: 1_2, 1_5
  - **Refs**: design.md Risk Map (alias config); specs/vscode-list-widget-vendor/spec.md#requirement-build-smoke-after-vendoring
  - **Scope**: `src/test/vendor-import.test.ts` (NEW)
  - **Acceptance**:
    - Outcome: vitest test imports `List` from `vs/base/browser/ui/list/listWidget`, creates a JSDOM `document.body` host, instantiates a List with a trivial delegate + renderer, asserts the container element has class `monaco-list`. `pnpm run check-types`, `pnpm run test:unit`, AND `node esbuild.js --production` all pass.
    - Verify: unit `src/test/vendor-import.test.ts`
  - **Plan**:
    1. Add the test per acceptance using vitest + happy-dom or jsdom.
    2. Run the three verify commands.
    3. If a transitive dep is missing, extend the vendor script entry points and re-run 1_2 → 1_5 → 1_7.

- [x] 1_8 Post-vendor bundle delta measurement
  - **Deps**: 1_2, 1_5, 1_6
  - **Refs**: design.md Risk Map (bundle ceiling); specs/vscode-list-widget-vendor/spec.md#requirement-bundle-size-budget
  - **Scope**: `scripts/measure-vendor-delta.mjs` (NEW), `asimov/changes/port-vscode-async-data-tree/notes/bundle-baseline.txt` (NEW — records pre-vendor baseline)
  - **Acceptance**:
    - Outcome: a script records the pre-vendor baseline (3,089,435 bytes as of plan date) and the post-vendor bundle size, prints the delta, and exits non-zero if delta exceeds 450 KB. Delta is also written to a per-build artifact so it can be checked into CI later.
    - Verify: manual `node scripts/measure-vendor-delta.mjs` after vendoring; halt and re-scope (consider lazy-loading Shiki grammars or trimming vendored peripherals) if delta > 450 KB.
  - **Plan**:
    1. Write `bundle-baseline.txt` with `3089435` (the verified-at-plan-time figure).
    2. Write the measurement script: stat `media/webview.js`, compute delta vs baseline, log + exit-code per the threshold.

## 2. Generic Tree<T> wrapper

- [x] 2_1 Define ITreeDataSource and ITreeRenderer interfaces
  - **Deps**: 1_7
  - **Refs**: design.md D3; specs/file-tree-widget/spec.md#requirement-pluggable-data-source; specs/file-tree-widget/spec.md#requirement-pluggable-renderer
  - **Scope**: `src/webview/fileTree/ITreeDataSource.ts`, `src/webview/fileTree/ITreeRenderer.ts`
  - **Acceptance**:
    - Outcome: interface files exist exactly as in design.md § Interfaces. Type-check passes.
    - Verify: none — types-only file.
  - **Plan**:
    1. Create both files; copy the interface definitions verbatim from design.md § Interfaces.

- [x] 2_2 Implement Tree<T> class on listWidget — including identity stability and stale-async dropping
  - **Deps**: 2_1
  - **Refs**: design.md D3; design.md Risk Map (Tree<T> implementation complexity); specs/file-tree-widget/spec.md#requirement-generic-treet-wrapper; specs/file-tree-widget/spec.md#requirement-read-only-api-surface; specs/file-tree-widget/spec.md#requirement-pluggable-data-source (stale-async scenario)
  - **Scope**: `src/webview/fileTree/Tree.ts`
  - **Acceptance**:
    - Outcome: `Tree<T>` class exposes `setInput`, `expand`, `collapse`, `getSelection`, `setSelection`, `refresh`, `onDidChangeSelection`, `onDidChangeExpansion`, `onDidActivate`. Internally maintains `Map<T, { childrenPromise?, children?, expanded }>` keyed by reference identity. `expand(element)` triggers `dataSource.getChildren(element)` once and tracks the promise; if `collapse(element)` or `refresh(element)` is called before the promise resolves, the stale promise's resolved value is dropped (compare promise reference, not the element). Realistic LOC budget: 600-900 LOC including tests.
    - Verify: unit `src/webview/fileTree/Tree.test.ts` — covers: (1) `setInput` + initial render; (2) expand a node and assert children appear; (3) collapse and assert they disappear; (4) lazy load is called once per element on first expand; (5) refresh re-fetches; (6) **stale-async**: expand → collapse before promise resolves → resolved value MUST NOT update DOM; (7) **identity stability**: replacing parent with a new object reference resets cache for that element.
  - **Plan**:
    1. Implement the class with the `Map` cache and identity-aware staleness check (store the promise reference; on resolve, compare current promise reference for the element — if changed, discard).
    2. Diffing: on state changes, recompute the flat visible row list and call `listWidget.splice(...)` to apply the diff.
    3. Wire `onDidChangeSelection` from the underlying `List` events. Wire `onDidActivate` (Enter / double-click) similarly.
    4. Add the unit tests per Acceptance.Verify (7 scenarios).

- [x] 2_3 Implement WAI-ARIA keyboard navigation + aria-expanded
  - **Deps**: 2_2
  - **Refs**: design.md Risk Map (Tree<T> implementation complexity); specs/file-tree-widget/spec.md#requirement-aria--keyboard
  - **Scope**: `src/webview/fileTree/Tree.ts` (additions), `src/webview/fileTree/Tree.test.ts` (additions)
  - **Acceptance**:
    - Outcome: Tree responds to ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Enter / Home / End per WAI-ARIA Tree pattern. ARIA attrs (`role="tree"`, `role="treeitem"`, `aria-level`, `aria-expanded`, `aria-selected`) set on rendered DOM. `aria-expanded` updates synchronously when the element's expanded state changes — assertable in tests.
    - Verify: unit (extends Tree.test.ts) — 10 keyboard/ARIA scenarios: Down/Up moves selection; Right on collapsed-with-children expands AND sets `aria-expanded="true"`; Right on expanded moves to first child; Right on leaf does nothing; Left on expanded collapses AND sets `aria-expanded="false"`; Left on collapsed moves to parent; Home/End jump first/last visible; `aria-level` matches depth on every row; `aria-selected` flips on selection change.
  - **Plan**:
    1. Hook the List's `onKeyDown` event.
    2. Implement each scenario; share a small `getVisibleSiblings(element)` helper.
    3. Update DOM via the renderer's `renderElement` so it re-sets ARIA attrs on every render of an existing row.
    4. Add the 10 scenarios to the test.

## 3. File-system RPC

- [x] 3_1 Add RequestReadDirectory / ReadDirectoryResponse / SetFileTreePosition / WorkspaceRootChanged + extend InitMessage with rootGeneration
  - **Deps**: none (parallel to phase 1)
  - **Refs**: design.md § Interfaces; design.md D10; specs/file-tree-rpc/spec.md#requirement-readdirectory-message-types; specs/file-tree-rpc/spec.md#requirement-workspace-root-generation
  - **Scope**: `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: the discriminated unions in `messages.ts` include `RequestReadDirectoryMessage`, `ReadDirectoryResponseMessage`, `ToggleFileTreeMessage`, `SetFileTreePositionMessage`, `WorkspaceRootChangedMessage`. `RequestReadDirectoryMessage` and `ReadDirectoryResponseMessage` carry `rootGeneration: number`. `InitMessage` is extended with `rootGeneration: number` and `workspaceRoot: string | null`. All types match design.md § Interfaces.
    - Verify: none — types-only.
  - **Plan**:
    1. Append the new interfaces to `src/types/messages.ts` and the message union.
    2. Extend `InitMessage`.

- [x] 3_2 Extension-host read-directory handler with rootGeneration
  - **Deps**: 3_1
  - **Refs**: design.md D10; specs/file-tree-rpc/spec.md#requirement-extension-host-read-handler; specs/file-tree-rpc/spec.md#requirement-workspace-root-resolution
  - **Scope**: `src/providers/fileTreeRpcHandler.ts` (NEW), `src/providers/TerminalViewProvider.ts` (wire dispatch + maintain rootGeneration)
  - **Acceptance**:
    - Outcome: handler invokes `vscode.workspace.fs.readDirectory(uri)` and posts `ReadDirectoryResponseMessage` carrying the current `rootGeneration`. Path outside workspace returns `error.code = 'OUT_OF_WORKSPACE'`. Stale `rootGeneration` in request returns `error.code = 'STALE_ROOT'`. Provider exposes a `rootGeneration` field and includes it in every `InitMessage`.
    - Verify: integration `src/test/fileTreeRpc.integration.test.ts` — temp dir as workspace, request roundtrip with valid + invalid generation, request for out-of-workspace path. Assert each branch.
  - **Plan**:
    1. Write `fileTreeRpcHandler.ts` exporting `handleRequestReadDirectory(msg, provider, postMessage)`.
    2. Compare `msg.rootGeneration` to `provider.rootGeneration`; mismatch → STALE_ROOT.
    3. Resolve `msg.path` against the absolute workspace folder; reject if not contained → OUT_OF_WORKSPACE.
    4. Map `vscode.FileType` to our `kind`; ignore symlinks unless they resolve to file/directory.
    5. Wire the handler in `TerminalViewProvider`'s message dispatch; ensure `InitMessage` carries `rootGeneration` and `workspaceRoot`.

- [x] 3_3 Webview FileSystemDataSource with rootGeneration awareness
  - **Deps**: 3_1, 2_1
  - **Refs**: design.md D4, D10; specs/file-tree-rpc/spec.md#requirement-file-system-provider-interface-webview-side; specs/file-tree-rpc/spec.md#requirement-rpc-correlation
  - **Scope**: `src/webview/fileTree/FileSystemDataSource.ts` (NEW), `src/webview/fileTree/IFileSystemProvider.ts` (NEW)
  - **Acceptance**:
    - Outcome: `FileSystemDataSource` implements `IFileSystemProvider` and `ITreeDataSource<FileNode>`. Tracks its current `rootGeneration` from the most recent init/`WorkspaceRootChanged` message. Every `readDirectory(path)` posts `RequestReadDirectoryMessage` carrying that generation. Responses are dropped if their `rootGeneration` does not match the current value. Pending requests tracked in `Map<requestId, { resolve, reject }>`.
    - Verify: unit `src/webview/fileTree/FileSystemDataSource.test.ts` — correlation by requestId works; error responses reject the promise; orphan responses (unknown requestId OR mismatched generation) are logged and dropped.
  - **Plan**:
    1. Define `IFileSystemProvider` per design.md § Interfaces.
    2. Implement `FileSystemDataSource` with `pending: Map<string, { resolve, reject }>` and `currentRootGeneration: number`.
    3. RequestId: `${Date.now()}-${counter++}`.
    4. Implement `hasChildren(element)` = `element.kind === 'directory'`.

- [x] 3_4 Pending-request cleanup on dispose
  - **Deps**: 3_3
  - **Refs**: design.md Risk Map (RPC correlation under reload)
  - **Scope**: `src/webview/fileTree/FileSystemDataSource.ts`
  - **Acceptance**:
    - Outcome: `dispose()` rejects all pending requests with CancellationError and clears the map. FileTreePanel calls `dispose()` on toggle-off.
    - Verify: unit (extends FileSystemDataSource.test.ts) — fire 2 pending requests, dispose, assert both promises rejected and map empty.
  - **Plan**:
    1. Add `dispose()` and a `disposed` flag.
    2. On dispose, iterate `pending` and call `reject(new CancellationError())`.

- [x] 3_5 Workspace folder change handling
  - **Deps**: 3_2, 3_3, 4_2
  - **Refs**: design.md D10; design.md Risk Map (workspace-folder changes); specs/file-tree-rpc/spec.md#requirement-workspace-root-generation; specs/file-tree-rpc/spec.md#requirement-webview-side-root-change-invalidation
  - **Scope**: `src/providers/TerminalViewProvider.ts` (subscribe to `onDidChangeWorkspaceFolders`, increment generation, post WorkspaceRootChanged), `src/webview/messaging/MessageRouter.ts` (handle WorkspaceRootChanged), `src/webview/fileTree/FileSystemDataSource.ts` (cancel pending on root change), `src/webview/fileTree/FileTreePanel.ts` (refresh on root change)
  - **Acceptance**:
    - Outcome: when `vscode.workspace.onDidChangeWorkspaceFolders` fires, the extension increments `rootGeneration`, captures the new first-folder path, and posts `WorkspaceRootChangedMessage` to every active webview. The webview's `FileSystemDataSource` rejects all pending RPC requests with CancellationError, clears its in-memory child cache, and updates `currentRootGeneration`. `FileTreePanel` calls `tree.setInput(newRootNode)` to refresh, OR renders empty-state if `rootPath === null`.
    - Verify: integration `src/test/workspaceFolderChange.integration.test.ts` — temp dir as initial workspace; simulate folder change; assert (a) WorkspaceRootChanged posted with incremented generation, (b) any in-flight reads receive STALE_ROOT response or are cancelled, (c) webview-side state updates.
  - **Plan**:
    1. In `TerminalViewProvider`, subscribe to the VS Code event in `activate()`; on fire, increment internal counter, capture new root, broadcast message.
    2. In `MessageRouter`, route `workspace-root-changed` → call `dataSource.handleRootChanged(msg)` and `panel.refresh()`.
    3. In `FileSystemDataSource.handleRootChanged(msg)`: reject all pending, clear cache, set new generation.

## 4. File tree panel UI

- [x] 4_1 Read-only file row renderer
  - **Deps**: 2_1
  - **Refs**: specs/file-tree-panel/spec.md#requirement-file-tree-panel-component; design.md D8
  - **Scope**: `src/webview/fileTree/ReadOnlyFileRenderer.ts` (NEW), `src/webview/fileTree/fileTreePanel.css` (NEW)
  - **Acceptance**:
    - Outcome: `ReadOnlyFileRenderer` implements `ITreeRenderer<FileNode>`. Each row DOM: `<div class="file-tree-row" data-depth><span class="chevron"></span><span class="icon">📁</span><span class="name">…</span></div>`. Chevron span has inline-SVG background-image. Indent: `padding-left: ${depth * 16}px`.
    - Verify: unit `src/webview/fileTree/ReadOnlyFileRenderer.test.ts` — render folder, assert chevron present; render file, assert no chevron.
  - **Plan**:
    1. Write the renderer + CSS file.
    2. Add unit test.

- [x] 4_2 FileTreePanel component with sessionId-pinned open
  - **Deps**: 2_3, 3_3, 4_1
  - **Refs**: specs/file-tree-panel/spec.md#requirement-file-tree-panel-component; specs/file-tree-panel/spec.md#requirement-click-to-open; specs/file-tree-panel/spec.md#requirement-empty-state; design.md Risk Map (OpenFileMessage.sessionId requirement)
  - **Scope**: `src/webview/fileTree/FileTreePanel.ts` (NEW)
  - **Acceptance**:
    - Outcome: `FileTreePanel` composes `Tree<FileNode>` + `FileSystemDataSource` + `ReadOnlyFileRenderer`. On file click, posts `OpenFileMessage` with `path` AND `sessionId` resolved from the existing `getActiveSessionId()` helper (the same one used by `DragDropHandler`). On folder click, toggles expansion. Constructor takes `host: HTMLElement`, `workspaceRoot: string | null`, `getActiveSessionId: () => string | null`. Empty-state when `workspaceRoot === null`.
    - Verify: unit `src/webview/fileTree/FileTreePanel.test.ts` — mount with fake data source + workspace root → click a file row → assert `OpenFileMessage` posted with both `path` AND non-null `sessionId`. Mount without root → assert empty-state div.
  - **Plan**:
    1. Wire `Tree.onDidActivate`: directory → toggle expand; file → resolve sessionId via injected getter, post `OpenFileMessage`.
    2. Lifecycle: `mount()` / `dispose()`.

- [x] 4_3 4-side position layout + shape-default seeding + post-move fit
  - **Deps**: 4_2
  - **Refs**: design.md D5; design.md Risk Map (DOM-move + xterm refit); specs/file-tree-panel/spec.md#requirement-user-configurable-position-4-sides; specs/file-tree-panel/spec.md#requirement-default-position-by-webview-shape; specs/file-tree-panel/spec.md#requirement-position-is-persisted-and-shape-stable
  - **Scope**: `src/webview/main.ts`, `src/webview/resize/ResizeCoordinator.ts` (expose shape getter/event + `debouncedFit()` if not present), `src/webview/fileTree/FileTreePanel.ts`, `src/webview/fileTree/fileTreePanel.css`
  - **Acceptance**:
    - Outcome: `FileTreePanel.setPosition('top'|'bottom'|'left'|'right')` toggles a CSS class on the wrapper (`file-tree--top|--bottom|--left|--right`) controlling flex direction + child order per D5. If the new direction differs in axis from the current one, the terminal-area subtree is moved as a single DOM node (do NOT recreate). `ResizeCoordinator.debouncedFit()` is invoked AFTER every `setPosition`, `setOpen(true)`, and `setOpen(false)` call to re-trigger xterm fit. First reveal: `position` is computed from `ResizeCoordinator.currentShape()` and persisted. Shape changes after persistence do NOT auto-move.
    - Verify: manual — launch dev host, enable file tree (defaults to bottom in sidebar / right in panel), explicitly move to each of the other 3 sides, drag webview between sidebar and bottom panel, observe panel stays at user-chosen side, terminal cols/rows stay valid (no garbled output). 5 screenshots in task PR.
  - **Plan**:
    1. If `ResizeCoordinator` does not expose `currentShape()` + `onDidChangeShape: Event<...>` + a public `debouncedFit()`, add them.
    2. Add CSS for the four `.file-tree--*` classes per D5.
    3. Implement `FileTreePanel.setPosition(position)` — toggle CSS class, perform DOM-move-as-single-node if direction axis changes, call `debouncedFit()` after.
    4. On mount, seed from `state.fileTree.position` or compute from shape.
    5. Do NOT subscribe to `onDidChangeShape` for position updates.

- [x] 4_4 Toggle command + title-bar button
  - **Deps**: 4_3, 3_1
  - **Refs**: specs/file-tree-panel/spec.md#requirement-toggle-command; specs/file-tree-panel/spec.md#requirement-title-bar-buttons
  - **Scope**: `src/extension.ts`, `package.json`, `src/providers/TerminalViewProvider.ts`, `src/webview/messaging/MessageRouter.ts`
  - **Acceptance**:
    - Outcome: command `anywhereTerminal.toggleFileTree` invokable from command palette under "AnyWhere Terminal: Toggle File Tree"; title-bar button with `$(files)` icon on sidebar and panel views; invoking either shows/hides panel.
    - Verify: manual — invoke command from palette and click title-bar button; observe toggle.
  - **Plan**:
    1. Register command in `extension.ts`; handler posts `{ type: 'toggle-file-tree' }` to the active webview.
    2. Add `package.json` `contributes.commands` + `menus.view/title`.
    3. In webview `MessageRouter`, route `toggle-file-tree` → flip `FileTreePanel.visible` + call `ResizeCoordinator.debouncedFit()` (from task 4_3's exposed API).

- [x] 4_4b Set-position command + QuickPick + title-bar button
  - **Deps**: 4_4
  - **Refs**: specs/file-tree-panel/spec.md#requirement-move-command-via-quickpick; specs/file-tree-panel/spec.md#requirement-title-bar-buttons; design.md § Interfaces (`SetFileTreePositionMessage`)
  - **Scope**: `src/extension.ts`, `package.json`, `src/providers/TerminalViewProvider.ts`, `src/webview/messaging/MessageRouter.ts`, `src/webview/fileTree/FileTreePanel.ts`
  - **Acceptance**:
    - Outcome: command `anywhereTerminal.setFileTreePosition` invokable from command palette under "AnyWhere Terminal: Move File Tree…"; selecting it opens `vscode.window.showQuickPick(['Top','Bottom','Left','Right'])`; choice posts `SetFileTreePosition` to webview, panel re-renders + persists; cancel is no-op. Second title-bar button with `$(layout)` icon invokes the same command.
    - Verify: manual — pick each of 4 options; cancel.
  - **Plan**:
    1. Register command + QuickPick + lowercase mapping.
    2. Add `package.json` `contributes.commands` + `menus.view/title`.
    3. In `MessageRouter`, route `set-file-tree-position` → call `FileTreePanel.setPosition(msg.position)`.

- [x] 4_5 Typed WebviewState + fileTree persistence
  - **Deps**: 4_4b
  - **Refs**: design.md D6; design.md Risk Map (OpenFileMessage.sessionId — typed schema motivates this); specs/file-tree-panel/spec.md#requirement-state-persistence-schema; specs/file-tree-panel/spec.md#requirement-position-is-persisted-and-shape-stable
  - **Scope**: `src/types/messages.ts` (export `WebviewState` interface), `src/webview/state/WebviewStateStore.ts` (add typed `getState()` + `updateState()` methods), `src/webview/fileTree/FileTreePanel.ts` (consume)
  - **Acceptance**:
    - Outcome: `WebviewState` interface exported with `tabLayouts?`, `tabActivePaneIds?`, `fileTree?: { open, position, expandedPaths }`. `WebviewStateStore.getState(): WebviewState` and `updateState(patch: Partial<WebviewState>): void` exist. Existing `persist()` rewritten in terms of these. `FileTreePanel` reads on mount; if `fileTree` undefined OR `position` undefined → compute default position via `ResizeCoordinator.currentShape()`, persist. On every toggle/position-change/expand/collapse → persist.
    - Verify: unit `src/webview/state/WebviewStateStore.test.ts` (extend) — (a) `updateState({fileTree: {open:true, position:'left', expandedPaths:['/a','/a/b']}})` → `persist()` → `restore()` → asserted equal; (b) restore from state object lacking `fileTree` → no throw, returns `WebviewState` with `fileTree` undefined.
  - **Plan**:
    1. Define `WebviewState` interface in `src/types/messages.ts` (or new file `src/types/state.ts`).
    2. Refactor `WebviewStateStore` to expose `getState()` + `updateState()` typed methods; preserve current `persist()` / `restore()` behavior.
    3. In `FileTreePanel`, read `store.getState().fileTree`; default-seed on missing; subscribe to events; call `store.updateState({ fileTree: {...} })`.
    4. Extend the existing WebviewStateStore test with both scenarios.

- [x] 4_6 Theme variable binding
  - **Deps**: 4_2
  - **Refs**: specs/file-tree-panel/spec.md#requirement-theme-integration
  - **Scope**: `src/webview/fileTree/fileTreePanel.css` (extend)
  - **Acceptance**:
    - Outcome: file tree panel uses `--vscode-sideBar-background`, `--vscode-foreground`, `--vscode-list-hoverBackground`, `--vscode-list-activeSelectionBackground`, `--vscode-list-activeSelectionForeground`, `--vscode-focusBorder`, `--vscode-tree-indentGuidesStroke`. No hex colors except inline SVG chevron.
    - Verify: manual — launch dev host with dark/light/high-contrast themes; observe adaptation.
  - **Plan**:
    1. Replace placeholder colors with CSS variables.
    2. Optional: add a grep check that `fileTreePanel.css` has no `#` hex colors outside inline SVG.

## 5. Drag from tree to terminal

- [x] 5_1 Path-formatting helper — re-use existing `escapePathForShell`
  - **Deps**: none (parallel to other phases)
  - **Refs**: specs/file-tree-drag-to-terminal/spec.md#requirement-path-with-spaces
  - **Scope**: `src/webview/fileTree/Tree.ts` or `FileTreePanel.ts` (consumer; no new helper needed — re-use `src/utils/shellEscape.ts`)
  - **Acceptance**:
    - Outcome: confirm the existing `escapePathForShell` from `src/utils/shellEscape.ts` is the helper used both by the existing `DragDropHandler` and by the new file-tree drag. NO new path-formatting function introduced.
    - Verify: unit — confirm test already exists in `src/utils/shellEscape.test.ts`; no new test needed. If file does not exist, write a basic test there covering: plain path, path with space, path with single quote.
  - **Plan**:
    1. Check `src/utils/shellEscape.ts` and its existing test.
    2. If no test exists, add one with 4 cases.

- [x] 5_2 Draggable tree rows with custom MIME
  - **Deps**: 4_1, 4_2, 5_1
  - **Refs**: design.md D11; specs/file-tree-drag-to-terminal/spec.md#requirement-custom-drag-mime-type-for-file-tree-originated-drops; specs/file-tree-drag-to-terminal/spec.md#requirement-no-internal-reorder
  - **Scope**: `src/webview/fileTree/ReadOnlyFileRenderer.ts` (extend), `src/webview/fileTree/FileTreePanel.ts` (extend — dragover reject inside tree)
  - **Acceptance**:
    - Outcome: rendered rows have `draggable="true"`. On `dragstart`, sets `application/x-anywhere-terminal-file-tree-path = element.path` AND `text/plain = element.path` AND `text/uri-list = encodeURI('file://' + element.path)`. Tree container's `dragover` rejects when drop point is inside the tree (no internal reorder).
    - Verify: unit `src/webview/fileTree/ReadOnlyFileRenderer.test.ts` (extend) — synthetic dragstart, mock DataTransfer, assert all three MIME types set with expected values.
  - **Plan**:
    1. Add `draggable` and `dragstart` handler in `renderElement`.
    2. Set all three MIME types per design.md D11.
    3. Add `dragover` reject on tree's root container.
    4. Extend test.

- [x] 5_2b Drop-point pane resolution helper
  - **Deps**: none (parallel)
  - **Refs**: design.md D11; specs/file-tree-drag-to-terminal/spec.md#requirement-drop-targets-the-pane-under-the-drop-point
  - **Scope**: `src/webview/split/findLeafAtPoint.ts` (NEW), `src/webview/split/findLeafAtPoint.test.ts` (NEW)
  - **Acceptance**:
    - Outcome: `findLeafAtPoint(x: number, y: number, layout: SplitNode, leafIdToDom: Map<string, HTMLElement>): string | null` returns the sessionId of the topmost leaf whose DOM bounding rect contains the point; returns null if no leaf contains it.
    - Verify: unit `src/webview/split/findLeafAtPoint.test.ts` — 3 mock leaves with non-overlapping rects → point inside leaf A → returns A; point outside all → null; 2 overlapping leaves → returns the one last in iteration (matching DOM paint order).
  - **Plan**:
    1. Implement the helper using `getBoundingClientRect()` per leaf DOM element.
    2. Add the 3 test cases.

- [x] 5_3 Extend DragDropHandler with custom-MIME branch
  - **Deps**: 5_2, 5_2b
  - **Refs**: design.md D11; design.md Risk Map (drag-drop conflicts); specs/file-tree-drag-to-terminal/spec.md#requirement-drop-into-terminal-pane-inserts-path-without-shift; specs/file-tree-drag-to-terminal/spec.md#requirement-drop-targets-the-pane-under-the-drop-point
  - **Scope**: `src/webview/DragDropHandler.ts` (extend `onDrop` + overlay logic)
  - **Acceptance**:
    - Outcome: `onDrop` checks `e.dataTransfer?.types.includes('application/x-anywhere-terminal-file-tree-path')` FIRST. If present: bypass Shift gate, read the custom-MIME path, resolve drop-point pane via `findLeafAtPoint(...)` (fallback to active pane), shell-escape via `escapePathForShell`, post `input` message with the resolved `tabId`. If absent: existing Shift-gated, active-pane behavior unchanged. Overlay hint differentiates the two cases (no "Hold Shift" prompt when custom MIME is present in the drag).
    - Verify: unit `src/webview/DragDropHandler.test.ts` (extend) — (a) drop with custom MIME, no Shift → input message posted with drop-point pane id; (b) drop with custom MIME outside any leaf → falls back to active pane; (c) drop without custom MIME, no Shift → no-op (existing behavior); (d) drop without custom MIME, with Shift → uses existing strategies (existing behavior). Manual: drag a file from the file tree onto a non-active pane → path appears in THAT pane.
  - **Plan**:
    1. In `onDrop`, add the custom-MIME branch BEFORE the Shift check.
    2. Inside the branch: read path, call `findLeafAtPoint(e.clientX, e.clientY, ...)`, fallback to `getActiveSessionId()`, post input.
    3. Update overlay hint logic in `updateOverlayHint` to detect the custom MIME (via a stored flag captured in `dragenter`) and skip the "Hold Shift" text.
    4. Extend the test with 4 scenarios.
