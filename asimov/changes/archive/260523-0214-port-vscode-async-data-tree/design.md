# Design: port-vscode-async-data-tree

## Decisions

### D1: C-trim (port `list/` + thin generic `Tree<T>`) instead of full AsyncDataTree port

Vendor `vs/base/browser/ui/list/` (~3,726 LOC, 7 files) plus minimum-required `vs/base/browser/` and `vs/base/common/` utilities. Write our own `Tree<T>` (~300 LOC) on top — flat indented list with per-row collapse flag, expand on click, keyboard navigation matching WAI-ARIA Tree pattern.

**Rationale**: read-only + drag-out-only scope removes the need for everything `abstractTree.ts` pulls in (find widget, inline rename inputbox, contextview, actionbar, hover, toggle). Bundle delta drops from 400-700 KB (full port) to 120-200 KB. Effort drops from 2-4 weeks to ~8 days. Folder layout under `src/vendor/vscode/` mirrors upstream so adding the rest of the closure later (when we want rename or context menus) is mechanical: drop more files into the existing vendor tree, wire them up.

**Rejected**: full AsyncDataTree port — breaches the 3 MB bundle ceiling (current 2.74 MB), 2-4 weeks of vendoring/build work before any user-visible feature, and most of the vendored code (find widget, rename inputbox, drag-drop primitives) is unused by the read-only v1 scope.

**Rejected**: `@vscode-elements/elements` (Option A) — speed and bundle win but introduces a tracked npm dep we have less control over; user prefers vendored source so future feature work (rename / internal drag-drop / decorations) can plug in to the same widget without library swap.

### D2: `vs/*` path alias via tsconfig + esbuild + vitest + biome (4 configs in lockstep)

The alias MUST be set in all four config files because each tool has its own resolution pipeline:

```jsonc
// tsconfig.json (type-check)
"paths": { "vs/*": ["./src/vendor/vscode/*"] }
```
```js
// esbuild.js (bundle)
alias: { "vs": path.resolve(__dirname, "src/vendor/vscode") }
```
```ts
// vitest.config.mts (unit-test) — extend the existing alias block
test: {
  alias: {
    vscode: path.resolve(__dirname, "src/test/__mocks__/vscode.ts"),
    vs: path.resolve(__dirname, "src/vendor/vscode"),  // NEW
  },
}
```
```jsonc
// biome.json — exclude vendored files from lint/format
"files": {
  "includes": ["**", "!**/dist", "!**/out", "!**/.vscode", "!**/.vscode-test", "!src/vendor/**"]
}
```

**Rationale**: keeps vendored files unmodified except for the license header line, so future drops of additional vendored files (when adding rename, etc.) work without per-file rewrites. All four configs MUST be added in the same task (`1_1`); a mismatch silently breaks one of the four pipelines. Build smoke task (`1_7`) gates type-check + bundle; vitest test in `1_7` gates the test runner; Biome exclusion is verified by `pnpm run lint` not emitting diagnostics about vendored files.

**Rejected**: mass relative-path rewrite — diff-noisy, increases the cost of adding more vendored files later (each must be rewritten).

**Rejected**: alias only `tsconfig` + `esbuild`, count on vitest's resolver to "just work" — vitest uses its own alias block and won't pick up tsconfig paths without explicit config; oracle review caught this gap.

### D3: Generic `Tree<T>` mirroring AsyncDataTree's data/renderer interfaces

Our `Tree<T>` exposes `setInput`, `expand`, `collapse`, `getSelection`, `setSelection`, `refresh`, `onDidChangeSelection`, `onDidChangeExpansion`, `onDidActivate`. Consumers provide `ITreeDataSource<T>` and `ITreeRenderer<T>`.

```ts
interface ITreeDataSource<T> {
  hasChildren(element: T | null): boolean;
  getChildren(element: T | null): Promise<T[]>;
}

interface ITemplateData { /* opaque renderer-specific */ }

interface ITreeRenderer<T> {
  templateId: string;
  renderTemplate(container: HTMLElement): ITemplateData;
  renderElement(element: T, depth: number, template: ITemplateData): void;
  disposeTemplate(template: ITemplateData): void;
}
```

**Rationale**: identical shape to VS Code's `IAsyncDataSource` and `ITreeRenderer`. If a future change pulls in the real AsyncDataTree (e.g. once we want compressed-folder rendering or built-in find), every consumer migrates without API churn — we change only the inner class. Method names, generic parameter, event names match upstream.

