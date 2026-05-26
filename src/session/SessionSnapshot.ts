// Snapshot + live-panels schema persisted across VS Code restarts.
// Design: asimov/changes/restore-terminal-sessions/design.md D4, D12, D13.

import type { TrackedCommand } from "./TrackedCommand";

export const SESSION_SNAPSHOTS_INDEX_KEY = "anywhereTerminal.sessionSnapshots.index";
export const LIVE_EDITOR_PANELS_KEY = "anywhereTerminal.editorPanels.live";

export type ViewLocation = "sidebar" | "panel" | "editor";

export interface SessionSnapshotMetadata {
  sessionId: string;
  panelId?: string;
  viewLocation: ViewLocation;
  terminalNumber: number;
  customName: string | null;

  shell: string;
  shellArgs: string[];
  cwd: string;
  currentCwd: string | null;

  cols: number;
  rows: number;
  bufferFile: string;
  bufferBytes: number;

  isSplitPane: boolean;
  rootTabId: string | null;

  snapshotAt: number;
  shellExited: boolean;
  exitCode: number | null;

  /**
   * Tracked commands captured from OSC 633 markers, persisted so the
   * "Export Last Command…" / "Export Command…" pickers survive a window
   * reload (or full IDE restart). Only completed commands are persisted —
   * the in-flight command is dropped on shutdown because its `D` marker
   * never landed.
   *
   * Bounded by the same per-session caps applied at runtime
   * (MAX_COMMANDS_PER_SESSION + MAX_TOTAL_OUTPUT_PER_SESSION); see
   * `src/session/TrackedCommand.ts`. Stored inline in the index JSON so
   * the same atomic-rename pipeline that handles `bufferFile` covers it.
   *
   * Optional for back-compat: indexes written before this field landed
   * deserialize cleanly with `trackedCommands === undefined`.
   *
   * See: asimov/changes/export-terminal-session/design.md D6 (follow-up).
   */
  trackedCommands?: TrackedCommand[];
}

export interface SessionSnapshotsIndex {
  version: 1;
  entries: Record<string, SessionSnapshotMetadata>;
}

export interface LiveEditorPanelEntry {
  panelId: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface LiveEditorPanelsRecord {
  version: 1;
  panels: LiveEditorPanelEntry[];
}

// In-memory pending-restore payload: index entry plus its loaded buffer contents.
export interface PendingSnapshot {
  metadata: SessionSnapshotMetadata;
  buffer: string;
}
