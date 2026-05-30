// src/pty/PtyManager.ts — Singleton for node-pty loading, shell detection, environment building, CWD resolution
// See: docs/design/pty-manager.md

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PtyLoadError } from "../types/errors";

// ─── node-pty Type Definitions ──────────────────────────────────────
// Minimal type interface for node-pty to avoid requiring the native package as a dev dependency.
// These match the subset of node-pty's API that we use.

/** Options for spawning a PTY process. */
export interface PtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/** A spawned PTY process. */
export interface Pty {
  /** The process ID. */
  readonly pid: number;
  /** The column count. */
  readonly cols: number;
  /** The row count. */
  readonly rows: number;
  /** Write data to the PTY. */
  write(data: string): void;
  /** Resize the PTY. */
  resize(columns: number, rows: number): void;
  /** Kill the PTY process. */
  kill(signal?: string): void;
  /** Pause the PTY (flow control). */
  pause(): void;
  /** Resume the PTY (flow control). */
  resume(): void;
  /** Register a data event handler. */
  onData: PtyEvent<string>;
  /** Register an exit event handler. */
  onExit: PtyEvent<{ exitCode: number; signal?: number }>;
}

/** Event handler registration function (returns a disposable). */
export type PtyEvent<T> = (listener: (e: T) => void) => { dispose(): void };

/** The node-pty module interface. */
export interface NodePtyModule {
  spawn(file: string, args: string[], options: PtyForkOptions): Pty;
}

// ─── node-pty Module Cache ──────────────────────────────────────────

/** Cached node-pty module — loaded once, reused across all sessions. */
let cachedNodePty: NodePtyModule | undefined;

// ─── Constants ──────────────────────────────────────────────────────

/** Candidate paths for node-pty within VS Code's installation, tried in order. */
const NODE_PTY_CANDIDATE_PATHS = ["node_modules.asar/node-pty", "node_modules/node-pty"] as const;

/**
 * Per-platform POSIX shell fallback chains. The final entry is the guaranteed
 * last-resort (`/bin/sh` always exists on POSIX systems).
 */
const SHELL_FALLBACK_CHAINS: Record<"darwin" | "linux", readonly string[]> = {
  darwin: ["/bin/zsh", "/bin/bash", "/bin/sh"],
  linux: ["/bin/bash", "/bin/sh"],
};

/** Windows last-resort shell when `%ComSpec%` is unset. */
const WINDOWS_DEFAULT_SHELL = "cmd.exe";

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Load node-pty from VS Code's internal modules.
 * Caches the module after first successful load.
 *
 * Returns the node-pty module with a `spawn` function.
 * We use a minimal type interface to avoid requiring the native node-pty package as a dev dependency.
 *
 * @throws {PtyLoadError} if node-pty cannot be found at any candidate path
 */
export function loadNodePty(): NodePtyModule {
  if (cachedNodePty) {
    return cachedNodePty;
  }

  const appRoot = vscode.env.appRoot;
  const attemptedPaths: string[] = [];

  for (const candidate of NODE_PTY_CANDIDATE_PATHS) {
    const fullPath = path.join(appRoot, candidate);
    attemptedPaths.push(fullPath);

    try {
      // Use module.require to bypass esbuild's require replacement.
      // esbuild replaces bare `require()` with `__require`, but `module.require`
      // is the real Node.js require function that can resolve external paths.
      const pty = module.require(fullPath);
      cachedNodePty = pty;
      return pty;
    } catch {
      // Try next candidate
    }
  }

  throw new PtyLoadError(attemptedPaths);
}

/**
 * Detect the user's preferred shell and arguments, platform-aware.
 *
 * Resolution order (first validated candidate wins):
 *   1. `vscodeShell` — VS Code's resolved default (honors `terminal.integrated.defaultProfile`
 *      and the remote extension host); skipped when empty.
 *   2. Platform env hint — `$SHELL` on POSIX, `%ComSpec%` on Windows.
 *   3. Platform fallback chain (POSIX only).
 *
 * When nothing validates, a last-resort default is returned unconditionally —
 * POSIX `/bin/sh`, Windows `%ComSpec%` else `cmd.exe` — so detection never throws
 * on supported platforms.
 *
 * `platform`/`env`/`vscodeShell` are injectable for cross-platform unit testing.
 */