### D4: `IFileSystemProvider` — read-only now, structured to extend

```ts
interface IFileSystemProvider {
  readDirectory(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
}
```

Future change adds (NOT in this scope):

```ts
interface IWritableFileSystemProvider extends IFileSystemProvider {
  rename(oldPath: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
  create(path: string, kind: 'file' | 'directory'): Promise<void>;
  watch(path: string, cb: (events: FileChangeEvent[]) => void): IDisposable;
}
```

**Rationale**: clean composition over option-bag methods. The tree's panel code accepts `IFileSystemProvider`; the future rename feature accepts `IWritableFileSystemProvider` and is wired only where rename is enabled. No optional methods or feature flags inside one interface.

### D5: User-configurable position on one of 4 sides; ResizeCoordinator only seeds the default

The file tree panel occupies one of four positions relative to the terminal area: `top`, `bottom`, `left`, `right`. The terminal split tree's layout logic is unchanged — it just receives a smaller rectangular host element.

DOM layout: one flex container wraps `[file-tree-panel, terminal-area]` (or reversed). Position → (flex direction, child order):

- `top`    → `flex-direction: column`, panel first, terminals second
- `bottom` → `flex-direction: column`, terminals first, panel second
- `left`   → `flex-direction: row`,    panel first, terminals second
- `right`  → `flex-direction: row`,    terminals first, panel second

Size of panel: 30% on `left`/`right` (a vertical strip); 40% on `top`/`bottom` (a horizontal strip). Hard-coded in this change; user-resize is a future feature.

Default position is computed from `ResizeCoordinator`'s shape the FIRST time the panel is shown in a workspace: `panel` shape → `right`; otherwise → `bottom`. This default is persisted immediately. Subsequent shape changes (e.g. user drags the view from sidebar to bottom panel) do NOT change the persisted position — only the explicit move command does.

**Rationale**: gives users full layout control while keeping a sensible first-launch experience. Splitting the position semantics from the shape semantics means the file tree behaves predictably across view-drag operations, which the user identified as important.

**Rejected**: pure-auto adaptive layout (the original D5) — breaks the user's mental model when they drag the webview between locations; their layout shifts unexpectedly.

**Rejected**: drag-to-reposition the panel (drop zones overlay like VS Code editor groups) — UX is nicer but the drop-zone overlay is non-trivial work, and the command + QuickPick path is sufficient at this stage.

### D6: State persistence via typed `WebviewState` interface + `WebviewStateStore.fileTree`

There is currently NO typed `WebviewState` interface — `WebviewStateStore.persist()` writes a `Record<string, unknown>` containing `tabLayouts` and `tabActivePaneIds` only (`src/webview/state/WebviewStateStore.ts:131-142`). This change introduces a typed interface:

```ts
// src/types/messages.ts (or src/webview/state/WebviewState.ts)
export interface WebviewState {
  tabLayouts?: Record<string, SplitNode>;
  tabActivePaneIds?: Record<string, string>;
  fileTree?: {
    open: boolean;
    position: 'top' | 'bottom' | 'left' | 'right';
    expandedPaths: string[];
  };
}
```

`WebviewStateStore` gains a typed `getState(): WebviewState` and `updateState(patch: Partial<WebviewState>): void` to replace ad-hoc spread-merge. The existing `persist()` is rewritten in terms of the typed interface; existing fields (`tabLayouts`, `tabActivePaneIds`) keep their behavior. The `fileTree.position` field is set on first reveal (computed from shape per D5) and persisted from then on; missing `fileTree` is interpreted as "panel never shown before" — next reveal seeds it.

**Rationale**: typed schema means future fields (selection, scroll, sash size, customNames, lastWorkspaceFolder) have a single place to extend. Migration is a no-op for absent fields since all are optional. Without this typed layer, every new state consumer would re-invent ad-hoc record munging.

**Rejected**: leave state as untyped `Record<string, unknown>` and just add `fileTree` ad-hoc — oracle review caught that the original design assumed `WebviewState` already existed as typed; cleaning this up is a small change with high downstream value.

### D7: CSS injection — vendored CSS goes inline via `webviewHtml.ts`

Vendored CSS files (`list.css`, `scrollbars.css`, plus a project-specific `fileTreePanel.css`) are concatenated and injected as a single inline `<style>` block in `webviewHtml.ts`, following the existing pattern for split/tabbar/error CSS at `src/providers/webviewHtml.ts:41-533`.

