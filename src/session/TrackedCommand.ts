// src/session/TrackedCommand.ts — In-memory record of an executed shell command.
//
// Built from OSC 633 markers (see src/pty/ShellIntegrationEvents.ts). The
// command list is owned by a TerminalSession and consumed by the export
// commands (exportLastCommand / exportCommand). See:
//   asimov/changes/export-terminal-session/specs/shell-integration-tracker/spec.md
//   asimov/changes/export-terminal-session/design.md D1, D5

/** A single executed command + its output. */
export interface TrackedCommand {
  /** Stable identifier (UUIDv4). */
  id: string;
  /**
   * The shell command string, populated from a nonce-verified OSC 633 `E`
   * marker. Empty string when no `E` was seen (or the nonce failed).
   */
  commandLine: string;
  /**
   * Output bytes accumulated between `B`/`C` (commandStart) and `D`
   * (commandEnd). ANSI escapes preserved — stripping happens at export time.
   * Capped at MAX_OUTPUT_PER_COMMAND chars (see appendToCommandOutput).
   */
  output: string;
  /** Exit code from the `D` marker. `null` when D had no decimal arg, or D was malformed. */
  exitCode: number | null;
  /** Cwd at command-start time (copied from session.currentCwd). `null` if unknown. */
  cwd: string | null;
  /** ms-epoch when promptStart or commandStart fired (whichever was first). */
  startedAt: number;
  /** ms-epoch when `D` closed the command. `null` while in-flight. */
  endedAt: number | null;
  /**
   * True byte count of output observed for this command — increments on EVERY
   * appended chunk even after `output` hits the 100 KB cap. Allows the export
   * UI to communicate "X KB truncated".
   */
  outputBytes: number;
  /** Set to `true` if any output was discarded by the 100 KB cap. */
  outputTruncated: boolean;
}

/** Per-command output cap (chars; ~100 KB). */
export const MAX_OUTPUT_PER_COMMAND = 100_000;

/** Per-session commands list cap (entries). */
export const MAX_COMMANDS_PER_SESSION = 200;

/** Per-session aggregate output cap (chars; ~1 MB across all stored commands). */
export const MAX_TOTAL_OUTPUT_PER_SESSION = 1_000_000;

/** Mutable per-session runtime for command tracking. */
export interface CommandTrackingRuntime {
  /** Closed commands, oldest-first. */
  commands: TrackedCommand[];
  /** Current in-flight command, or null when no command is being captured. */
  inFlight: TrackedCommand | null;
}

export function createCommandTrackingRuntime(): CommandTrackingRuntime {
  return { commands: [], inFlight: null };
}

/**
 * Append a data chunk to the in-flight command's `output`, enforcing the
 * per-command cap. Does nothing when there is no in-flight command.
 *
 * Append-time enforcement is mandatory: a never-closing command (e.g.
 * `cat /dev/urandom`) MUST NOT grow `output.length` past 100 KB even though
 * no `D` marker ever fires. Bytes past the cap are counted in `outputBytes`
 * (for UI reporting) and trigger `outputTruncated`.
 */
export function appendToCommandOutput(runtime: CommandTrackingRuntime, data: string): void {
  const cmd = runtime.inFlight;
  if (!cmd) return;
  const byteLen = data.length;
  cmd.outputBytes += byteLen;
  if (cmd.outputTruncated) return; // Already over cap — don't append more.
  const remaining = MAX_OUTPUT_PER_COMMAND - cmd.output.length;
  if (byteLen <= remaining) {
    cmd.output += data;
    return;
  }
  if (remaining > 0) {
    cmd.output += data.slice(0, remaining);
  }
  cmd.outputTruncated = true;
}

/**
 * Open a new in-flight command. Idempotent: if a command is already in
 * flight, this is a no-op (matches the OSC 633 B/C dual-marker reality
 * where both can fire for the same execution).
 *
 * `now` and `id` are dependency-injected for deterministic tests.
 */
export function openCommand(runtime: CommandTrackingRuntime, params: { id: string; now: number; cwd: string | null }): void {
  if (runtime.inFlight) return;
  runtime.inFlight = {
    id: params.id,
    commandLine: "",
    output: "",
    exitCode: null,
    cwd: params.cwd,
    startedAt: params.now,
    endedAt: null,
    outputBytes: 0,
    outputTruncated: false,
  };
}

/** Set the command-line text on the in-flight command, if one exists. */
export function setInFlightCommandLine(runtime: CommandTrackingRuntime, commandLine: string): void {
  if (runtime.inFlight) {
    runtime.inFlight.commandLine = commandLine;
  }
}

/**
 * Close the in-flight command and evict per D5 rules. No-op if nothing is in
 * flight (e.g. a stray `D` marker without a preceding `B`/`C`).
 */
export function closeCommand(runtime: CommandTrackingRuntime, params: { exitCode: number | null; now: number }): void {
  const cmd = runtime.inFlight;
  if (!cmd) return;
  cmd.exitCode = params.exitCode;
  cmd.endedAt = params.now;
  runtime.commands.push(cmd);
  runtime.inFlight = null;
  evictPerSession(runtime);
}

/**
 * Enforce the per-session caps: MAX_COMMANDS_PER_SESSION entries OR
 * MAX_TOTAL_OUTPUT_PER_SESSION chars across all `output` strings. FIFO.
 */
function evictPerSession(runtime: CommandTrackingRuntime): void {
  while (runtime.commands.length > MAX_COMMANDS_PER_SESSION) {
    runtime.commands.shift();
  }
  while (totalOutputSize(runtime.commands) > MAX_TOTAL_OUTPUT_PER_SESSION && runtime.commands.length > 0) {
    runtime.commands.shift();
  }
}

function totalOutputSize(commands: readonly TrackedCommand[]): number {
  let sum = 0;
  for (const c of commands) sum += c.output.length;
  return sum;
}

/** Return the most-recently-closed command, or null. In-flight commands are skipped. */
export function lastCompleted(runtime: CommandTrackingRuntime): TrackedCommand | null {
  if (runtime.commands.length === 0) return null;
  return runtime.commands[runtime.commands.length - 1];
}
