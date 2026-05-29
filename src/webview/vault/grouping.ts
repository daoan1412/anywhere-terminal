// src/webview/vault/grouping.ts — Pure client-side grouping for the vault list
// (redesign-vault-panel-ui D2). No DOM, no host round-trip — operates on the
// already-loaded entries so switching modes is instant.

import type { VaultSessionEntry } from "../../vault/types";
import { getAgentAccent, getAgentDisplayName, type VaultAccent } from "./agentIcons";

export type GroupMode = "recent" | "agent" | "folder";

export interface VaultGroup {
  /** Which mode produced this group. */
  mode: GroupMode;
  /** Stable group identity (agent id, full cwd, or "recent"). */
  key: string;
  /** Display label for the group header. */
  label: string;
  /** Agent accent for the header dot (Agent mode only). */
  accent?: VaultAccent;
  /** Whether the cwd chip should be suppressed on rows (Folder mode). */
  hideCwd: boolean;
  entries: VaultSessionEntry[];
}

function byModifiedDesc(a: VaultSessionEntry, b: VaultSessionEntry): number {
  return b.modified - a.modified;
}

/** Last path segment for a Folder-group label. */
function folderLabel(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed || cwd;
}

/**
 * Group `entries` for the given mode. Recent → one flat group ordered by
 * modified desc. Agent → grouped by `agent`. Folder → grouped by `cwd` (chip
 * suppressed). Non-Recent groups are ordered by their newest entry (desc), and
 * entries within every group are ordered by modified desc.
 */
export function groupEntries(entries: VaultSessionEntry[], mode: GroupMode): VaultGroup[] {
  const sorted = [...entries].sort(byModifiedDesc);

  if (mode === "recent") {
    return [{ mode, key: "recent", label: "", hideCwd: false, entries: sorted }];
  }

  const buckets = new Map<string, VaultSessionEntry[]>();
  for (const entry of sorted) {
    const key = mode === "agent" ? entry.agent : entry.cwd;
    const list = buckets.get(key);
    if (list) {
      list.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }

  const groups: VaultGroup[] = [];
  for (const [key, groupEntriesList] of buckets) {
    groups.push(
      mode === "agent"
        ? {
            mode,
            key,
            label: getAgentDisplayName(key) ?? key,
            accent: getAgentAccent(key),
            hideCwd: false,
            entries: groupEntriesList,
          }
        : { mode, key, label: folderLabel(key), hideCwd: true, entries: groupEntriesList },
    );
  }

  // Order groups by their newest entry (the buckets already hold modified-desc
  // entries, so entries[0] is each group's newest).
  groups.sort((a, b) => (b.entries[0]?.modified ?? 0) - (a.entries[0]?.modified ?? 0));
  return groups;
}