**Rationale**: esbuild has no CSS loader configured. Adding one introduces build-config churn beyond this change's scope. Inline-injection is the established convention.

### D8: Chevron icons via inline SVG — no Codicon font

The two chevrons (right for collapsed, down for expanded) ship as inline SVG sprites in the vendored CSS via `background-image: url("data:image/svg+xml;utf8,…")`. Folder/file icons are simple Unicode placeholders (`📁` / `📄`) initially.

**Rationale**: vendoring the full Codicon font (~70 KB woff + 14 KB CSS) plus configuring esbuild to copy the font asset is disproportionate for two chevrons. File-icon theme integration is a separate future feature.

### D10: Workspace root generation for RPC freshness

The extension host maintains a monotonic `rootGeneration: number` that increments on every `vscode.workspace.onDidChangeWorkspaceFolders` event. The generation is sent to the webview on `InitMessage` and on a new `WorkspaceRootChanged` message. Every `RequestReadDirectory` carries the webview's last-known generation; the extension host echoes its current generation in every `ReadDirectoryResponse`. The webview drops responses whose generation does not match its current state, and on receipt of `WorkspaceRootChanged` it cancels all pending requests and clears tree-data caches.

**Rationale**: prevents stale tree data from a previous workspace folder polluting the UI after the user adds, removes, or reorders workspace folders. Cheap to implement (one int + two messages) and covers the entire family of "workspace root changed mid-flight" bugs without complex state diffing.

**Rejected**: `vscode.workspace.onDidChangeWorkspaceFolders` only, no generation — would handle folder additions but not provide a way for in-flight responses to be identified as stale once they arrive.

### D11: Drag-drop disambiguation via custom MIME type

The file tree sets `dataTransfer.setData('application/x-anywhere-terminal-file-tree-path', <absolute-path>)` on every `dragstart`. The existing `DragDropHandler.onDrop` (`src/webview/DragDropHandler.ts:211-241`) is extended with a SIBLING branch that fires BEFORE the existing Shift-gated path:

```ts
// Pseudo-code added to onDrop
if (e.dataTransfer?.types.includes('application/x-anywhere-terminal-file-tree-path')) {
  // In-webview file-tree drag: bypass Shift, target the drop-point pane.
  const path = e.dataTransfer.getData('application/x-anywhere-terminal-file-tree-path');
  const pane = findLeafAtPoint(e.clientX, e.clientY) ?? this.getActiveSessionId();
  this.postMessage({ type: 'input', tabId: pane, data: `${escapePathForShell(path)} ` });
  return;
}
// ... existing Shift-required OS drag path unchanged ...
```

A new helper `findLeafAtPoint(x, y): string | null` walks the rendered split-tree leaves and returns the sessionId of the topmost leaf whose DOM rect contains the point.

**Rationale**: keeps OS drag-from-Explorer behavior identical (Shift still required, still hits active pane), while adding in-webview drag-out with the more discoverable no-Shift UX and correct drop-point routing. Disambiguating by MIME type (not by event source detection) is robust to future drag origins.

**Rejected**: extend the existing `text/plain` path-starts-with-`/` heuristic — would break quoted paths and conflate with paste operations.

**Rejected**: bypass Shift for all drops if any in-webview origin is present — too aggressive; preserves the existing OS-drag invariant.

### D9: NLS stub — `vs/nls.ts` returns `defaultValue` after positional substitution

```ts
export function localize(_key: string, defaultValue: string, ...args: unknown[]): string {
  return defaultValue.replace(/\{(\d+)\}/g, (_, i) => String(args[+i] ?? ''));
}
```

