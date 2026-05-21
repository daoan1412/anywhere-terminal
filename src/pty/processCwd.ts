// src/pty/processCwd.ts — Query a running process's cwd via the OS process table.
// See: asimov/changes/track-terminal-cwd/design.md D10
//
// Used as the authoritative "live cwd" source for local PTY sessions in the
// click-to-open resolver. Falls back silently to undefined on unsupported
// platforms, missing tools, or query errors — the caller is expected to
// continue with the next step in the resolution chain.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Hard cap on the macOS lsof shell-out so a hung/slow lsof can't stall clicks. */
const LSOF_TIMEOUT_MS = 500;

/** Injectable IO surface — used in tests to avoid touching real fs / child_process. */
export interface ProcessCwdDeps {
  readlink(path: string): Promise<string>;
  exec(file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }>;
  platform: NodeJS.Platform;
}

const defaultDeps: ProcessCwdDeps = {
  readlink: (p) => fs.readlink(p),
  exec: (file, args, options) =>
    execFileAsync(file, args, options).then(({ stdout, stderr }) => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    })),
  platform: process.platform,
};

/**
 * Return the current working directory of the process identified by `pid`,
 * or `undefined` when unavailable.
 *
 * Returns undefined for: invalid pids, dead processes, permission errors,
 * unsupported platforms (currently anything other than Linux + macOS), any
 * IO error from the underlying OS query, AND any returned value that does
 * not look like a valid absolute path (defensive — lsof can occasionally
 * print warnings to stdout, and Linux /proc/<pid>/cwd of a process whose
 * cwd was deleted reads as `<path> (deleted)`). Never throws.
 */
export async function queryProcessCwd(pid: number, deps: ProcessCwdDeps = defaultDeps): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  let raw: string | undefined;
  try {
    switch (deps.platform) {
      case "linux":
        raw = await deps.readlink(`/proc/${pid}/cwd`);
        break;
      case "darwin":
        raw = await queryDarwin(pid, deps);
        break;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
  return sanitize(raw);
}

/**
 * Apply a single validator to whatever the OS returned. Centralizes the
 * "is this string actually a usable absolute path?" question so both
 * platforms can't disagree. Returns undefined for anything suspicious so
 * the resolver falls through to the next step.
 */
function sanitize(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  // Linux /proc/<pid>/cwd appends " (deleted)" when the directory has been
  // removed under the process. Treating that as the cwd would resolve to a
  // ghost — fall through instead.
  if (raw.endsWith(" (deleted)")) {
    return undefined;
  }
  // Reject control bytes (NUL through US, plus DEL). Same rationale as
  // OSC parser sanitization: no legit cwd contains them, and they'd break
  // downstream `fs` APIs or mislead the modal.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — rejecting control chars in untrusted process-table output.
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    return undefined;
  }
  // POSIX-absolute or Windows-absolute. (Windows is currently unsupported
  // by the query itself, but be lenient here in case a future platform
  // branch produces a Windows path.)
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(raw)) {
    return undefined;
  }
  return raw;
}

async function queryDarwin(pid: number, deps: ProcessCwdDeps): Promise<string | undefined> {
  // `lsof -a -p <pid> -d cwd -Fn` produces output like:
  //   p<PID>
  //   fcwd
  //   n/Users/me/Projects/foo
  // We take the first line beginning with `n`. Validation (absolute path,
  // no control chars) happens in sanitize() — lsof can occasionally print
  // warning lines that begin with letters other than the documented field
  // markers, but it's cheap to belt-and-suspenders here.
  const { stdout } = await deps.exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    timeout: LSOF_TIMEOUT_MS,
  });
  for (const line of stdout.split("\n")) {
    if (line.length > 1 && line[0] === "n") {
      return line.slice(1).trim();
    }
  }
  return undefined;
}
