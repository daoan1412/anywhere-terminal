// src/providers/gitStatusMapping.ts — Pure mapping from the built-in git
// extension's `Status` enum to our 7-case `GitStatus` union, with a
// highest-severity precedence picker for the case where the same path appears
// in multiple change arrays (e.g. INDEX_MODIFIED ∧ MODIFIED).
//
// See: asimov/changes/add-file-tree-git-decorations/design.md D2 — the mapping
// is an explicit approximation; out-of-band statuses (COPIED, INTENT_TO_*,
// submodule conflict variants) collapse to the nearest of the seven values.

import type { GitStatus } from "../types/messages";
import { Status } from "./git";

/**
 * Map one git extension `Status` enum value to our `GitStatus`. Pure; no state.
 *
 *   - Any `BOTH_*` / `ADDED_BY_*` / `DELETED_BY_*` → `conflicted`
 *   - `INDEX_*` and working-tree variants of the same shape map to the same
 *     `GitStatus` (we don't distinguish staged vs unstaged by colour).
 *   - `COPIED` → `added`, `TYPE_CHANGED` → `modified`,
 *     `INTENT_TO_ADD` → `added`, `INTENT_TO_RENAME` → `renamed`.
 */
export function mapStatus(s: Status): GitStatus {
  switch (s) {
    case Status.INDEX_MODIFIED:
    case Status.MODIFIED:
    case Status.TYPE_CHANGED:
      return "modified";

    case Status.INDEX_ADDED:
    case Status.INDEX_COPIED:
    case Status.INTENT_TO_ADD:
      return "added";

    case Status.INDEX_DELETED:
    case Status.DELETED:
      return "deleted";

    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return "renamed";

    case Status.UNTRACKED:
      return "untracked";

    case Status.IGNORED:
      return "ignored";

    case Status.ADDED_BY_US:
    case Status.ADDED_BY_THEM:
    case Status.DELETED_BY_US:
    case Status.DELETED_BY_THEM:
    case Status.BOTH_ADDED:
    case Status.BOTH_DELETED:
    case Status.BOTH_MODIFIED:
      return "conflicted";

    default:
      // Unknown future enum value — fall back to the safest signal that
      // something is different from HEAD.
      return "modified";
  }
}

const SEVERITY: Record<GitStatus, number> = {
  conflicted: 6,
  deleted: 5,
  modified: 4,
  renamed: 3,
  added: 2,
  untracked: 1,
  ignored: 0,
};

/**
 * Pick the highest-severity status when a single path appears under multiple
 * `Status` values (e.g. both staged-added and working-tree-modified). Order
 * matches D2: `conflicted > deleted > modified > renamed > added > untracked > ignored`.
 */
export function pickHigherSeverity(a: GitStatus, b: GitStatus): GitStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
