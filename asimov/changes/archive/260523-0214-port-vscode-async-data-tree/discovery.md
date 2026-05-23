# Discovery: port-vscode-async-data-tree

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Library landscape (file-tree UI components) | Done | librarian → `docs/research/20260522-file-tree-webview-libraries.md` |
| VS Code Explorer port feasibility (early estimate) | Done | general-purpose agent (in conversation) |
| Webview architecture mapping | Done | finder subagent |
| AsyncDataTree transitive dep closure (precise) | Done | finder subagent against `/Users/huybuidac/Projects/ai-oss/vscode` |
| Build / bundle integration | Done | finder subagent against this repo |
| License + vendoring strategy | Done | librarian → `docs/research/20260522-vscode-vendoring-license-attribution.md` |

## Key Findings

### 1. AsyncDataTree's REAL transitive dep closure is much larger than the early estimate suggested

The early "tree + list = ~15K LOC, ZERO workbench deps" assessment was correct on the **service-injection** front (no `@IService`, no workbench imports — confirmed). But it understated the **peripheral UI widget** closure that `abstractTree.ts` pulls in.

Tree-widget core (`vs/base/browser/ui/tree/`): 6,072 LOC across 10 files. Anchor file `abstractTree.ts` alone is 2,650 LOC and contains a built-in find/filter widget that pulls in:

- `vs/base/browser/ui/list/` (7 files, 3,726 LOC) — list view + widget (required)
- `vs/base/browser/ui/actionbar/` (2 files, 971 LOC) — for find toolbar
- `vs/base/browser/ui/toggle/` (1 file, 435 LOC) — toggle buttons in find
- `vs/base/browser/ui/inputbox/` (1 file, 683 LOC) — find input field
- `vs/base/browser/ui/findinput/` (3 files, 647 LOC) — find widget
- `vs/base/browser/ui/contextview/` (1 file, 275 LOC) — find popover positioning
- `vs/base/browser/ui/scrollbar/` (7 files, 1,557 LOC) — list scrolling
- `vs/base/browser/ui/hover/` (5 files, 644 LOC) — item tooltips
- `vs/base/browser/ui/aria/` (1 file, 152 LOC) — a11y announcements
- `vs/base/browser/ui/dnd/` (1 file, 25 LOC) — drag-drop scaffolding
- `vs/base/browser/ui/codicons/codiconStyles.ts` (6 LOC) — icon entry
- `vs/base/browser/` core (dom, event, keyboardEvent, mouseEvent, touch, dnd, globalPointerMoveMonitor, browser, canIUse, cssValue, domStylesheets, formattedTextRenderer, history, fastDomNode) — ~15 files
- `vs/base/common/` utilities (events, lifecycle, observable, async, errors, color, layouts, history, filters, codicons, themables, types, arrays, ...) — ~30 files
- `vs/nls.ts` (i18n stub)

Plus CSS: `tree.css`, `paneviewlet.css`, `list.css`, `actionbar.css`, `toggle.css`, `inputBox.css`, `findInput.css`, `scrollbars.css`, `hoverWidget.css`, `aria.css`, `dnd.css`, `contextview.css`, `codicon.css`, `codicon-modifiers.css`.

Plus assets: **Codicon font file** + sprite metadata (referenced by abstractTree for chevron-right/down icons and by tree.css for loading spinner).

**Realistic closure: ~75 files, ~22-28K LOC of TypeScript + ~600 lines of CSS + 1 woff font.**

Most peripheral widgets exist ONLY to support `abstractTree`'s built-in find/filter feature, which we don't need for v1.

### 2. Bundle headroom is tight

- Current `media/webview.js`: ~2.74 MB
- Hard ceiling: **3 MB** (enforced by `scripts/check-bundle-size.mjs:16` — build fails above)
- Headroom: ~260 KB

Adding the full tree-widget closure unminified: rough estimate +400-700 KB. Minified+gzipped at build it'll be smaller, but esbuild config has `minifyIdentifiers: false` (intentional for xterm.js v6 compatibility — `esbuild.js:101-103`), so identifier minification we'd usually rely on is OFF. We will hit the ceiling.

Mitigations: (a) raise ceiling, (b) trim deps before vendoring, (c) trim other parts of the bundle (e.g. lazy-load Shiki grammars).

### 3. Path-alias rewrite required

VS Code source uses `vs/*` imports throughout. Our `tsconfig.json` has no `paths` and `moduleResolution: Bundler`. We must either:

- Add `paths: { "vs/*": ["./src/vendor/vscode/*"] }` to tsconfig **and** matching `alias` to esbuild config, OR
- Mass-rewrite imports to relative paths in vendored files (one-shot script).

Either is straightforward but must be decided up-front.

### 4. License path is clean

VS Code is plain MIT. Compliance requires: preserve per-file Microsoft copyright header, add `THIRD_PARTY_NOTICES.md` with verbatim MIT text + upstream commit/path provenance. No trademark concerns since we're not using "VS Code" branding. Theia uses this exact pattern. Full report at `docs/research/20260522-vscode-vendoring-license-attribution.md`.

### 5. Webview architecture already provides what we need for the file-manager wrapper

