// src/webview/state/WebviewState.ts — Typed shape of the webview-persisted state.
//
// Replaces the historical `Record<string, unknown>` shape that `WebviewStateStore`
// wrote into `vscode.setState()`. Each top-level field is optional so older
// state objects (lacking the new `fileTree` block, etc.) restore cleanly without
// migration.
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D6,
//      specs/file-tree-panel/spec.md#requirement-state-persistence-schema

import type { FileTreePosition } from "../../types/messages";
import type { SplitNode } from "../SplitModel";

/** Per-tab persisted file-tree state. */
export interface FileTreeState {
  /** Whether the panel is currently shown. */
  open: boolean;
  /** Position relative to the terminal area. */
  position: FileTreePosition;
  /** Absolute paths of currently-expanded folders — used to restore tree state on reveal. */
  expandedPaths: string[];
  /**
   * Persisted panel size in CSS pixels along the layout's primary axis
   * (width for left/right, height for top/bottom). Optional — when absent,
   * the panel uses a position-dependent default (240 sides, 200 top/bottom).
   * Drag-resize via the sash boundary writes this back.
   */
  size?: number;
}

/** Where this webview is mounted — drives default file-tree position. */
export type TerminalLocationKey = "sidebar" | "panel" | "editor";

/**
 * Full typed shape of the webview-persisted state. Optional fields mean a
 * future revision (selection, scroll, sash size, customNames, …) can extend
 * this without breaking restore for users on the older shape.
 *
 * File-tree state is bucketed by location (`sidebar` / `panel` / `editor`)
 * because the same AnyWhere Terminal instance can be dragged between
 * locations and users naturally want different layouts in each — a panel
 * shape wants the tree on the right, a sidebar wants it at the bottom.
 * The legacy single `fileTree` slot is kept for back-compat reading; new
 * writes always go to `fileTreeByLocation`.
 */
export interface WebviewState {
  tabLayouts?: Record<string, SplitNode>;
  tabActivePaneIds?: Record<string, string>;
  /**
   * @deprecated — pre-bucketed shape. `WebviewStateStore.getState()` migrates
   * this slot into `fileTreeByLocation.sidebar` on first read and then writes
   * back with this field cleared, so consumers never observe it set. Kept on
   * the type so the migration logic remains type-safe; the only sites that
   * may set it are restore-from-persisted-blob (which immediately migrates)
   * and the migration's own pass-through writer. NEW code must not set it.
   */
  fileTree?: FileTreeState;
  fileTreeByLocation?: Partial<Record<TerminalLocationKey, FileTreeState>>;
}
