// src/providers/readFileForPreview.ts — Capped, binary-safe file reader for hover preview.
//
// Implements the two-tier cap from design.md D6:
//   - HARD_LIMIT_BYTES (1 MB) — files larger than this are reported as
//     `too-large` WITHOUT ever calling readFile.
//   - PREVIEW_LIMIT_BYTES (200 KB) — readFile is called, then the result is
//     sliced to the first 200 KB; UTF-8 decode (fatal=false) makes broken
//     multi-byte sequences at the slice boundary safe.
//
// The binary heuristic mirrors VSCode's own (NUL byte in first 8 KB).
//
// See: asimov/changes/add-hover-file-preview/specs/file-link-hover-preview/spec.md
//   #requirement-file-size-guard-and-read-limits
//   #requirement-binary-file-detection

import type * as vscode from "vscode";
import type { FilePreviewStatus } from "../types/messages";

/** Files larger than this hard limit are never read — `too-large` status. */
export const HARD_LIMIT_BYTES = 1_000_000;
/** When the file fits under HARD_LIMIT, only the first PREVIEW_LIMIT bytes are returned. */
export const PREVIEW_LIMIT_BYTES = 200_000;
/**
 * Maximum lines retained in `content` — beyond this we set `truncated`.
 * Bumped from 500 → 1000 per user feedback (round 2). The harder cap is
 * `PREVIEW_LIMIT_BYTES` (200 KB) which usually kicks in first for verbose
 * code; the line cap mostly protects against many short lines.
 */
export const MAX_LINES = 1000;
/** Scan window for the binary heuristic — a NUL byte (`0x00`) in this range marks the file as binary. */
export const BINARY_SCAN_BYTES = 8_192;

/** Narrow shape of `vscode.workspace.fs` the reader needs — injected for tests. */
export interface ReadFileForPreviewFs {
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  /**
   * Bounded read — read AT MOST `maxBytes` bytes from `uri`. Returns a
   * `Uint8Array` whose `byteLength <= maxBytes`. When the source file is
   * larger than `maxBytes`, callers detect the truncation by comparing
   * `result.byteLength === maxBytes` against the prior `stat.size` (or by
   * asking for `maxBytes + 1` to detect "exceeds limit").
   *
   * Optional — when omitted, the reader falls back to `readFile()` which
   * reads the WHOLE file. The bounded variant exists to defeat the
   * round-1 W5 / round-2 W1 TOCTOU memory blow-up: a symlink swap between
   * `stat` and the read can have the resolver fetch gigabytes; with a
   * bounded read, the buffer is pre-allocated and the host process never
   * sees more than `maxBytes` of the dereferenced content.
   *
   * Host providers wire this to `node:fs/promises.open()` +
   * `fileHandle.read(buf, 0, maxBytes, 0)`. Tests typically omit it and
   * exercise the legacy `readFile` path.
   */
  readBytes?(uri: vscode.Uri, maxBytes: number): Thenable<Uint8Array>;
}

/** Outcome of `readFileForPreview` — the shaped portion of a `FilePreviewResultMessage`. */
export interface ReadFileForPreviewResult {
  status: Extract<FilePreviewStatus, "ok" | "binary" | "too-large" | "error">;
  content?: string;
  truncated?: boolean;
  totalBytes?: number;
  totalLines?: number;
}

/**
 * Read `uri` for the hover preview popup, honoring the two-tier cap and binary detection.
 *
 * @param uri Resolved absolute file URI.
 * @param fs Narrow `vscode.workspace.fs` injection (stat + readFile).
 * @param token Cancellation token — checked between awaits; on cancel the
 *   function returns the special `cancelled` status so the caller can decide
 *   whether to post a result or drop it.
 */
export async function readFileForPreview(
  uri: vscode.Uri,
  fs: ReadFileForPreviewFs,
  token: vscode.CancellationToken,
): Promise<ReadFileForPreviewResult | { status: "cancelled" }> {
  if (token.isCancellationRequested) {
    return { status: "cancelled" };
  }

  let stat: vscode.FileStat;
  try {
    stat = await fs.stat(uri);
  } catch {
    return { status: "error" };
  }
  if (token.isCancellationRequested) {
    return { status: "cancelled" };
  }

  const totalBytes = stat.size;

  // Two-tier cap: short-circuit huge files BEFORE calling readFile.
  if (totalBytes > HARD_LIMIT_BYTES) {
    return { status: "too-large", totalBytes };
  }

  // Bounded read defeats TOCTOU memory blow-up (round-1 W5 + round-2 W1).
  // We ask for HARD_LIMIT_BYTES + 1 so that a return value of exactly
  // HARD_LIMIT_BYTES + 1 unambiguously means "source exceeds the cap" — the
  // pre-allocated buffer never grows beyond that. When the host doesn't wire
  // `readBytes` (older tests, edge cases), we fall back to the legacy
  // `readFile` which reads the whole file and re-checks size — best effort.
  let raw: Uint8Array;
  try {
    if (fs.readBytes) {
      raw = await fs.readBytes(uri, HARD_LIMIT_BYTES + 1);
    } else {
      raw = await fs.readFile(uri);
    }
  } catch {
    return { status: "error", totalBytes };
  }
  if (token.isCancellationRequested) {
    return { status: "cancelled" };
  }
  if (raw.byteLength > HARD_LIMIT_BYTES) {
    return { status: "too-large", totalBytes: raw.byteLength };
  }

  // Slice to the preview limit. `subarray` is a view (no copy); we hand the
  // view to TextDecoder, which copies into the decoded string.
  const sliced = raw.byteLength > PREVIEW_LIMIT_BYTES ? raw.subarray(0, PREVIEW_LIMIT_BYTES) : raw;
  const sliceTruncated = raw.byteLength > PREVIEW_LIMIT_BYTES;

  // Binary heuristic — NUL in the first 8 KB of the SLICE. Using the slice
  // (not `raw`) means we never read past PREVIEW_LIMIT for the scan.
  const scanLen = Math.min(sliced.byteLength, BINARY_SCAN_BYTES);
  for (let i = 0; i < scanLen; i++) {
    if (sliced[i] === 0x00) {
      return { status: "binary", totalBytes };
    }
  }

  // UTF-8 decode with `fatal: false` so broken multi-byte sequences at the
  // PREVIEW_LIMIT boundary become replacement chars rather than throwing.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sliced);

  const lines = decoded.split(/\r?\n/);
  const totalLines = lines.length;
  const linesTruncated = lines.length > MAX_LINES;
  const keptLines = linesTruncated ? lines.slice(0, MAX_LINES) : lines;
  const content = keptLines.join("\n");
  const truncated = sliceTruncated || linesTruncated;

  return {
    status: "ok",
    content,
    truncated: truncated || undefined,
    totalBytes,
    totalLines,
  };
}
