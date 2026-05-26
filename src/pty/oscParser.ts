// src/pty/oscParser.ts — Passive OSC 7 / OSC 633 parser.
//
// Parses cwd reports (OSC 7 + OSC 633;P;Cwd=) plus VS Code shell-integration
// markers (OSC 633;A/B/C/D/E) and emits them as structured events.
//
// See:
//   asimov/specs/terminal-cwd-tracking/spec.md
//   asimov/specs/shell-integration-tracker/spec.md
//   asimov/changes/export-terminal-session/design.md D2

import * as path from "node:path";
import type { ShellIntegrationEvent, ShellIntegrationSink } from "./ShellIntegrationEvents";

/** Maximum buffer size before truncation. */
const MAX_PENDING = 4096;

/** Bytes retained after MAX_PENDING overflow (room for a fresh ESC ] to start). */
const TRUNCATE_TO = 128;

/** Pure-state OSC parser. One instance per PtySession. */
export interface OscParser {
  /** Feed a chunk of PTY output. Invokes `onEvent` once per recognised escape sequence. */
  feed(chunk: string, onEvent: ShellIntegrationSink): void;
  /**
   * Set the per-session nonce used to validate OSC 633 `E` markers. `E`
   * markers carrying a mismatching (or missing) nonce produce a
   * `commandLine` event with `nonceValid: false`. Pass `undefined` to
   * disable validation (legacy / no integration).
   */
  setNonce(nonce: string | undefined): void;
}

/**
 * Create a new OSC parser instance.
 *
 * Maintains a pending buffer across feed() calls so escape sequences split
 * across chunks are detected correctly. The buffer is bounded at MAX_PENDING
 * bytes; on overflow the open OSC is discarded and scanning resumes at the
 * next ESC ] boundary.
 */
export function createOscParser(): OscParser {
  let pending = "";
  let nonce: string | undefined;

  return {
    setNonce(n: string | undefined): void {
      nonce = n;
    },
    feed(chunk: string, onEvent: ShellIntegrationSink): void {
      pending += chunk;
      if (pending.length > MAX_PENDING) {
        pending = pending.slice(-TRUNCATE_TO);
      }

      let i = 0;
      while (true) {
        const escIdx = pending.indexOf("\x1b]", i);
        if (escIdx === -1) {
          pending = pending.slice(-1);
          return;
        }

        const afterEsc = escIdx + 2;
        let p = afterEsc;
        while (p < pending.length && pending[p] >= "0" && pending[p] <= "9") {
          p++;
        }

        if (p === afterEsc) {
          if (p >= pending.length) {
            pending = pending.slice(escIdx);
            return;
          }
          i = escIdx + 1;
          continue;
        }

        if (p >= pending.length) {
          pending = pending.slice(escIdx);
          return;
        }

        if (pending[p] !== ";") {
          i = escIdx + 1;
          continue;
        }

        const oscNum = pending.slice(afterEsc, p);
        const payloadStart = p + 1;

        let termIdx = -1;
        let termLen = 0;
        let q = payloadStart;
        let needMore = false;
        while (q < pending.length) {
          const c = pending[q];
          if (c === "\x07") {
            termIdx = q;
            termLen = 1;
            break;
          }
          if (c === "\x1b") {
            if (q + 1 >= pending.length) {
              needMore = true;
              break;
            }
            if (pending[q + 1] === "\\") {
              termIdx = q;
              termLen = 2;
              break;
            }
          }
          q++;
        }

        if (needMore) {
          pending = pending.slice(escIdx);
          return;
        }

        if (termIdx === -1) {
          pending = pending.slice(escIdx);
          return;
        }

        const payload = pending.slice(payloadStart, termIdx);

        if (oscNum === "7") {
          handleOsc7(payload, onEvent);
        } else if (oscNum === "633") {
          handleOsc633(payload, onEvent, nonce);
        }
        // Other OSC numbers (0 title, 8 hyperlink, 52 clipboard, 1337 iTerm,
        // etc.) are silently skipped.

        i = termIdx + termLen;
      }
    },
  };
}

/** OSC 7 payload: a file:// URL. */
function handleOsc7(payload: string, onEvent: ShellIntegrationSink): void {
  let decoded: string;
  try {
    const url = new URL(payload);
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return;
  }
  emitCwdIfValid(decoded, onEvent);
}

