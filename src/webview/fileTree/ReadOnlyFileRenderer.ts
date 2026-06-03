// src/webview/fileTree/ReadOnlyFileRenderer.ts — Read-only row renderer for
// the file-tree panel.
//
// Row DOM (both kinds — slots toggle via display:none):
//   <div class="file-tree-row" data-depth="<depth>" draggable="true">
//     <span class="chevron"></span>                  <!-- folder rows only -->
//     <span class="icon seti-file-icon" style="color:…">⟁</span>  <!-- file rows only -->
//     <span class="name">…</span>
//   </div>
//
// Per Seti convention (mirrored by VS Code's default icon theme):
//   - Folder rows show ONLY the chevron — no folder pictogram.
//   - File rows show ONLY the icon glyph — no chevron slot.
//   - At any depth, the first glyph of every row aligns vertically because
//     both chevron and icon are 16px wide and the row's padding-left is
//     `depth * 16px`.
//
// File icons are looked up via `resolveSetiIcon(name)` (vendored from
// microsoft/vscode @ release/1.96; original by jesseweed/seti-ui, MIT). The
// resolver returns a Unicode glyph + tint color; both are stamped per row.
//
// Drag-out: every row is `draggable="true"` and on `dragstart` sets three
// MIME types on the DataTransfer (custom + text/plain + text/uri-list) so
// the extension's `DragDropHandler` can disambiguate webview-origin drags
// from OS-Explorer drags and route the drop to the pane under the pointer
// (design D11; spec/file-tree-drag-to-terminal/spec.md).
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D8 + D11,
//      specs/file-tree-panel/spec.md#requirement-file-tree-panel-component

import type { GitStatus } from "../../types/messages";
import { resolveSetiIcon } from "../../vendor/seti/setiIconResolver";
import { dominantDirtyStatus, type FolderDirtyCounts } from "./folderDirtyState";
import type { FileNode } from "./IFileSystemProvider";
import type { ITemplateData, ITreeMatchData, ITreeRenderer } from "./ITreeRenderer";
import { renderHighlightedText } from "./search/renderHighlightedText";

/** All `git-*` row classes that may be applied; iterated to strip before re-stamp. */
const GIT_STATUS_CLASSES = [
  "git-modified",
  "git-added",
  "git-deleted",
  "git-renamed",
  "git-untracked",
  "git-conflicted",
  "git-ignored",
] as const;

/** Map from `GitStatus` to the single-letter file badge (folders use `•` separately). */
const STATUS_BADGE: Record<GitStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
  ignored: "",
};

/** Apply at most one `git-{status}` class to `row`, removing any previously-applied one. */
function applyGitClass(row: HTMLElement, status: GitStatus | undefined): void {
  for (const cls of GIT_STATUS_CLASSES) {
    row.classList.remove(cls);
  }
  if (status) {
    row.classList.add(`git-${status}`);
  }
}

/** Every per-kind folder-dirty class — iterated to strip stale ones on recycled rows. */
const FOLDER_DIRTY_KIND_CLASSES = [
  "git-folder-dirty-conflicted",
  "git-folder-dirty-modified",
  "git-folder-dirty-renamed",
  "git-folder-dirty-added",
  "git-folder-dirty-untracked",
] as const;

/**
 * Stamp the folder-dirty class set based on the highest-severity propagating
 * status currently present among descendants. Strips every prior variant
 * before stamping so recycled rows don't carry a stale color. Pass
 * `undefined` for file rows / non-dirty folders to clear everything.
 *
 * See: add-file-tree-fs-watcher/design.md D10.
 */
function applyFolderDirty(row: HTMLElement, counts: FolderDirtyCounts | undefined): void {
  for (const cls of FOLDER_DIRTY_KIND_CLASSES) {
    row.classList.remove(cls);
  }
  const dominant = dominantDirtyStatus(counts);
  if (dominant === undefined) {
    row.classList.remove("git-folder-dirty");
    return;
  }
  row.classList.add("git-folder-dirty");
  row.classList.add(`git-folder-dirty-${dominant}`);
}

/** Custom MIME type that authoritatively marks a drag as originating from this file tree. */
export const FILE_TREE_DRAG_MIME = "application/x-anywhere-terminal-file-tree-path";

/** Cached DOM references for a recycled file-tree row. */
export interface RowTemplate extends ITemplateData {
  row: HTMLElement;
  chevron: HTMLElement;
  icon: HTMLElement;
  name: HTMLElement;
  /**
   * Single-letter (or `•` for folders) git status badge. Always present in
   * the recycled DOM; `is-visible` toggles display + `textContent` carries
   * the letter. Never created/destroyed per render — honours the recycled-
   * row contract that the vendored listWidget relies on.
   */
  gitBadge: HTMLElement;
  /** Currently bound element — read by the row's dragstart listener. Null between renders. */
  currentElement: FileNode | null;
  /** Stable bound listener so disposeTemplate can detach cleanly. */
  onDragStart: (ev: DragEvent) => void;
  /** Stable bound listener so disposeTemplate can detach cleanly. */
  onContextMenu: (ev: MouseEvent) => void;
}

