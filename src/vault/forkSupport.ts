// src/vault/forkSupport.ts — OpenCode fork version gate.
// See: design.md (Risk Map: Fork on OpenCode), specs/vault-session-launch/spec.md
//      (Fork a session when supported).
//
// `opencode --fork` landed in v1.1.54 (commit 84c5df19c, 2026-02-06), so we probe
// `opencode --version` once and compare against the registry's `forkMinVersion`.
// Claude/Codex have no version gate (handled in VaultService).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VERSION_PROBE_TIMEOUT_MS = 2000;

export interface ForkSupportDeps {
  exec(file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }>;
}

const defaultDeps: ForkSupportDeps = {
  exec: (file, args, options) =>
    execFileAsync(file, args, { timeout: options.timeout }).then(({ stdout, stderr }) => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    })),
};

export type Semver = [number, number, number];

/** First `X.Y.Z` found in a string, e.g. "opencode 1.14.50" → [1,14,50]. */
export function parseFirstSemver(text: string): Semver | undefined {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return undefined;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `a` >= `b`. */
export function gte(a: Semver, b: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) {
      return true;
    }
    if (a[i] < b[i]) {
      return false;
    }
  }
  return true;
}

let opencodeForkPromise: Promise<boolean> | undefined;

/** Reset the memoized probe — tests only. */
export function __resetForkSupportCache(): void {
  opencodeForkPromise = undefined;
}

/**
 * Whether the installed `opencode` supports `--fork` (>= `minVersion`). Memoized;
 * any probe failure (missing binary, timeout, unparseable output) → false.
 */
export function canForkOpenCode(minVersion: string, deps: ForkSupportDeps = defaultDeps): Promise<boolean> {
  if (!opencodeForkPromise) {
    opencodeForkPromise = (async () => {
      const min = parseFirstSemver(minVersion);
      if (!min) {
        return false;
      }
      try {
        const { stdout, stderr } = await deps.exec("opencode", ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS });
        const found = parseFirstSemver(`${stdout} ${stderr}`);
        return found ? gte(found, min) : false;
      } catch {
        return false;
      }
    })();
  }
  return opencodeForkPromise;
}
