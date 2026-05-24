# Spec Delta: folder-dirty-color

Severity-based color + larger-dot rendering for the folder dirty badge. Today the badge always uses `--vscode-gitDecoration-modifiedResourceForeground` (orange) regardless of which descendant statuses are present — a folder full of untracked files renders orange when VS Code Explorer renders green. This delta amends the propagation data model to track per-status descendant counts and amends the renderer to pick the highest-severity present status as the badge color.

## Requirements

### Per-status descendant counts on FileNode

`FileNode` SHALL carry a `dirtyDescendantCountsByStatus?: Partial<Record<GitStatus, number>>` field maintained by `FileSystemDataSource.applyStatusTransition`. Each key counts the number of descendants currently in that propagating status (`untracked`, `added`, `renamed`, `modified`, `deleted`-IS-NOT-propagating-here-per-D6, `conflicted`). The legacy `dirtyDescendantCount` field SHALL remain populated with the SUM of all bucket values so existing call sites + tests keep working.

`applyStatusTransition` transitions:

| prev status | next status | bucket delta |
|---|---|---|
| undefined or non-propagating | propagating P | `+1` on bucket `P` |
| propagating P | propagating P | (no change) |
| propagating A | propagating B (A≠B) | `-1` on bucket `A` AND `+1` on bucket `B` |
| propagating P | undefined or non-propagating | `-1` on bucket `P` |

Every bucket clamps at zero (defends against single-event drift). When a bucket reaches zero the key is deleted from the map. When the map becomes empty the field is set to `undefined` so the renderer's `if (counts)` guard short-circuits.

### Dominant-status helper

A helper SHALL exist (co-located with `FileSystemDataSource` or in a small new module under `src/webview/fileTree/`) that returns the highest-severity propagating status currently present in a `FolderDirtyCounts` map, or `undefined` when the map is empty. Severity order matches `gitStatusMapping.ts`:

```
conflicted > deleted > modified > renamed > added > untracked
```

Note: `deleted` is intentionally excluded from `isDirtyForPropagation` (per D6), so it cannot appear in the bucket map and never wins the "dominant" pick. Listed in the severity order above only to be explicit that the table is the same one host-side uses; the propagation filter is the gate.

### Renderer stamps per-status class on folder rows

`ReadOnlyFileRenderer.renderElement` SHALL, for folder rows (`element.kind === 'directory'`), compute the dominant status from `element.dirtyDescendantCountsByStatus` and stamp a single CSS class `git-folder-dirty-{status}` where `{status}` is the dominant key (e.g. `git-folder-dirty-untracked`). When no dominant status exists, no per-status class is stamped. The legacy `git-folder-dirty` class SHALL also be stamped whenever a dominant status exists, so existing CSS selectors that target the generic class (badge sizing, future global styles) keep working.

The badge text remains `•` for folders with any dirty descendant; only the row's CSS class set changes.

### CSS per-status colors + larger folder badge

`fileTreePanel.css` SHALL define one color rule per propagating status on the ROW selector (NOT just the badge) so the folder name AND the `•` badge both pick up the kind-matched colour — mirroring VS Code Explorer where a dirty folder's filename is tinted alongside its dot. The badge inherits via `color: inherit` from its row, so a single rule per kind suffices.

| Class | VS Code theme variable | Visual |
|---|---|---|
| `.file-tree-row.git-folder-dirty-untracked` | `--vscode-gitDecoration-untrackedResourceForeground` | green name + green dot |
| `.file-tree-row.git-folder-dirty-added` | `--vscode-gitDecoration-addedResourceForeground` (fallback to untracked) | green name + green dot |
| `.file-tree-row.git-folder-dirty-modified` | `--vscode-gitDecoration-modifiedResourceForeground` | orange name + orange dot |
| `.file-tree-row.git-folder-dirty-renamed` | `--vscode-gitDecoration-renamedResourceForeground` (fallback to modified) | orange name + orange dot |
| `.file-tree-row.git-folder-dirty-conflicted` | `--vscode-gitDecoration-conflictingResourceForeground` | red name + red dot |

The folder badge's `•` glyph SHALL render at a size visibly comparable to VS Code Explorer's badge — currently the badge font-size is `11px` (sized for the letter badges); the folder dot SHALL bump to `18px` so the dot reads clearly alongside file rows. Only the folder-dirty case bumps; file-row letter badges keep `11px`.

The existing generic `.file-tree-row.git-folder-dirty .git-badge { color: var(--vscode-gitDecoration-modifiedResourceForeground, ...) }` rule SHALL be removed (the per-status row rules replace it).

## Scenarios

### Folder with only untracked children renders green

GIVEN a workspace where `arco-contract/docs/` contains 3 untracked files and 0 modified/added/renamed/conflicted descendants
AND the data source's `nodeCache` has loaded these entries
WHEN the renderer paints the `docs` row
THEN the row's class list SHALL include `git-folder-dirty` AND `git-folder-dirty-untracked`
AND the badge text SHALL be `•`
AND the resolved row color (inherited by both `.name` and `.git-badge`) SHALL be `--vscode-gitDecoration-untrackedResourceForeground` (green)

### Folder with mixed children picks the highest severity

GIVEN a folder with 5 untracked, 2 modified, and 1 conflicted descendants
WHEN the renderer paints the row
THEN the row's class list SHALL include `git-folder-dirty-conflicted` and NOT `git-folder-dirty-modified` or `git-folder-dirty-untracked`
AND the resolved row color SHALL be `--vscode-gitDecoration-conflictingResourceForeground` (red) — applied to both the filename and the badge

### Dominant status downgrades when the highest-severity descendant clears

GIVEN a folder with 1 modified + 3 untracked descendants → class is `git-folder-dirty-modified`
WHEN the modified file transitions back to untracked (or any non-propagating state)
AND the next render fires
THEN the row's class SHALL be `git-folder-dirty-untracked`
AND the bucket map SHALL no longer contain the `modified` key

### Folder with no dirty descendants stamps neither class

GIVEN a folder with all-clean descendants (no propagating status anywhere in the subtree)
WHEN the renderer paints the row
THEN the row's class list SHALL contain NEITHER `git-folder-dirty` NOR any `git-folder-dirty-{status}` class
AND the badge SHALL be hidden (no `is-visible` class)