**Rationale**: matches the upstream signature used by listWidget for ARIA labels. Files calling `nls.localize(...)` compile unchanged.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `vs/*` alias config | tsconfig/esbuild/vitest/biome drift produces silently broken bundle or test failure | Task `1_7` is a smoke gate that imports listWidget from vendor and instantiates it under both `tsc --noEmit` AND vitest. All four configs added in the same task (`1_1`). |
| Bundle size ceiling | Oracle-measured vendor delta is ~500 KB, not 120-200 KB as initially estimated. Pre-vendor bundle is 3,089,435 bytes (only 55 KB headroom against 3 MB ceiling). | Task `1_6` raises ceiling to 3.6 MB. Task `1_8` is a post-vendor measurement gate that records actual delta; fails if delta exceeds 450 KB; halt and re-scope if exceeded. Risk Level acknowledged in proposal — bundle pressure is the dominant risk. |
| Tree<T> implementation complexity | Oracle review: 300 LOC estimate optimistic; realistic 600-900 LOC including identity stability, stale async dropping, aria-expanded handling | Task `2_2` LOC budget bumped; task `2_3` extended with WAI-ARIA `aria-expanded` scenarios; spec `file-tree-widget` "Stale async result is dropped" scenario added |
| `Tree<T>` keyboard logic | WAI-ARIA Tree spec is subtle (Right collapses-on-leaf vs moves-down, etc.); easy to ship a subtly broken impl | Task `2_3` is a vitest unit-test suite with explicit keyboard scenarios per WAI-ARIA pattern; manual verification in VS Code dev host before sign-off |
| RPC correlation under reload | Webview reload (panel reveal/hide) may leave pending `RequestReadDirectory` orphaned | Task `3_4` clears the pending map on webview unmount; responses with unknown `requestId` are logged and dropped (per spec) |
| Workspace-folder changes invalidate tree state | Add/remove/reorder of workspace folders can cause in-flight reads to resolve against an old root, or stale entries to render. Init does not currently carry a workspace-root identity. | D10: monotonic `rootGeneration` on host + carried on init/response. Task `3_5` subscribes to `onDidChangeWorkspaceFolders`, increments generation, posts `WorkspaceRootChanged`; webview drops mismatched responses and clears caches. |
| Drag-drop conflicts with existing OS-drag handler | Existing `DragDropHandler.onDrop` (`src/webview/DragDropHandler.ts:211-241`) requires Shift and targets active pane via `getActiveSessionId()` only. Original drag-out spec assumed it could just emit `text/plain`, which collides with the Strategy-5 `text/plain` path on line 122-124. | D11: custom MIME `application/x-anywhere-terminal-file-tree-path` as authoritative origin marker; task `5_3` adds a sibling branch BEFORE the Shift check that handles this MIME with drop-point pane resolution and no Shift requirement. |
| `OpenFileMessage.sessionId` requirement | The extension's existing `openFile` handler rejects messages without a `sessionId` (`src/types/messages.ts:129-139`, `src/providers/TerminalViewProvider.ts:442-443`). The file-tree click-open must supply one. | Task `4_2` acceptance: click-to-open posts `OpenFileMessage` with `sessionId = getActiveSessionId()`. |
| Vendoring closure correctness | Naive recursive copier misses CSS side-effect imports (`import './list.css'`), `.js`-extension relative imports (`../../dom.js`), index re-exports, and type-only imports. Could result in runtime "module not found" errors deep into integration. | Task `1_2` acceptance: vendoring tool produces `MANIFEST.json` enumerating every copied file + its upstream SHA; supports dry-run mode listing the resolved closure before any filesystem writes; `1_5` separately verifies side-effect CSS imports are detected. |
| DOM-move + xterm refit | Position-changing the tree panel reparents the terminal-area subtree; xterm canvas survives reparent but needs a fit re-trigger to recompute cols/rows for the new geometry. | Task `4_3` acceptance: `ResizeCoordinator.debouncedFit()` (or equivalent) is invoked AFTER each position change AND each open/close. Pattern: this repo already reparents terminal containers (`TerminalFactory.ts:326-338`, `SplitTreeRenderer.ts:92-101`), so the move itself is known-safe. |
| Shape change race | Switching sidebar↔panel mid-expand could reparent DOM and break Tree's listWidget | D5 mandates in-place flex direction swap, no reparent, and shape changes never auto-move the panel (only explicit move command does). Task `4_3` includes a manual test for drag-from-sidebar-to-panel mid-expand, verifying the panel stays at its persisted side. |
| Drag-out path quoting | Paths with spaces need single-quote wrapping; missing this breaks shell command | Task `5_1` includes a unit test for the path-formatting helper covering: plain path, path with space, path with single-quote (escape), Windows-style path on macOS source |
| License attribution miss | Per-file Microsoft header lost during vendoring script | Task `1_2` is the vendoring script; task `1_3` is the audit that greps for `Microsoft Corporation` headers and fails CI if any vendored file lacks one |
| `vs/nls.ts` argument mismatch | Some vendored files use `nls.localize2` (returns `{value, original}` tuple) which our stub doesn't implement | Task `1_5` adds `localize2` to the stub as well; `1_7` build smoke catches any missing exports |

## Target Layout

