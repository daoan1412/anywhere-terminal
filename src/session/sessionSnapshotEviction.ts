// Pure eviction logic for the session snapshot index.
//
// All three caps (age, per-buffer size, 20-most-recent count) operate on
// ROOT-TAB GROUPS, not individual entries. A split-pane tab and its children
// share one group keyed by `rootTabId` — the group is kept or dropped
// atomically. Partial-evicting a split group would orphan layout leaves in
// the webview and violate the spec invariant "both index entries SHALL
// survive eviction together" (specs/cross-restart-session-restore/spec.md).
//
// Group-level semantics:
//   - Age: max(member.snapshotAt) — group is fresh if ANY member was recently
//     written. Round-2 [W1]: per-entry age would evict a dormant pane while
//     keeping its sibling.
//   - Size: drop the whole group if ANY member exceeds the per-buffer cap.
//     `truncateSnapshotBuffer` already caps writes at 1 MB, so this is a
//     safety net for corrupted state.
//   - Count: admit groups whole in newest-first order until the 20-entry
//     budget is exhausted; overflow groups are dropped wholesale.
//
// See: asimov/changes/restore-terminal-sessions/design.md D5, D12 + round-1 B4 + round-2 W1.

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

  // Step 1 — group all entries by rootTabId (treats unset/null as self-grouped
  // via fallback to sessionId).
  const groups = new Map<string, Array<[string, SessionSnapshotMetadata]>>();
  for (const [sessionId, meta] of Object.entries(index.entries)) {
    const key = meta.rootTabId ?? sessionId;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push([sessionId, meta]);
  }

  // Step 2 — drop groups failing the age OR per-buffer cap (atomic). Surviving
  // groups carry their max-snapshotAt for the count-budget ordering below.
  const surviving: Array<{ latest: number; entries: Array<[string, SessionSnapshotMetadata]> }> = [];
  for (const entries of groups.values()) {
    let latest = 0;
    let oversized = false;
    for (const [, meta] of entries) {
      if (meta.snapshotAt > latest) {
        latest = meta.snapshotAt;
      }
      if (meta.bufferBytes > SNAPSHOT_MAX_BUFFER_BYTES) {
        oversized = true;
      }
    }
    const aged = now - latest >= SNAPSHOT_MAX_AGE_MS;
    if (aged || oversized) {
      for (const [sessionId] of entries) {
        dropped.push(sessionId);
      }
      continue;
    }
    surviving.push({ latest, entries });
  }

  // Step 3 — sort groups by max snapshotAt (newest first).
  surviving.sort((a, b) => b.latest - a.latest);

  // Step 4 — admit groups whole until the 20-entry budget is exhausted.
  // Spec: split-pane children "share the 20-snapshot budget but are NOT
  // independently capped". A group too large to fit gets dropped wholesale
  // (rare — would require >20 panes in one tab).
  const keptEntries: SessionSnapshotsIndex["entries"] = {};
  let kept = 0;
  for (const group of surviving) {
    if (kept + group.entries.length > SNAPSHOT_MAX_COUNT) {
      for (const [sessionId] of group.entries) {
        dropped.push(sessionId);
      }
      continue;
    }
    for (const [sessionId, meta] of group.entries) {
      keptEntries[sessionId] = meta;
    }
    kept += group.entries.length;
  }

  return { kept: { version: 1, entries: keptEntries }, dropped };
}
