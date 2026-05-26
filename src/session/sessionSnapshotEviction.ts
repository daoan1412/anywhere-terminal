// Pure eviction logic for the session snapshot index.
// Order: age cutoff → per-buffer cap → 20-most-recent cap (grouped by root tab).
// Split-pane children share their root tab's group: a 3-pane split occupies 3
// entries of the 20-budget but is kept/dropped atomically — partial-eviction
// of split groups would orphan layout leaves in the webview.
// See: asimov/changes/restore-terminal-sessions/design.md D5, D12 + round-1 B4.

import type { SessionSnapshotMetadata, SessionSnapshotsIndex } from "./SessionSnapshot";

export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_MAX_BUFFER_BYTES = 1_048_576;
export const SNAPSHOT_MAX_COUNT = 20;

export interface EvictResult {
  kept: SessionSnapshotsIndex;
  dropped: string[];
}

export function evictIndex(index: SessionSnapshotsIndex, now: number): EvictResult {
  const dropped: string[] = [];
  const remaining: Array<[string, SessionSnapshotMetadata]> = [];

  // Step 1 — per-entry caps (age + size).
  for (const [sessionId, meta] of Object.entries(index.entries)) {
    if (now - meta.snapshotAt >= SNAPSHOT_MAX_AGE_MS) {
      dropped.push(sessionId);
      continue;
    }
    if (meta.bufferBytes > SNAPSHOT_MAX_BUFFER_BYTES) {
      dropped.push(sessionId);
      continue;
    }
    remaining.push([sessionId, meta]);
  }

  // Step 2 — group surviving entries by rootTabId (treats unset/null as
  // self-grouped via fallback to sessionId).
  const groups = new Map<string, Array<[string, SessionSnapshotMetadata]>>();
  for (const entry of remaining) {
    const [sessionId, meta] = entry;
    const key = meta.rootTabId ?? sessionId;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(entry);
  }

  // Step 3 — sort groups by newest snapshotAt within the group (desc). A
  // tab + its split children are typically same-vintage so this ranks the
  // freshest tab unit first.
  const groupList: Array<{ key: string; latest: number; entries: Array<[string, SessionSnapshotMetadata]> }> = [];
  for (const [key, entries] of groups) {
    let latest = 0;
    for (const [, meta] of entries) {
      if (meta.snapshotAt > latest) latest = meta.snapshotAt;
    }
    groupList.push({ key, latest, entries });
  }
  groupList.sort((a, b) => b.latest - a.latest);

  // Step 4 — admit groups whole until the 20-entry budget is exhausted.
  // Spec: split-pane children "share the 20-snapshot budget but are NOT
  // independently capped". A group too large to fit gets dropped wholesale
  // (rare — would require >20 panes in one tab).
  const keptEntries: SessionSnapshotsIndex["entries"] = {};
  let kept = 0;
  for (const group of groupList) {
    if (kept + group.entries.length > SNAPSHOT_MAX_COUNT) {
      for (const [sessionId] of group.entries) dropped.push(sessionId);
      continue;
    }
    for (const [sessionId, meta] of group.entries) {
      keptEntries[sessionId] = meta;
    }
    kept += group.entries.length;
  }

  return { kept: { version: 1, entries: keptEntries }, dropped };
}
