// src/types/errors.ts — Custom error classes for AnyWhere Terminal
// See: docs/design/error-handling.md

// ─── Error Codes ────────────────────────────────────────────────────

/** Error code enum for programmatic error handling. String enum for runtime inspection. */
export enum ErrorCode {
  PtyLoadFailed = "PTY_LOAD_FAILED",
  ShellNotFound = "SHELL_NOT_FOUND",
  BufferOverflow = "BUFFER_OVERFLOW",
  ScrollbackDumpAborted = "SCROLLBACK_DUMP_ABORTED",
  ScrollbackDumpTimeout = "SCROLLBACK_DUMP_TIMEOUT",
}

// ─── Base Error ─────────────────────────────────────────────────────

/** Base class for all AnyWhere Terminal errors. */
export class AnyWhereTerminalError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
    this.name = "AnyWhereTerminalError";
  }
}

// ─── Specific Errors ────────────────────────────────────────────────

/** node-pty could not be loaded from VS Code's internals. */
export class PtyLoadError extends AnyWhereTerminalError {
  constructor(
    /** Paths that were attempted */
    public readonly attemptedPaths: string[],
  ) {
    super(`Could not load node-pty. Tried: ${attemptedPaths.join(", ")}`, ErrorCode.PtyLoadFailed);
    this.name = "PtyLoadError";
  }
}

/** No valid shell executable could be found. */
export class ShellNotFoundError extends AnyWhereTerminalError {
  constructor(
    /** Shells that were tried */
    public readonly attemptedShells: string[],
  ) {
    super(`No valid shell found. Tried: ${attemptedShells.join(", ")}`, ErrorCode.ShellNotFound);
    this.name = "ShellNotFoundError";
  }
}

/**
 * A pending `SessionManager.requestScrollbackDump()` was aborted because the
 * owning session was disposed before the webview replied. See:
 * asimov/changes/export-terminal-session/design.md D4.
 */
export class ScrollbackDumpAbortedError extends AnyWhereTerminalError {
  constructor(
    public readonly sessionId: string,
    public readonly requestId: string,
  ) {
    super(`Scrollback dump aborted (session ${sessionId} disposed)`, ErrorCode.ScrollbackDumpAborted);
    this.name = "ScrollbackDumpAbortedError";
  }
}

/**
 * A pending `SessionManager.requestScrollbackDump()` did not receive a webview
 * reply within the 15 s backstop. See:
 * asimov/changes/export-terminal-session/design.md D4.
 */
export class ScrollbackDumpTimeoutError extends AnyWhereTerminalError {
  constructor(
    public readonly sessionId: string,
    public readonly requestId: string,
  ) {
    super(`Scrollback dump timed out (session ${sessionId}, request ${requestId})`, ErrorCode.ScrollbackDumpTimeout);
    this.name = "ScrollbackDumpTimeoutError";
  }
}
