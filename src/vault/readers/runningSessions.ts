// src/vault/readers/runningSessions.ts — Enumerate LIVE Claude CLI sessions from
// the PID registry (`~/.claude/sessions/<pid>.json`), liveness-probed.
// See: specs/claude-running-session-map/spec.md "Detect running Claude sessions";
//      design.md D4; docs/research/20260601-claude-cli-running-detection-and-subagent-linkage.md §1a.
//
// Each registry file carries `{ pid, sessionId, cwd, startedAt, kind }`; only the
// base fields are relied on (the activity heartbeat is build-gated). A file whose
// pid is dead (ESRCH) is stale and skipped, exactly as Claude's own
// `isProcessRunning` decides liveness.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ClaudeReaderOptions, claudeRoots } from "./claudePaths";

export interface RunningClaudeSession {
  sessionId: string;
  cwd: string;
  pid: number;
  /** Launch time (epoch ms, `Date.now()` on disk); secondary tie-break only. */
  startedAt?: number;
}

/** Injectable liveness probe — kept separate from fs so tests stay process-free. */
export interface RunningSessionsDeps {
  /** `process.kill(pid, 0)` semantics: true when the process exists. */
  isAlive(pid: number): boolean;
}

const defaultDeps: RunningSessionsDeps = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH → no such process (stale). EPERM → exists but owned by another
      // user — still "alive" for our purposes (the local claude is same-user).
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

/** `~/.claude/sessions` — sibling of the projects root (same config-dir logic). */
function sessionsDir(options: ClaudeReaderOptions): string {
  const { projectsDir } = claudeRoots(options);
  return path.join(path.dirname(projectsDir), "sessions");
}

/**
 * Return one entry per LIVE Claude session. Files are matched strictly by
 * `<pid>.json` (Claude's own guard), parsed defensively (malformed skipped), and
 * kept only when the pid passes the liveness probe. Deduped by sessionId (a
 * resumed session rewrites its pid file in place; on the rare collision the entry
 * with the newer `startedAt` wins). Never throws — a missing dir yields `[]`.
 */
export async function listRunningClaudeSessions(
  options: ClaudeReaderOptions = {},
  deps: RunningSessionsDeps = defaultDeps,
): Promise<RunningClaudeSession[]> {
  const dir = sessionsDir(options);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // no registry dir → no running sessions
  }
  const bySession = new Map<string, RunningClaudeSession>();
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue; // strict guard (claude-code concurrentSessions.ts, #34210)
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // unreadable / malformed → skip, don't fail the scan
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
    const { sessionId, cwd } = parsed;
    if (!Number.isInteger(pid) || pid <= 0 || typeof sessionId !== "string" || typeof cwd !== "string") {
      continue;
    }
    if (!deps.isAlive(pid)) {
      continue; // stale (crashed/exited, ESRCH) → ignore
    }
    const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : undefined;
    const entry: RunningClaudeSession = { sessionId, cwd, pid, ...(startedAt !== undefined ? { startedAt } : {}) };
    const existing = bySession.get(sessionId);
    if (!existing || (startedAt ?? 0) > (existing.startedAt ?? 0)) {
      bySession.set(sessionId, entry);
    }
  }
  return [...bySession.values()];
}
