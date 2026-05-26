// Snapshot + live-panels schema persisted across VS Code restarts.
// Design: asimov/changes/restore-terminal-sessions/design.md D4, D12, D13.

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
