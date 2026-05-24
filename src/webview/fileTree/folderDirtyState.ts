import type { GitStatus } from "../../types/messages";

export type FolderDirtyCounts = Partial<Record<GitStatus, number>>;

const PROPAGATING_SEVERITY: readonly GitStatus[] = ["conflicted", "modified", "renamed", "added", "untracked"];

export function dominantDirtyStatus(counts: FolderDirtyCounts | undefined): GitStatus | undefined {
  if (!counts) {
    return undefined;
  }
  for (const status of PROPAGATING_SEVERITY) {
    if ((counts[status] ?? 0) > 0) {
      return status;
    }
  }
  return undefined;
}
