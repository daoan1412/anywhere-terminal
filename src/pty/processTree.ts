// src/pty/processTree.ts — Build a process tree from the OS process table and
// BFS-collect a pid's descendants. Used to find the `claude` node descendant of a
// terminal's pty so it can be matched to the running-session PID registry.
// See: design.md D4, D8; src/pty/processCwd.ts (OS-query precedent).
//
// The OS shell-out is split from the pure parse + BFS so the latter can be
// unit-tested on fixture text without spawning `ps`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Hard cap on the `ps` shell-out so a hung/slow ps can't stall a click. */
const PS_TIMEOUT_MS = 500;

/** Parse whitespace-separated `pid ppid` lines into a parent→children map. Pure. */
export function parseProcessTable(text: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) {
      continue; // header / blank / malformed line
    }
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    const siblings = children.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      children.set(ppid, [pid]);
    }
  }
  return children;
}

/** BFS-collect every descendant pid of `root` from a parent→children map. Pure. */
export function collectDescendants(root: number, table: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue: number[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of table.get(current) ?? []) {
      if (seen.has(child)) {
        continue; // cycle guard — defensive; a real process table is a forest
      }
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Injectable IO surface — mirrors `ProcessCwdDeps` so tests avoid real `ps`. */
export interface ProcessTreeDeps {
  exec(file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }>;
  platform: NodeJS.Platform;
}

const defaultDeps: ProcessTreeDeps = {
  exec: (file, args, options) =>
    execFileAsync(file, args, options).then(({ stdout, stderr }) => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    })),
  platform: process.platform,
};

/**
 * Return every descendant pid of `rootPid` on macOS/Linux. Returns `[]` for an
 * invalid pid, an unsupported platform (e.g. Windows), or any `ps` failure —
 * never throws (the caller degrades to the cwd fallbacks).
 */
export async function descendantPids(rootPid: number, deps: ProcessTreeDeps = defaultDeps): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }
  // Both invocations print a header-less two-column `pid ppid` table:
  //   macOS (BSD ps): `ps -axo pid=,ppid=`   Linux (procps): `ps -eo pid=,ppid=`
  let args: string[];
  switch (deps.platform) {
    case "darwin":
      args = ["-axo", "pid=,ppid="];
      break;
    case "linux":
      args = ["-eo", "pid=,ppid="];
      break;
    default:
      return []; // Windows / unsupported → no subtree; cwd fallbacks take over
  }
  let stdout: string;
  try {
    ({ stdout } = await deps.exec("ps", args, { timeout: PS_TIMEOUT_MS }));
  } catch {
    return []; // ps missing / timed out / errored → empty subtree
  }
  return collectDescendants(rootPid, parseProcessTable(stdout));
}
