// src/pty/oscParser.ts — Passive OSC 7 / OSC 633 cwd parser
// See: asimov/specs/terminal-cwd-tracking/spec.md
// See: asimov/changes/track-terminal-cwd/design.md D2-D4

import * as path from "node:path";

/** Maximum buffer size before truncation. */
const MAX_PENDING = 4096;

/** Bytes retained after MAX_PENDING overflow (room for a fresh ESC ] to start). */
const TRUNCATE_TO = 128;

/** OSC 633 cwd sub-command prefix (after the leading "633;"). */
const OSC_633_CWD_PREFIX = "P;Cwd=";

/** Pure-state OSC parser. One instance per PtySession. */
export interface OscParser {
  /** Feed a chunk of PTY output. Invokes onCwd when a complete cwd report is parsed. */
  feed(chunk: string, onCwd: (cwd: string) => void): void;
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

  return {
    feed(chunk: string, onCwd: (cwd: string) => void): void {
      pending += chunk;
      if (pending.length > MAX_PENDING) {
        // Drop open OSCs; keep the tail in case a new ESC is starting.
        pending = pending.slice(-TRUNCATE_TO);
      }

      let i = 0;
      while (true) {
        const escIdx = pending.indexOf("\x1b]", i);
        if (escIdx === -1) {
          // No more OSC starts in this buffer. Keep last byte in case it's a
          // lone ESC whose ] is in the next chunk.
          pending = pending.slice(-1);
          return;
        }

        // Read identifier digits after "\x1b]".
        const afterEsc = escIdx + 2;
        let p = afterEsc;
        while (p < pending.length && pending[p] >= "0" && pending[p] <= "9") {
          p++;
        }

        if (p === afterEsc) {
          if (p >= pending.length) {
            // ESC ] at end of buffer with no identifier yet — digits may
            // arrive in the next chunk. Retain partial and wait.
            pending = pending.slice(escIdx);
            return;
          }
          // No digits → not a valid OSC; skip the "\x1b]" and resume scanning.
          i = escIdx + 1;
          continue;
        }

        if (p >= pending.length) {
          // Ran off the end while reading digits — need more data.
          pending = pending.slice(escIdx);
          return;
        }

        if (pending[p] !== ";") {
          // Identifier not followed by ';' → malformed; skip past ESC.
          i = escIdx + 1;
          continue;
        }

        const oscNum = pending.slice(afterEsc, p);
        const payloadStart = p + 1;

        // Scan for terminator: BEL (\x07) or ST (\x1b\\).
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
              // ESC at end of buffer — could be start of ST; wait for more.
              needMore = true;
              break;
            }
            if (pending[q + 1] === "\\") {
              termIdx = q;
              termLen = 2;
              break;
            }
            // ESC followed by something else inside payload — keep scanning.
          }
          q++;
        }

        if (needMore) {
          pending = pending.slice(escIdx);
          return;
        }

        if (termIdx === -1) {
          // No terminator yet — retain partial OSC and wait for more data.
          pending = pending.slice(escIdx);
          return;
        }

        const payload = pending.slice(payloadStart, termIdx);

        if (oscNum === "7") {
          handleOsc7(payload, onCwd);
        } else if (oscNum === "633") {
          handleOsc633(payload, onCwd);
        }
        // Other OSC numbers (0 title, 8 hyperlink, 52 clipboard, 1337 iTerm,
        // etc.) are silently skipped.

        i = termIdx + termLen;
      }
    },
  };
}

/** OSC 7 payload: a file:// URL. */
function handleOsc7(payload: string, onCwd: (cwd: string) => void): void {
  // Narrowly catch URL/decode errors only. A throw from onCwd (the sink) must
  // propagate up to PtySession's outer try/catch so the pass-through guarantee
  // holds — swallowing here would also hide spec-violating sink crashes.
  let decoded: string;
  try {
    const url = new URL(payload);
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return;
  }
  emitIfValid(decoded, onCwd);
}

/** OSC 633 payload: only the "P;Cwd=<path>" sub-command carries a raw cwd. */
function handleOsc633(payload: string, onCwd: (cwd: string) => void): void {
  if (!payload.startsWith(OSC_633_CWD_PREFIX)) {
    return;
  }
  const rawPath = payload.slice(OSC_633_CWD_PREFIX.length);
  emitIfValid(rawPath, onCwd);
}

/** ASCII control bytes (NUL through US, plus DEL). None belong in a sane filesystem path. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — rejecting control chars in untrusted PTY-emitted cwds is the whole point.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Apply D3 sanitization and emit. */
function emitIfValid(decoded: string, onCwd: (cwd: string) => void): void {
  if (!path.isAbsolute(decoded)) {
    return;
  }
  let normalized: string;
  try {
    normalized = path.resolve(decoded);
  } catch {
    return;
  }
  // Reject any control bytes — null byte breaks fs APIs; ESC/CR/etc. would
  // mis-display in any future UI surface that renders the cwd literally.
  if (CONTROL_CHARS.test(normalized)) {
    return;
  }
  onCwd(normalized);
}