/**
 * Optional accessor the renderer uses to look up `gitStatus` for search-row
 * paths. Search rows have no direct git data on the search result — they
 * borrow whatever the data source already cached for the absolute path.
 * Returns undefined when the path has not been loaded (no badge then).
 *
 * See: asimov/changes/add-file-tree-git-decorations/design.md D13.
 */
export interface GitStatusLookup {
  getCachedNode(absPath: string): { gitStatus?: GitStatus } | undefined;
}

export interface ReadOnlyFileRendererOptions {
  onContextMenu?: (node: FileNode, ev: MouseEvent, row: HTMLElement) => void;
}

export class ReadOnlyFileRenderer implements ITreeRenderer<FileNode, RowTemplate> {
  public static readonly TEMPLATE_ID = "file-tree-row";

  public readonly templateId: string = ReadOnlyFileRenderer.TEMPLATE_ID;

  /**
   * Optional lookup the renderer uses to colour search-result rows by the
   * cached `FileNode.gitStatus` for the same absolute path. Pass `null` (or
   * omit) to render search rows without decorations.
   */
  constructor(
    private readonly statusLookup: GitStatusLookup | null = null,
    private readonly options: ReadOnlyFileRendererOptions = {},
  ) {}

  public renderTemplate(container: HTMLElement): RowTemplate {
    const doc = container.ownerDocument;
    const row = doc.createElement("div");
    row.className = "file-tree-row";
    // Every row is draggable. The dragstart listener pulls the bound element
    // from the template (kept in sync by renderElement) and sets the custom
    // MIME + text/plain + text/uri-list. See design D11.
    row.setAttribute("draggable", "true");

    const chevron = doc.createElement("span");
    chevron.className = "chevron";

    const icon = doc.createElement("span");
    icon.className = "icon";

    const name = doc.createElement("span");
    name.className = "name";

    // Git status badge — single span on every row, recycled across renders.
    // `is-visible` toggles `display`; the letter content drives appearance.
    const gitBadge = doc.createElement("span");
    gitBadge.className = "git-badge";

    row.appendChild(chevron);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(gitBadge);
    container.appendChild(row);

    const template: RowTemplate = {
      row,
      chevron,
      icon,
      name,
      gitBadge,
      currentElement: null,
      onDragStart: (ev: DragEvent) => {
        // Read late so the recycled row's current binding wins.
        const node = template.currentElement;
        if (!node || !ev.dataTransfer) {
          return;
        }
        ev.dataTransfer.setData(FILE_TREE_DRAG_MIME, node.path);
        ev.dataTransfer.setData("text/plain", node.path);
        ev.dataTransfer.setData("text/uri-list", encodeURI(`file://${node.path}`));
        ev.dataTransfer.effectAllowed = "copyLink";
      },
      onContextMenu: (ev: MouseEvent) => {
        const node = template.currentElement;
        if (!node || isNonActionSyntheticRow(node)) {
          return;
        }
        if (!this.options.onContextMenu) {
          return;
        }
        ev.preventDefault();
        this.options.onContextMenu(node, ev, row);
      },
    };

    row.addEventListener("dragstart", template.onDragStart);
    row.addEventListener("contextmenu", template.onContextMenu);

    return template;
  }

  public renderElement(element: FileNode, depth: number, template: RowTemplate, matchData?: ITreeMatchData): void {
    template.row.dataset.depth = String(depth);

    // Clear all search-row class variants up front so a recycled template
    // doesn't carry stale state from a prior render (search → normal tree).
    template.row.classList.remove(
      "is-search-row",
      "is-search-row--match",
      "is-search-row--non-match",
      "is-search-row--overflow-footer",
      "is-search-row--error",
    );

    if (element.searchRow) {
      this.renderSearchRow(element, template, matchData);
      template.currentElement = element;
      return;
    }

    // Indent step = chevron/icon (16) + flex gap (4) = 20px, so each deeper
    // level's leading glyph sits roughly under its parent's NAME first letter.
    template.row.style.paddingLeft = `${20 + depth * 20}px`;

    const isFile = element.kind === "file";

    // Slot visibility per Seti convention. `display:none` (via the
    // `chevron-hidden` / `icon-hidden` classes) collapses the slot so the
    // visible glyph sits flush against the depth-padding boundary.
    template.chevron.classList.toggle("chevron-hidden", isFile);
    template.icon.classList.toggle("icon-hidden", !isFile);
    // Tree rows are draggable; search rows are not (toggled inside `renderSearchRow`).
    template.row.setAttribute("draggable", "true");

    if (isFile) {
      const { char, color } = resolveSetiIcon(element.name);
      template.icon.classList.add("seti-file-icon");
      template.icon.textContent = char;
      template.icon.style.color = color;
    } else {
      // Folder — clear any prior file-row state (the row may be recycled).
      template.icon.classList.remove("seti-file-icon");
      template.icon.textContent = "";
      template.icon.style.color = "";
    }

    // Plain text — restore in case the row was previously a search row.
    template.name.replaceChildren();
    template.name.textContent = element.name;

    // Git status: single `git-{status}` row class + badge letter. Folders
    // additionally light up `git-folder-dirty` + a per-kind class
    // `git-folder-dirty-{status}` so the badge picks its color from the
    // highest-severity descendant status (refcount maintained by
    // FileSystemDataSource). See: add-file-tree-fs-watcher/design.md D10.
    applyGitClass(template.row, element.gitStatus);
    applyFolderDirty(template.row, isFile ? undefined : element.dirtyDescendantCountsByStatus);
    this.applyBadge(template, element, isFile);

    // Bind the element to the template so the dragstart listener can read it.
    template.currentElement = element;
  }

