// src/pty/ShellIntegrationInjector.ts — Per-shell injection of VS Code's
// MIT-licensed shell-integration scripts at PTY spawn time.
//
// See:
//   asimov/changes/export-terminal-session/specs/shell-integration-tracker/spec.md
//   asimov/changes/export-terminal-session/design.md D3
//
// Mirrors VS Code's `src/vs/platform/terminal/node/terminalEnvironment.ts`:
//   bash → --init-file <temp>/shellIntegration.bash
//   zsh  → ZDOTDIR=<temp>, USER_ZDOTDIR=<original> with 4 sourced scripts
//   fish → --init-command "source <ext>/shellIntegration.fish"
//   pwsh → -noexit -command ". '<ext>/shellIntegration.ps1'"

import * as path from "node:path";

/** Filesystem contract — narrow on purpose so tests can stub it without `node:fs`. */
export interface InjectorFs {
  mkdirSync(target: string, options: { recursive?: boolean; mode?: number }): void;
  copyFileSync(src: string, dst: string): void;
  rmSync(target: string, options: { recursive?: boolean; force?: boolean }): void;
}

/** Dependencies injected by SessionManager (or tests). */
export interface InjectionContext {
  /** Absolute path to the directory containing the vendored scripts. */
  scriptsDir: string;
  /** Directory to host per-session temp dirs (e.g. `os.tmpdir()`). */
  tmpRoot: string;
  /** Generate a unique UUID for the nonce + per-session temp-dir suffix. */
  generateId: () => string;
  /** Filesystem operations. Injectable for tests; production uses `node:fs`. */
  fs: InjectorFs;
}

/** Result returned to the spawn site. */
export interface InjectionResult {
  /** Args to pass to `node-pty.spawn` (prepended / mutated as per shell). */
  args: string[];
  /** Env to pass to `node-pty.spawn` (additions only — never overwrites `TERM_PROGRAM`). */
  env: Record<string, string>;
  /** Per-session nonce — feed to `OscParser.setNonce` so `E` markers validate. */
  nonce: string;
  /** Tear-down callback. Caller MUST invoke on session dispose; idempotent. */
  cleanup: () => void;
}

const NOOP_CLEANUP = (): void => {};

/**
 * Inject shell-integration for the given shell. Returns `null` when the shell
 * binary is unrecognised (no integration available) — the spawn site MUST
 * proceed with the original args/env in that case.
 *
 * The per-session nonce is added to `env` as `VSCODE_NONCE=<uuid>`. The
 * vendored E-emitting scripts include this nonce on every `E` marker; the
 * parser side compares and rejects forged E markers from untrusted output.
 *
 * `TERM_PROGRAM` is intentionally NOT touched here — it is set to
 * `AnyWhereTerminal` upstream by `PtyManager.buildEnvironment`, and double-
 * setting `VSCODE_INJECTION=1` would cause user `.bashrc` snippets that
 * auto-source the integration script to fire a second time, producing
 * duplicate OSC 633 markers (see design F2 / oracle finding F2).
 */
export function injectShellIntegration(
  shellPath: string,
  baseArgs: readonly string[],
  baseEnv: Readonly<Record<string, string>>,
  ctx: InjectionContext,
): InjectionResult | null {
  // Normalise both forward and backslash separators so Windows-style paths
  // (e.g. `C:\Program Files\PowerShell\7\pwsh.exe`) basename correctly on
  // POSIX hosts (where node's `path.basename` doesn't split on backslash).
  const normalised = shellPath.replace(/\\/g, "/");
  const shellName = path.basename(normalised).toLowerCase();
  const argsMutable = [...baseArgs];

  if (shellName === "bash") {
    if (hasArg(argsMutable, "--noprofile") && hasArg(argsMutable, "--norc")) {
      // User explicitly disabled rc loading — respect that.
      return null;
    }
    return injectBash(argsMutable, baseEnv, ctx);
  }

  if (shellName === "zsh") {
    return injectZsh(argsMutable, baseEnv, ctx);
  }

  if (shellName === "fish") {
    return injectFish(argsMutable, baseEnv, ctx);
  }

  if (shellName === "pwsh" || shellName === "pwsh.exe") {
    // Case-insensitive `-NoProfile` (pwsh parameter parsing is case-insensitive).
    if (argsMutable.some((a) => a.toLowerCase() === "-noprofile")) {
      return null;
    }
    return injectPwsh(argsMutable, baseEnv, ctx);
  }

  // Unrecognised shell (sh, dash, cmd.exe, nu, custom binary) — no injection.
  return null;
}