```
src/
  vendor/
    vscode/
      LICENSE-NOTICE.md          # provenance + commit SHA
      base/
        browser/
          ui/
            list/
              listWidget.ts      # + Microsoft header preserved
              listView.ts
              listPaging.ts
              list.ts
              rangeMap.ts
              rowCache.ts
              splice.ts
              list.css           # also referenced from webviewHtml inline injection
              media/
                scrollbars.css
          dom.ts
          event.ts
          keyboardEvent.ts
          mouseEvent.ts
          touch.ts
          ... (rest of minimum closure — task 1_2 enumerates exact list)
        common/
          arrays.ts
          async.ts
          cancellation.ts
          decorators.ts
          errors.ts
          event.ts
          lifecycle.ts
          ... (rest)
      nls.ts                     # our stub
  webview/
    fileTree/
      Tree.ts                    # generic Tree<T> on top of listWidget
      ITreeDataSource.ts
      ITreeRenderer.ts
      FileTreePanel.ts           # the user-facing panel
      FileSystemDataSource.ts    # IFileSystemProvider implementation
      ReadOnlyFileRenderer.ts    # ITreeRenderer<FileNode>
      fileTreePanel.css          # project-specific styles
  types/
    messages.ts                  # + RequestReadDirectory, ReadDirectoryResponse
  providers/
    fileTreeRpcHandler.ts        # extension-host side of RPC
THIRD_PARTY_NOTICES.md           # new top-level file
```

## Interfaces

```ts
// src/webview/fileTree/ITreeDataSource.ts
export interface ITreeDataSource<T> {
  hasChildren(element: T | null): boolean;
  getChildren(element: T | null): Promise<T[]>;
}

// src/webview/fileTree/ITreeRenderer.ts
export interface ITemplateData { dispose?(): void; }
export interface ITreeRenderer<T, TTemplate extends ITemplateData = ITemplateData> {
  templateId: string;
  renderTemplate(container: HTMLElement): TTemplate;
  renderElement(element: T, depth: number, template: TTemplate): void;
  disposeTemplate(template: TTemplate): void;
}

// src/webview/fileTree/FileSystemDataSource.ts (signature only)
export interface FileNode {
  name: string;
  path: string;            // absolute
  kind: 'file' | 'directory';
}
export interface IFileSystemProvider {
  readDirectory(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
}
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory'; }
export interface FileStat { mtime: number; size: number; kind: 'file' | 'directory'; }

// src/types/messages.ts — additions (signature only)
export interface RequestReadDirectoryMessage {
  type: 'request-read-directory';
  requestId: string;
  path: string;
}
export interface ReadDirectoryResponseMessage {
  type: 'read-directory-response';
  requestId: string;
  entries?: FileEntry[];
  error?: { code: string; message: string };
}
export interface ToggleFileTreeMessage {
  type: 'toggle-file-tree';
}
export interface SetFileTreePositionMessage {
  type: 'set-file-tree-position';
  position: 'top' | 'bottom' | 'left' | 'right';
}

// Workspace root tracking (D10)
export interface WorkspaceRootChangedMessage {
  type: 'workspace-root-changed';
  rootPath: string | null;       // null = no workspace folder open
  rootGeneration: number;
}

// RequestReadDirectory / ReadDirectoryResponse extended with generation
export interface RequestReadDirectoryMessage {
  type: 'request-read-directory';
  requestId: string;
  rootGeneration: number;
  path: string;
}
export interface ReadDirectoryResponseMessage {
  type: 'read-directory-response';
  requestId: string;
  rootGeneration: number;
  entries?: FileEntry[];
  error?: { code: string; message: string };
}
```

## Design Constraints

- esbuild webview build uses `minifyIdentifiers: false` (intentional — xterm.js v6 incompatible with identifier mangling). Vendored code will therefore bundle larger than typical; account for ~1.5× the gzipped-minified size in bundle estimates.
- `tsconfig.json` has `moduleResolution: Bundler`. Path aliases work; relative-path runtime resolution does not happen — esbuild rewrites at build time.
- All FS operations MUST cross the webview ↔ extension boundary via `postMessage`. Webview has NO direct `fs` access (CSP + VS Code architecture). The Tree<T> widget itself is FS-agnostic — only `FileSystemDataSource` knows the RPC layer.
- VS Code's `listWidget` listens to `pointer*` events; the webview's host element MUST NOT have `pointer-events: none` set on any ancestor when the tree panel is visible.
- The existing `ResizeCoordinator` shape signal fires on every resize tick — the file tree panel's layout-change handler MUST be idempotent and cheap (no full re-render on every tick).