  /**
   * Stamp the badge span. Files get their per-status letter (M/A/D/R/U/C);
   * folders get `•` when they have dirty descendants. Otherwise hide the
   * span via the `is-visible` class.
   */
  private applyBadge(template: RowTemplate, element: FileNode, isFile: boolean): void {
    let text = "";
    if (isFile && element.gitStatus) {
      text = STATUS_BADGE[element.gitStatus];
    } else if (!isFile && dominantDirtyStatus(element.dirtyDescendantCountsByStatus) !== undefined) {
      text = "•";
    }
    template.gitBadge.textContent = text;
    template.gitBadge.classList.toggle("is-visible", text.length > 0);
  }

  /**
   * Render a synthetic search row (search results / overflow footer /
   * error marker). The flat-list layout omits the chevron + icon — the name
   * span spans the full row at zero indent.
   */
  private renderSearchRow(element: FileNode, template: RowTemplate, matchData: ITreeMatchData | undefined): void {
    const meta = element.searchRow;
    if (!meta) {
      return;
    }
    // Flat-list rows have no chevron and no icon — both slots collapse.
    template.chevron.classList.add("chevron-hidden");
    template.icon.classList.add("icon-hidden");
    template.icon.classList.remove("seti-file-icon");
    template.icon.textContent = "";
    template.icon.style.color = "";
    template.row.classList.add("is-search-row");
    template.row.style.paddingLeft = "8px";
    template.row.classList.add(`is-search-row--${meta.variant}`);
    // Folder-dirty propagation is meaningless in flat-list mode — clear it.
    applyFolderDirty(template.row, undefined);

    // Synthetic rows (overflow footer / error marker) are NOT draggable
    // and have no click target — the panel keyboard handler skips them.
    if (meta.variant === "overflow-footer" || meta.variant === "error") {
      template.row.setAttribute("draggable", "false");
    } else {
      template.row.setAttribute("draggable", "true");
    }

    // Decorate search match/non-match rows from the cached FileNode's
    // gitStatus (D13). Overflow/error rows get no decoration.
    let lookedUpStatus: GitStatus | undefined;
    if ((meta.variant === "match" || meta.variant === "non-match") && this.statusLookup) {
      lookedUpStatus = this.statusLookup.getCachedNode(element.path)?.gitStatus;
    }
    applyGitClass(template.row, lookedUpStatus);
    // For search rows we always treat the row as a file for badge purposes —
    // folder-dirty propagation isn't applicable in flat-list mode.
    this.applyBadge(template, { ...element, gitStatus: lookedUpStatus }, /* isFile */ true);

    // Clear the prior name content so we can re-build with text + spans.
    template.name.replaceChildren();
    if (meta.variant === "error") {
      template.name.textContent = meta.errorMessage ?? element.name;
      return;
    }
    if (meta.variant === "overflow-footer") {
      template.name.textContent = element.name;
      return;
    }
    // match / non-match — render the relativePath, highlighting matched
    // ranges when matchData is present. Non-matched rows show the path
    // dimmed via the `is-search-row--non-match` CSS class.
    renderHighlightedText(template.name, meta.relativePath, matchData?.matches);
  }

  public disposeTemplate(template: RowTemplate): void {
    // Detach the dragstart listener so the row's DOM is GC-able once the
    // parent listWidget recycles it away permanently.
    template.row.removeEventListener("dragstart", template.onDragStart);
    template.row.removeEventListener("contextmenu", template.onContextMenu);
    template.currentElement = null;
  }
}

function isNonActionSyntheticRow(node: FileNode): boolean {
  const variant = node.searchRow?.variant;
  return variant === "overflow-footer" || variant === "error";
}