- **Adaptive position**: `ResizeCoordinator.ts:79-95` already detects `width > height * 1.2 → panel-shape` vs `sidebar-shape`. Reusable directly.
- **RPC**: typed postMessage protocol at `src/types/messages.ts` — clean to add `RequestReadDirectory` / `ReadDirectoryResponse` message types.
- **Extension-host FS helpers**: `src/providers/openFileLink.ts:1-70` already resolves paths against cwd + workspace folders.
- **State persistence**: `WebviewStateStore.ts:131-142` via `vscode.setState()` — extend to persist file-manager open/closed + expanded paths.
- **CSS injection pattern**: `src/providers/webviewHtml.ts:41-533` injects all CSS inline; no esbuild CSS loader. Tree CSS must follow this pattern (inline-injected from a TS string) OR a new esbuild CSS loader added.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Tree widget UI | none | virtualized expandable tree | port + vendor (see options) |
| File-system data source | extension-host stat helpers in `openFileLink.ts` | typed `read-directory` RPC | new message types + provider handler |
| Adaptive container | `ResizeCoordinator` shape detection | re-use for showing tree below vs right | small wiring — `~20 LOC` |
| Toggle command | command registry pattern in `extension.ts` | `anywhereTerminal.toggleFileTree` | new command + button |
| Codicons | none | chevron icons for collapsed/expanded | vendor codicon CSS + font (or use only chevron sprites) |
| Theme integration | xterm theme adapter | VS Code CSS variable-driven tree styling | use `--vscode-list-*` vars in vendored CSS |
| Persistence | `WebviewStateStore` | persist tree open/closed + expanded paths | extend `WebviewState` interface |
| Bundle budget | 260 KB headroom | tree-widget budget | raise ceiling and/or trim |

## Options

The user's earlier choice was Option C (port AsyncDataTree). The refined cost data warrants a re-presentation before committing.

### Option A — `@vscode-elements/elements` `vscode-tree` web component

- Web component, CSP-friendly, theme-matches via `--vscode-*` vars
- No lazy loading built-in → handle expand event ourselves and `setData()` on subtree (a few hours)
- Bundle: ~80-120 KB minified+gzipped; **comfortably under ceiling**
- Effort: **2-4 days** full feature parity for v1 scope
- Cost: visual fidelity ~95% of VS Code Explorer (it's literally designed to match)
- Risk: low — well-maintained, used by Microsoft sample extensions

### Option B — Custom vanilla tree

- Hand-roll a flexbox-based tree with `IntersectionObserver` for virtualization
- Effort: 5-7 days for a clean v1; lots of polish later for rename/keyboard nav
- Bundle: <30 KB
- Risk: medium — re-inventing well-trodden ground, ongoing maintenance

### Option C — Full port of `vs/base/browser/ui/tree` + `list`

- Vendor 70+ files, ~25K LOC TS + 14 CSS files + codicon font
- Bundle delta: 400-700 KB → **will breach 3 MB ceiling**; must raise gate
- Effort: **2-4 weeks** vendoring + path rewrite + build integration + adapter — before any v1 file-manager features
- Benefit: highest fidelity; ready for rename/drag-drop/decorations as follow-ups (those features ALREADY built into the widget)
- Risk: high — large surface area to vendor, upstream sync cost, build-config disruption

### Option C-trim — Port `list` only, build a thin tree on top

- Vendor `vs/base/browser/ui/list/` (3,726 LOC, 7 files) + minimal `vs/base/browser/dom.ts` / `event.ts` / `lifecycle.ts` deps
- Write our own thin `Tree<T>` (flat indexed list with collapsed flag per row, ~300 LOC)
- Skip everything `abstractTree.ts` pulls in (find widget, hover, contextview, actionbar, toggle, inputbox, findinput)
- Bundle delta: ~120-200 KB → **fits in ceiling**
- Effort: **5-8 days** vendoring + adapter + thin tree layer
- Benefit: VS Code-quality virtual scrolling and keyboard handling; small enough to stay in budget; doesn't lock us out of richer features later (we can layer them ourselves or vendor more pieces incrementally)
- Risk: medium — we write the indented-tree-on-flat-list logic ourselves, but it's a known pattern (~300 LOC)

## Recommendation

Option **C-trim** if the goal is "port-flavored" delivery that stays close to the user's original Option C intent without the full 22K LOC blast radius. Option **A** if speed is paramount and we accept a non-vendored, npm-tracked dependency.

The original Option C (full AsyncDataTree port) is **achievable but expensive** — it costs 2-4 weeks of vendoring/build work BEFORE any user-visible file-manager feature, and breaches the 3 MB bundle ceiling.

## Risks

1. **Bundle ceiling breach (Option C only)** — mitigation: raise `check-bundle-size.mjs` cap to 3.5 MB **AND** measure post-build delta after vendoring; if >3.5 MB, trim Shiki grammars or peripheral widgets.
2. **Path alias drift** — if we add `vs/*` to tsconfig but esbuild config doesn't match, builds will silently break. Add both in the same commit and verify with a smoke build before deeper work.
3. **Codicon font loading** — VS Code injects the font globally; in our webview we must reference it via `vscode-resource:` URI, which esbuild does not handle. Need an HTML-injection step similar to `xterm.css`.
4. **Upstream sync cost** — vendored copies drift from `microsoft/vscode` main. Once vendored, treat as a hard fork; do NOT plan to track upstream patches.
5. **`vs/nls.ts` localization stub** — VS Code uses `nls.localize('key', 'fallback', ...)`. We need a no-op stub that returns the fallback string. ~10 LOC.

## Open questions for Gate 1

- Stick with full Option C, switch to Option C-trim, or pivot to Option A?
- If C/C-trim: are we OK raising the 3 MB bundle ceiling?
- If C/C-trim: tsconfig `paths` vs mass relative-path rewrite?
