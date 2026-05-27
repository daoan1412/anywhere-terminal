// src/session/TrackedCommand.ts — In-memory record of an executed shell command.
//
// Built from OSC 633 markers (see src/pty/ShellIntegrationEvents.ts). The
// command list is owned by a TerminalSession (`commandTracking: CommandTracker`)
// and consumed by the export commands (exportLastCommand / exportCommand). See:
//   asimov/changes/export-terminal-session/specs/shell-integration-tracker/spec.md
//   asimov/changes/export-terminal-session/design.md D1, D2, D5
//   asimov/changes/export-terminal-session/.reviews/round-1.md [S1] (class promotion)
//   asimov/changes/export-terminal-session/.reviews/round-1.md [W2] (event reducer co-located)

import type { ShellIntegrationEvent } from "../pty/ShellIntegrationEvents";

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
   * Capped at MAX_OUTPUT_PER_COMMAND chars (see CommandTracker.appendOutput).
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
   * Character count (UTF-16 code units, matching JS `.length`) of output
   * observed for this command — increments on EVERY appended chunk even
   * after `output` hits the 100 KB cap. `outputChars - output.length`
   * equals the count of chars discarded by the cap. Allows the export UI
   * to communicate "X chars truncated". Not a true byte count (would
   * undercount for multi-byte UTF-8 input). See: .reviews/round-2.md [S2].
   */
  outputChars: number;
  /** Set to `true` if any output was discarded by the 100 KB cap. */
  outputTruncated: boolean;
}

/** Per-command output cap (chars; ~100 KB). */
export const MAX_OUTPUT_PER_COMMAND = 100_000;

/** Per-session commands list cap (entries). */
export const MAX_COMMANDS_PER_SESSION = 200;

/** Per-session aggregate output cap (chars; ~1 MB across all stored commands). */
export const MAX_TOTAL_OUTPUT_PER_SESSION = 1_000_000;

/** Context required to drive the OSC 633 reducer — injected for deterministic tests. */
export interface HandleEventContext {
  /** Wall-clock at event time. Production: `Date.now()`. */
  now: number;
  /** Current cwd to attach to a freshly-opened command. */
  cwd: string | null;
  /** UUID factory for new TrackedCommand.id values. Production: `crypto.randomUUID`. */
  idFactory: () => string;
}

/**
 * Per-session command list + in-flight slot + OSC 633 reducer.
 *
 * Replaces the prior FP-style POJO+module-functions API ([S1]) so the
 * encapsulation matches the rest of the session/ collaborators
 * (CustomNameRegistry, EditorPanelRegistry, SnapshotPersistence, OutputBuffer).
 * Owns the full state-transition vocabulary including `abandonInFlight` and
 * `handleEvent`, so SessionManager no longer needs to reach past the API to
 * reset in-flight on promptStart ([W2]).
 */
export class CommandTracker {
  private readonly _commands: TrackedCommand[] = [];
  private _inFlight: TrackedCommand | null = null;

  /**
   * Construct a tracker, optionally seeded from a persisted command list
   * (snapshot restore). Drops anything still in-flight at persist time — the
   * missing `D` marker means the command never completed and the invariant
   * `commands[i].endedAt !== null` would be violated. Defensively re-applies
   * the per-session caps in case the persisted list pre-dates a cap reduction.
   * Pass `undefined` (no persisted field) for a fresh tracker.
   */
  constructor(persisted?: readonly TrackedCommand[]) {
    if (!persisted || persisted.length === 0) {
      return;
    }
    for (const c of persisted) {
      if (c.endedAt === null) {
        continue;
      }
      // Defensive shallow copy so future mutations can't leak back into the
      // persisted reference.
      this._commands.push({ ...c });
    }
    this.evict();
  }

  /** Closed commands, oldest-first. Caller MUST NOT mutate. */
  get commands(): readonly TrackedCommand[] {
    return this._commands;
  }

  /** Current in-flight command, or null when no command is being captured. */
  get inFlight(): TrackedCommand | null {
    return this._inFlight;
  }

  /** Most-recently-closed command, or null. In-flight commands are skipped. */
  get lastCompleted(): TrackedCommand | null {
    if (this._commands.length === 0) {
      return null;
    }
    return this._commands[this._commands.length - 1];
  }