export function detectShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  vscodeShell: string | undefined = vscode.env.shell,
): { shell: string; args: string[] } {
  const candidates: string[] = [];

  // 1. VS Code's already-resolved shell
  const vscodeShellCandidate = firstNonEmpty(vscodeShell);
  if (vscodeShellCandidate) {
    candidates.push(vscodeShellCandidate);
  }

  if (platform === "win32") {
    // 2. %ComSpec% (path to cmd.exe)
    const comspec = firstNonEmpty(env.ComSpec, env.COMSPEC);
    if (comspec) {
      candidates.push(comspec);
    }
  } else {
    // 2. $SHELL, then 3. POSIX fallback chain
    const envShell = firstNonEmpty(env.SHELL);
    if (envShell) {
      candidates.push(envShell);
    }
    candidates.push(...getPosixChain(platform));
  }

  for (const candidate of candidates) {
    if (validateShell(candidate, platform)) {
      return { shell: candidate, args: getShellArgs(candidate) };
    }
  }

  // Last resort — returned unconditionally (not validated, not thrown).
  const chain = getPosixChain(platform);
  const fallback =
    platform === "win32" ? (firstNonEmpty(env.ComSpec, env.COMSPEC) ?? WINDOWS_DEFAULT_SHELL) : chain[chain.length - 1];
  return { shell: fallback, args: getShellArgs(fallback) };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/** POSIX fallback chain for a platform, defaulting to the Linux chain for non-darwin/linux unices. */
function getPosixChain(platform: NodeJS.Platform): readonly string[] {
  return SHELL_FALLBACK_CHAINS[platform as "darwin" | "linux"] ?? SHELL_FALLBACK_CHAINS.linux;
}

/**
 * Build the environment variables for a new PTY process.
 * Clones process.env and adds terminal-specific overrides.
 *
 * Variables set: TERM, COLORTERM, LANG (if unset), TERM_PROGRAM, TERM_PROGRAM_VERSION.
 * Variables preserved (never overridden): PATH, HOME, SHELL.
 */
export function buildEnvironment(): Record<string, string> {
  // Clone process.env, filtering out undefined values for type safety.
  // process.env values are string | undefined; node-pty expects Record<string, string>.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Terminal type
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";

  // UTF-8 locale — only set if not already configured
  if (!env.LANG) {
    env.LANG = "en_US.UTF-8";
  }

  // Identify our terminal program
  env.TERM_PROGRAM = "AnyWhereTerminal";

  // Extension version
  const ext = vscode.extensions.getExtension("anywhere-terminal.anywhere-terminal");
  env.TERM_PROGRAM_VERSION = ext?.packageJSON?.version ?? "0.0.0";

  return env;
}

/**
 * Resolve the working directory for a new PTY process.
 * Priority: first workspace folder → os.homedir()
 */
export function resolveWorkingDirectory(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}

/**
 * Validate that a shell path points to a usable executable.
 *
 * POSIX: file exists, is a file, and has an execute bit.
 * Windows: file exists and is a file — Node does not expose reliable Unix
 * execute bits for Windows executables, so an execute-bit check would wrongly
 * reject valid `.exe` shells.
 */
export function validateShell(shellPath: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = fs.statSync(shellPath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Get default arguments for a shell, based on its basename.
 * Only login shells (zsh, bash) receive `--login`; sh and Windows shells
 * (cmd.exe, powershell.exe, pwsh.exe) receive none.
 */
function getShellArgs(shellPath: string): string[] {
  const basename = path.posix.basename(shellPath.replace(/\\/g, "/")).toLowerCase();
  const shellName = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
  if (shellName === "zsh" || shellName === "bash") {
    return ["--login"];
  }
  return [];
}

// ─── Test Helpers ───────────────────────────────────────────────────

/**
 * Reset the cached node-pty module. For testing only.
 * @internal
 */
export function _resetCache(): void {
  cachedNodePty = undefined;
}