/**
 * OSC 633 sub-command dispatch.
 *
 * Sub-commands recognised:
 *   A           prompt start
 *   B, C        command-input end / output start (commandStart)
 *   D[;<code>]  command finished, with optional decimal exit code
 *   E;<cmd>[;<nonce>]  explicit command line (semicolons in cmd are escaped `\x3b`)
 *   P;Cwd=<v>   cwd report (only P sub-property handled today)
 *
 * Any other sub-command (e.g. P;Prompt=, P;IsWindows=, P;ContinuationPrompt=,
 * unknown letters) is silently ignored.
 */
function handleOsc633(payload: string, onEvent: ShellIntegrationSink, nonce: string | undefined): void {
  if (payload.length === 0) return;

  // Split off the sub-command letter. `;` separates fields; payload[0] is the
  // sub-command. For `A`/`B`/`C` the payload is exactly one char (or `A;...`).
  const subCmd = payload[0];

  if (subCmd === "A") {
    onEvent({ kind: "promptStart" });
    return;
  }
  if (subCmd === "B" || subCmd === "C") {
    onEvent({ kind: "commandStart" });
    return;
  }
  if (subCmd === "D") {
    // `D` or `D;<code>`
    if (payload.length === 1) {
      onEvent({ kind: "commandEnd", exitCode: null });
      return;
    }
    if (payload[1] !== ";") return; // malformed; drop
    const arg = payload.slice(2);
    const parsed = parseExitCode(arg);
    onEvent({ kind: "commandEnd", exitCode: parsed });
    return;
  }
  if (subCmd === "E") {
    if (payload.length < 2 || payload[1] !== ";") return;
    // Split at most into [E, escaped-cmd, optional-nonce]. Embedded `;` in cmd
    // is encoded as `\x3b` (literal 4-char) by VS Code's __vsc_escape_value,
    // so a raw `;` split is safe.
    const rest = payload.slice(2);
    const sepIdx = rest.lastIndexOf(";");
    let escapedCmd: string;
    let suppliedNonce: string | undefined;
    if (sepIdx >= 0) {
      escapedCmd = rest.slice(0, sepIdx);
      suppliedNonce = rest.slice(sepIdx + 1);
    } else {
      escapedCmd = rest;
      suppliedNonce = undefined;
    }
    const commandLine = unescapeOscValue(escapedCmd);
    const nonceValid = nonce !== undefined && suppliedNonce === nonce;
    onEvent({ kind: "commandLine", commandLine, nonceValid });
    return;
  }
  if (subCmd === "P") {
    handleOsc633P(payload, onEvent);
    return;
  }
  // Unknown sub-command — ignore.
}

/** OSC 633 P sub-command: property report. Only Cwd= is consumed. */
function handleOsc633P(payload: string, onEvent: ShellIntegrationSink): void {
  // payload starts with "P;<key>=<value>" or "P;<key>".
  if (!payload.startsWith("P;")) return;
  const body = payload.slice(2);
  const eqIdx = body.indexOf("=");
  if (eqIdx === -1) return;
  const key = body.slice(0, eqIdx);
  const value = body.slice(eqIdx + 1);
  if (key === "Cwd") {
    emitCwdIfValid(unescapeOscValue(value), onEvent);
  }
  // Other properties (Prompt, IsWindows, ContinuationPrompt, etc.) ignored.
}

/** Parse VS Code exit-code argument: decimal integer; non-numeric → null. */
function parseExitCode(s: string): number | null {
  if (s.length === 0) return null;
  // Allow optional leading '-' for negative codes (signals).
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Undo VS Code's `__vsc_escape_value` encoding:
 *   - `\\` → `\`
 *   - `\xNN` → byte 0xNN (hex pair)
 *
 * Order matters: `\\` must be processed before `\xNN` because the doubled
 * backslash is itself part of the escape grammar. We walk left-to-right.
 */
function unescapeOscValue(s: string): string {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const next = s[i + 1];
    if (next === "\\") {
      out += "\\";
      i++;
      continue;
    }
    if (next === "x" && i + 3 < s.length) {
      const hex = s.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    // Unknown escape — keep literal backslash.
    out += c;
  }
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — rejecting control chars in untrusted PTY-emitted cwds is the whole point.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Apply D3 sanitization and emit a cwd event. */
function emitCwdIfValid(decoded: string, onEvent: ShellIntegrationSink): void {
  if (!path.isAbsolute(decoded)) return;
  let normalized: string;
  try {
    normalized = path.resolve(decoded);
  } catch {
    return;
  }
  if (CONTROL_CHARS.test(normalized)) return;
  onEvent({ kind: "cwd", cwd: normalized });
}

// Re-export the event types so downstream callers don't import from two files.
export type { ShellIntegrationEvent, ShellIntegrationSink };