// ─── bash ───────────────────────────────────────────────────────────

function injectBash(args: string[], baseEnv: Readonly<Record<string, string>>, ctx: InjectionContext): InjectionResult {
  const nonce = ctx.generateId();
  const tempDir = path.join(ctx.tmpRoot, `at-bash-${ctx.generateId()}`);
  ctx.fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const initFile = path.join(tempDir, "shellIntegration.bash");
  ctx.fs.copyFileSync(path.join(ctx.scriptsDir, "shellIntegration-bash.sh"), initFile);
  const newArgs = ["--init-file", initFile, ...args];
  return {
    args: newArgs,
    env: { ...baseEnv, VSCODE_NONCE: nonce },
    nonce,
    cleanup: makeTempDirCleanup(ctx, tempDir),
  };
}

// ─── zsh ────────────────────────────────────────────────────────────

function injectZsh(args: string[], baseEnv: Readonly<Record<string, string>>, ctx: InjectionContext): InjectionResult {
  const nonce = ctx.generateId();
  const tempDir = path.join(ctx.tmpRoot, `at-zsh-${ctx.generateId()}`);
  ctx.fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  // Map vendored filenames → zsh expected names inside ZDOTDIR.
  const mapping: Array<[string, string]> = [
    ["shellIntegration-env.zsh", ".zshenv"],
    ["shellIntegration-profile.zsh", ".zprofile"],
    ["shellIntegration-rc.zsh", ".zshrc"],
    ["shellIntegration-login.zsh", ".zlogin"],
  ];
  for (const [src, dst] of mapping) {
    ctx.fs.copyFileSync(path.join(ctx.scriptsDir, src), path.join(tempDir, dst));
  }
  // Preserve the user's original ZDOTDIR so the chained scripts can source it.
  // `baseEnv.ZDOTDIR` (if present) takes priority over `HOME` (zsh default).
  const userZdotdir = baseEnv.ZDOTDIR ?? "";
  return {
    args,
    env: {
      ...baseEnv,
      ZDOTDIR: tempDir,
      USER_ZDOTDIR: userZdotdir,
      VSCODE_NONCE: nonce,
    },
    nonce,
    cleanup: makeTempDirCleanup(ctx, tempDir),
  };
}

// ─── fish ───────────────────────────────────────────────────────────

function injectFish(args: string[], baseEnv: Readonly<Record<string, string>>, ctx: InjectionContext): InjectionResult {
  const nonce = ctx.generateId();
  const scriptPath = path.join(ctx.scriptsDir, "shellIntegration.fish");
  const newArgs = ["--init-command", `source ${shellQuote(scriptPath)}`, ...args];
  return {
    args: newArgs,
    env: { ...baseEnv, VSCODE_NONCE: nonce },
    nonce,
    cleanup: NOOP_CLEANUP,
  };
}

// ─── pwsh ───────────────────────────────────────────────────────────

function injectPwsh(args: string[], baseEnv: Readonly<Record<string, string>>, ctx: InjectionContext): InjectionResult {
  const nonce = ctx.generateId();
  const scriptPath = path.join(ctx.scriptsDir, "shellIntegration.ps1");
  // pwsh `-command` requires a string; dot-source operator is `. 'path'`.
  // Single-quote escaping inside PowerShell single-quoted strings: `'` → `''`.
  const psQuoted = scriptPath.replace(/'/g, "''");
  const newArgs = ["-noexit", "-command", `. '${psQuoted}'`, ...args];
  return {
    args: newArgs,
    env: { ...baseEnv, VSCODE_NONCE: nonce },
    nonce,
    cleanup: NOOP_CLEANUP,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function hasArg(args: readonly string[], needle: string): boolean {
  return args.includes(needle);
}

/** POSIX shell single-quote escape: ' → '\'' */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function makeTempDirCleanup(ctx: InjectionContext, target: string): () => void {
  let done = false;
  return (): void => {
    if (done) return;
    done = true;
    try {
      ctx.fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Cleanup failures are non-fatal; OS temp cleanup will reclaim.
    }
  };
}
