# Discovery: refine-file-tree-controls

## Workstreams

| Workstream | Status | Output |
| --- | --- | --- |
| Existing Design Docs | skipped | No general design doc exists for file tree; behavior already pinned in `specs/file-tree-panel/spec.md` + `specs/file-tree-widget/spec.md` |
| Architecture Snapshot (asm-finder) | done | Exact files + line ranges for header buttons, title-bar menu entries, bottom-layout CSS, toggle handlers |
| Internal Patterns | done (inline) | Empty-state pattern (spec req "Empty state"); root-collapsed CSS already exists (`.file-tree--root-collapsed`) |
| External Research | skipped | `vscode.openFolder` is a built-in command — no library lookup needed |

## Key Findings

### F1 — Header buttons today (search · move · close)

`src/webview/fileTree/FileTreePanel.ts:746-885` builds the header. Actions cluster at line 793 holds three buttons:

- Search (805-803) — toggles search-active mode
- **Close (805-809)** — `onClick: () => this.setOpen(false)` — the X icon to remove.
- Move (811-816) — opens position QuickPick

DOM order in `actions`: search → move → close (line 820-822). All built via shared `makeHeaderButton()` helper (`FileTreePanel.ts:1382-1398`).

### F2 — Title-bar Toggle entry to remove

`package.json` lines 313-322 declare two per-view toggle commands (`anywhereTerminal.toggleFileTree.sidebar` / `.panel`), each with icon `$(list-tree)`. `package.json` lines 396-405 contribute them to `view/title` (group `view@1`). The generic `anywhereTerminal.toggleFileTree` command (line 309-312) is declared but the menu only uses the per-view variants. Handlers live at `src/extension.ts:337-342` (generic) and `:396-400` (per-loc).

### F3 — Bottom-layout CSS + existing divider

`src/webview/fileTree/fileTreePanel.css:586-597` defines `.webview-layout.file-tree--bottom` — `flex-direction: column`, terminal `order:0`, panel `order:1` with `flex: 0 0 var(--file-tree-size, 200px)`.

A resize sash already exists (`.file-tree-panel .sash` at css:634+) that paints a 1px line on the edge facing the terminal. Its color is `var(--vscode-panel-border, var(--vscode-sideBar-border, transparent))` (css:675) — **falls back to `transparent`** when no theme variable is defined. That is why the divider can appear missing on some themes. The sash's 1px line is also slightly inset (positioned with `top: -2px`, `left:0`, `width:100%`, `height:4px` invisible touch zone; `::before` puts the visible 1px at the center).

### F4 — Already-existing minimize: root-collapsed state

`fileTreePanel.css:713-723` defines `.webview-layout.file-tree--root-collapsed` — when the root row is collapsed (user clicks the chevron), the panel shrinks to header-only height. This is the natural "minimize" that replaces the removed close behaviour: clicking the root chevron collapses the body, click again to expand.

### F5 — Open Folder is a built-in VS Code command

`vscode.commands.executeCommand('vscode.openFolder', uri?, options?)` opens the standard File→Open Folder dialog when called without a uri. No new dependency; works in both Desktop and Web (Web uses Workspace API).

### F6 — Persisted `open: boolean`

`spec file-tree-panel` requirement "State persistence schema" persists `open: boolean`. Once Close is removed and Toggle is removed, `open` is vestigial (always `true`). Backward compat is cheap — ignore the persisted value on read and never write `false`.

## Gap Analysis

| Gap | Question |
| --- | --- |
| G1 | **Open Folder button placement** — header actions (always visible) vs. only in empty state (no workspace) vs. both? |
| G2 | **Bottom divider scope** — strengthen the existing sash divider across all 4 sides (uniform), or add a separate static line just for the bottom case? |
| G3 | **`open` state** after removing Close + Toggle — keep field in schema (force `true`), or remove it (additive removal)? |

## Options

### G1 — Where does "Open Folder" button live?

| ID | Option | Pros | Cons |
| --- | --- | --- | --- |
| **A1** | Add to header actions cluster as the 3rd button (replacing the removed Close). Order: search · open-folder · move. | Always visible; discoverable; keeps button count at 3. | Slightly different from VSCode's File menu pattern. |
| A2 | Show only inside empty-state body (no workspace open). | Mirrors VSCode's empty-state pattern. | Hidden after first folder open; can't reach to switch folders. |
| A3 | Both — header button + empty-state CTA. | Best discoverability; emphasized on empty state. | Most code; mild duplication. |

### G2 — How is the bottom divider added?

| ID | Option | Pros | Cons |
| --- | --- | --- | --- |
| **B1** | Strengthen the existing sash divider color: replace `transparent` fallback with `var(--vscode-widget-border, rgba(128,128,128,0.35))`. Applies to all 4 sides. | One-line CSS fix; consistent across positions; uses the resize sash already in place. | Affects all sides — but user only mentioned bottom; treat as desirable consistency. |
| B2 | Add a separate static 1px border on the panel (`border-top` for bottom, etc.) in addition to the sash. | Independent of sash hover behavior. | Two visual lines possible; doubles up at hover. |
| B3 | Bottom-only: thicker (2px) always-visible divider line. | Matches user's literal wording. | Inconsistent with other sides. |

### G3 — What about the `open: boolean` field after removing Close + Toggle?

| ID | Option | Pros | Cons |
| --- | --- | --- | --- |
| **C1** | Keep schema, force `open = true` on read and never write `false`. | Zero breaking change to persisted state. | One dead field. |
| C2 | Remove `open` from state schema (additive removal, default-true on read). | Cleaner schema. | Tiny migration story; users on old extension version would lose nothing meaningful. |

## Risks

| ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Users with existing `fileTree.open = false` in their persisted state see the panel suddenly always open after upgrade. | LOW | Intentional — Close is removed; root-collapse provides the "minimize" affordance instead. Call this out in changelog. |
| R2 | Removing `anywhereTerminal.toggleFileTree.*` commands from `package.json` breaks any user keybindings bound to them. | LOW | **Accepted as scope** (proposal § Scope explicitly removes command declarations + handlers). Affected users see the binding become inert; root-row chevron collapse is the new minimize affordance. Call out in changelog. |
| R3 | Stronger divider color clashes with high-contrast themes. | LOW | Use `var(--vscode-widget-border)` which is HC-theme-aware. |

## Open Questions for Gate 1

See Gap Analysis G1–G3. Recommendations carried into Gate 1 question prompt: **A1, B1, C1**.
