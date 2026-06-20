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
   * True when this session's root process is an agent CLI (claude/codex/opencode)
   * launched from the vault, not a shell. Persisted so that after a window reload
   * re-spawns (auto-resumes) the agent, the session manager re-arms "fall back to
   * a shell on exit" — when the agent quits, the tab drops to a live shell prompt
   * instead of dying. Optional for back-compat: older indexes lack it and
   * deserialize as `undefined`/`false`.
   */
  isAgentLaunch?: boolean;

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

  /**
   * Forward-evolution slot — keys present in the persisted JSON that this
   * build does not recognise. Populated on load by sieving the raw metadata
   * against the known-key set; expanded back at the top level on persist so
   * a round-trip through an older build does not silently drop newer fields.
   *
   * Wire shape: a downgrade from `v(N+1)` to `v(N)` sees an entry like
   * `{ ..., experimentalFieldX: 42 }`. v(N) sieves `experimentalFieldX` into
   * `unknownFields`; on the next persist it expands back to the top level.
   * Re-upgrading to v(N+1) finds `experimentalFieldX: 42` intact.
   *
   * Always omitted from the type's persisted shape — `unknownFields` itself
   * is never written to disk; only its contents are spread at the top level.
   *
   * See: asimov/changes/export-terminal-session/.reviews/round-1.md [W3].
   */
  unknownFields?: Record<string, unknown>;
}

/**
 * Keys that this build defines as TOP-LEVEL persisted fields of
 * `SessionSnapshotMetadata`. Intentionally EXCLUDES `unknownFields` — the
 * in-memory carry-through slot is never written to disk under its own name
 * (only its contents are spread at the top level by `expandMetadataForPersist`).
 * A literal top-level `unknownFields` key in raw JSON therefore gets bucketed
 * into the sieve's `unknown` bag and re-spread on the next persist instead of
 * self-poisoning the slot. See: .reviews/round-2.md [W1].
 */
export const KNOWN_METADATA_KEYS: ReadonlySet<string> = new Set<keyof SessionSnapshotMetadata>([
  "sessionId",
  "panelId",
  "viewLocation",
  "terminalNumber",
  "customName",
  "shell",
  "shellArgs",
  "cwd",
  "currentCwd",
  "cols",
  "rows",
  "bufferFile",
  "bufferBytes",
  "isSplitPane",
  "rootTabId",
  "snapshotAt",
  "shellExited",
  "exitCode",
  "isAgentLaunch",
  "trackedCommands",
]);

/**
 * Sieve a raw parsed-from-JSON metadata object: keys present in
 * `KNOWN_METADATA_KEYS` pass through as-is; everything else is collected into
 * the returned `unknownFields` bucket. Used by the hydrate path to preserve
 * forward-evolution fields a downgrade doesn't recognise. See [W3].
 */
export function siftMetadataUnknownFields(raw: Record<string, unknown>): {
  known: Record<string, unknown>;
  unknownFields?: Record<string, unknown>;
} {
  const known: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  let hasUnknown = false;
  for (const k of Object.keys(raw)) {
    if (KNOWN_METADATA_KEYS.has(k)) {
      known[k] = raw[k];
    } else {
      unknown[k] = raw[k];
      hasUnknown = true;
    }
  }
  return hasUnknown ? { known, unknownFields: unknown } : { known };
}

/**
 * Reverse of `siftMetadataUnknownFields`: expand the `unknownFields` slot
 * back to the top level so the persisted JSON looks natural (the carry-
 * through layer is invisible on the wire). `unknownFields` itself is
 * always stripped from the output. See [W3].
 */
export function expandMetadataForPersist(meta: SessionSnapshotMetadata): Record<string, unknown> {
  const { unknownFields, ...rest } = meta;
  const restAsRecord = rest as unknown as Record<string, unknown>;
  if (!unknownFields) {
    return restAsRecord;
  }
  // Spread `rest` LAST so known fields beat any (broken) overlapping keys
  // that found their way into unknownFields.
  return { ...unknownFields, ...restAsRecord };
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
