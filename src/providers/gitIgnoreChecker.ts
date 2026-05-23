// src/providers/gitIgnoreChecker.ts — Per-directory gitignore check via
// `git check-ignore`.
//
// VS Code's Explorer dims gitignored files. We mirror that behaviour by
// invoking `git check-ignore -z --stdin` per directory listing — git itself
// owns the rules (nested .gitignore, global excludes, .gitignore_global,
// etc.), so we get correct results without re-implementing the matcher.
// `-z` puts both stdin and stdout in NUL-delimited mode so filenames
// containing `\n` (legal on POSIX) are handled correctly.
//
// Spawn is bounded by a 1.5 s timeout — if git is missing, the workspace
// isn't a git repo, or the binary hangs, the call resolves to an empty set
// and the renderer simply doesn't dim anything. Errors are swallowed; this
// is decorative metadata, not load-bearing logic.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const TIMEOUT_MS = 1500;

/**
 * Return the subset of `absolutePaths` that git considers ignored relative
 * to `workspaceRoot`. Resolves to an empty set if git is not available, the
 * directory isn't a git repo, or the call times out.
 *
 * Caller MUST pass absolute paths; `git check-ignore` resolves them against
 * its cwd (which we set to `workspaceRoot`).
 */
export async function getIgnoredPaths(workspaceRoot: string, absolutePaths: readonly string[]): Promise<Set<string>> {
  if (absolutePaths.length === 0) {
    return new Set();
  }
  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      // `-z` switches both input AND output to NUL-delimited mode. Without it,
      // git splits stdin on newlines — which breaks filenames that legitimately
      // contain `\n` on POSIX filesystems (the annotation would silently fail
      // for those paths). Output also becomes NUL-delimited so we split that
      // way instead of on `\n`.
      proc = spawn("git", ["check-ignore", "-z", "--stdin"], {
        cwd: workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(new Set());
      return;
    }

    let stdout = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      resolve(new Set());
    }, TIMEOUT_MS);

    const finish = (paths: Set<string>) => {
      clearTimeout(timer);
      resolve(paths);
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.on("error", () => finish(new Set()));
    proc.on("close", (code) => {
      // Exit code 0 = some paths matched ignore rules.
      // Exit code 1 = no paths matched (NOT an error).
      // Any other code = real error (git missing, not a repo, etc.).
      if (code !== 0 && code !== 1) {
        finish(new Set());
        return;
      }
      const ignored = new Set<string>();
      for (const entry of stdout.split("\0")) {
        if (entry) {
          ignored.add(entry);
        }
      }
      finish(ignored);
    });

    // NUL-terminate every path and close stdin so git starts processing.
    proc.stdin.end(`${absolutePaths.join("\0")}\0`);
  });
}