  /**
   * Process a parsed OSC event. Encapsulates the full A/B/C/D/E state machine
   * plus the `text` segment routing introduced by [B1]: text events between
   * OSC sequences feed `appendOutput` *in source order with* `commandStart` /
   * `commandEnd`, so a single PTY chunk containing `[output][D]` no longer
   * loses its output by closing the in-flight first. Callers handle `cwd`
   * separately (it has its own session-level sink). See: .reviews/round-1.md
   * [W2] + .reviews/round-2.md [B1].
   */
  handleEvent(event: ShellIntegrationEvent, ctx: HandleEventContext): void {
    switch (event.kind) {
      case "promptStart":
        this.abandonInFlight();
        return;
      case "commandStart":
        this.open({ id: ctx.idFactory(), now: ctx.now, cwd: ctx.cwd });
        return;
      case "commandLine":
        if (event.nonceValid) {
          this.setCommandLine(event.commandLine);
        }
        return;
      case "commandEnd":
        this.close({ exitCode: event.exitCode, now: ctx.now });
        return;
      case "text":
        // Parser-supplied text segment between OSC sequences. `appendOutput`
        // is a no-op when no command is in flight (prompt-rendering bytes /
        // pre-first-command output), so we never need to gate this externally.
        this.appendOutput(event.text);
        return;
      case "cwd":
        // cwd has its own session-level sink — tracker doesn't store cwd.
        return;
    }
  }

  /**
   * Open a new in-flight command. Idempotent: if a command is already in
   * flight, this is a no-op (matches the OSC 633 B/C dual-marker reality
   * where both can fire for the same execution).
   */
  open(params: { id: string; now: number; cwd: string | null }): void {
    if (this._inFlight) {
      return;
    }
    this._inFlight = {
      id: params.id,
      commandLine: "",
      output: "",
      exitCode: null,
      cwd: params.cwd,
      startedAt: params.now,
      endedAt: null,
      outputChars: 0,
      outputTruncated: false,
    };
  }

  /** Set the command-line text on the in-flight command, if one exists. */
  setCommandLine(commandLine: string): void {
    if (this._inFlight) {
      this._inFlight.commandLine = commandLine;
    }
  }

  /**
   * Append a data chunk to the in-flight command's `output`, enforcing the
   * per-command cap. Does nothing when there is no in-flight command.
   *
   * Append-time enforcement is mandatory: a never-closing command (e.g.
   * `cat /dev/urandom`) MUST NOT grow `output.length` past 100 KB even though
   * no `D` marker ever fires. Chars past the cap are counted in `outputChars`
   * (for UI reporting) and trigger `outputTruncated`.
   */
  appendOutput(data: string): void {
    const cmd = this._inFlight;
    if (!cmd) {
      return;
    }
    const charLen = data.length;
    cmd.outputChars += charLen;
    if (cmd.outputTruncated) {
      return; // Already over cap — don't append more.
    }
    const remaining = MAX_OUTPUT_PER_COMMAND - cmd.output.length;
    if (charLen <= remaining) {
      cmd.output += data;
      return;
    }
    if (remaining > 0) {
      cmd.output += data.slice(0, remaining);
    }
    cmd.outputTruncated = true;
  }

  /**
   * Close the in-flight command and evict per D5 rules. No-op if nothing is
   * in flight (e.g. a stray `D` marker without a preceding `B`/`C`).
   *
   * Commands with no `commandLine` AND no `output` are discarded — they carry
   * no information for the user and accumulate on every reload as the shell
   * repaints its prompt (B/D cycle without anyone typing). A real no-output
   * command (e.g. `cd /tmp`) still has its `commandLine` captured via the
   * `E` marker, so it stays.
   */
  close(params: { exitCode: number | null; now: number }): void {
    const cmd = this._inFlight;
    if (!cmd) {
      return;
    }
    this._inFlight = null;
    if (cmd.commandLine === "" && cmd.output === "") {
      return;
    }
    cmd.exitCode = params.exitCode;
    cmd.endedAt = params.now;
    this._commands.push(cmd);
    this.evict();
  }

  /**
   * Drop the in-flight command without closing — used on promptStart when a
   * prior command never closed (shell crash, lost D). Rare but observable.
   * Distinct from `close` because the dropped command is NOT pushed to the
   * commands list.
   */
  abandonInFlight(): void {
    this._inFlight = null;
  }

  /**
   * Enforce the per-session caps: MAX_COMMANDS_PER_SESSION entries OR
   * MAX_TOTAL_OUTPUT_PER_SESSION chars across all `output` strings. FIFO.
   */
  private evict(): void {
    while (this._commands.length > MAX_COMMANDS_PER_SESSION) {
      this._commands.shift();
    }
    let total = this.totalOutputSize();
    while (total > MAX_TOTAL_OUTPUT_PER_SESSION && this._commands.length > 0) {
      const dropped = this._commands.shift();
      if (dropped) {
        total -= dropped.output.length;
      }
    }
  }

  private totalOutputSize(): number {
    let sum = 0;
    for (const c of this._commands) {
      sum += c.output.length;
    }
    return sum;
  }
}
