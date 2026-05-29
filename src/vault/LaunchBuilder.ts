// src/vault/LaunchBuilder.ts — Synthesize a resume/fork launch as an argv array.
// See: specs/vault-session-launch/spec.md (Resume; Fork; Preserve Claude
//      auth/config; Injection-safe construction), design.md D5,D6,D9.
//
// Output is an argv array — `file` + `args[]` — never a shell string, so a
// session id/flag containing shell metacharacters (e.g. "a; rm -rf ~") is one
// inert argument and cannot inject a command (D9). The CLI re-reads its own
// session files; AT never parses the resumed transcript.

import { getAgentDefinition } from "./registry";
import type { AgentVaultDefinition, CommandTemplate, VaultSessionEntry } from "./types";

export type LaunchMode = "resume" | "fork";

export interface LaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  /** Per-session env override merged OVER the host env at spawn (D5/D6). */
  env: Record<string, string>;
}

export class VaultLaunchError extends Error {
  constructor(
    message: string,
    readonly code: "unknown-agent" | "no-fork-command" | "fork-unsupported" | "unknown-entry",
  ) {
    super(message);
    this.name = "VaultLaunchError";
  }
}

function substituteTokens(token: string, entry: VaultSessionEntry, executable: string): string {
  return token
    .replace(/\{\{sessionId\}\}/g, entry.sessionId)
    .replace(/\{\{sessionPath\}\}/g, "")
    .replace(/\{\{executable\}\}/g, executable);
}

function expandArgs(template: CommandTemplate, entry: VaultSessionEntry): string[] {
  const args: string[] = [];
  for (const part of template.args) {
    if (typeof part === "string") {
      args.push(substituteTokens(part, entry, template.executable));
      continue;
    }
    // Flag fragment: emit [flag, value] only when the captured value is present.
    const value = entry.flags[part.from];
    if (value === undefined || value === "") {
      continue;
    }
    args.push(part.flag);
    args.push(part.valueTemplate ? part.valueTemplate.replace(/\{\{value\}\}/g, value) : value);
  }
  return args;
}

/**
 * Quote one argv token for a readable, paste-safe POSIX command string. Simple
 * tokens (ids, flags, `key=value`) pass through unquoted; anything else is
 * single-quote wrapped (which neutralizes metacharacters). The result is COPIED
 * for the user to inspect/run — never executed by us.
 */
function shellQuoteArg(arg: string): string {
  if (arg === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=@-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Render the registry resume template (executable + captured flags) to a single
 * shell command string for "Copy Resume Command" (redesign-vault-panel-ui D9).
 * Reuses the same flag substitution as `build`.
 */
export function buildResumeCommandString(entry: VaultSessionEntry): string {
  const def = getAgentDefinition(entry.agent);
  if (!def) {
    throw new VaultLaunchError(`Unknown agent: ${entry.agent}`, "unknown-agent");
  }
  const template = def.resumeCommand;
  const args = expandArgs(template, entry);
  return [template.executable, ...args].map(shellQuoteArg).join(" ");
}

function buildClaudeEnv(
  def: AgentVaultDefinition,
  entry: VaultSessionEntry,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of def.authEnvAllowlist ?? []) {
    const value = hostEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // A configDir captured at index time overrides the host's (D6).
  if (entry.flags.configDir) {
    env.CLAUDE_CONFIG_DIR = entry.flags.configDir;
  }
  return env;
}

/**
 * Build the argv + env + cwd for resuming/forking `entry`. `hostEnv` is the
 * extension-host environment (typically `process.env`); only Claude's allowlist
 * is forwarded from it (D6) — other agents inherit the host env via the normal
 * spawn path, so their override is empty.
 */
export function build(
  entry: VaultSessionEntry,
  mode: LaunchMode,
  hostEnv: Record<string, string | undefined>,
): LaunchSpec {
  const def = getAgentDefinition(entry.agent);
  if (!def) {
    throw new VaultLaunchError(`Unknown agent: ${entry.agent}`, "unknown-agent");
  }
  const template = mode === "fork" ? def.forkCommand : def.resumeCommand;
  if (!template) {
    throw new VaultLaunchError(`Agent ${entry.agent} has no fork command`, "no-fork-command");
  }

  const env = def.id === "claude" ? buildClaudeEnv(def, entry, hostEnv) : {};

  return {
    file: template.executable,
    args: expandArgs(template, entry),
    cwd: entry.cwd,
    env,
  };
}
