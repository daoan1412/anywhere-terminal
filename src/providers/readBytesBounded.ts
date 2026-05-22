// src/providers/readBytesBounded.ts — Memory-bounded file read using
// node:fs/promises. The host-side counterpart for `ReadFileForPreviewFs.readBytes`.
//
// Why this exists: `vscode.workspace.fs.readFile(uri)` has no max-bytes
// parameter — it reads the whole file. A symlink swap between `stat` and
// the read can cause the resolver to fetch gigabytes (round-1 W5 / round-2
// W1). With `open()` + `read(buf, 0, maxBytes, 0)`, the buffer is
// pre-allocated to a fixed size and the process never sees more than
// `maxBytes` of file content, regardless of what the inode now points to.
//
// See: asimov/changes/add-hover-file-preview/.reviews/round-2.md W1.

import { promises as nodeFs } from "node:fs";
import type * as vscode from "vscode";

/**
 * Open `uri.fsPath` and read AT MOST `maxBytes` bytes from offset 0. Closes
 * the file handle in a `finally` so an exception or partial read never leaks.
 *
 * The returned `Uint8Array` is a SLICE of the pre-allocated buffer — its
 * `byteLength` reflects the actual `bytesRead` returned by Node. Callers
 * detect "file exceeds cap" by passing `maxBytes = HARD_LIMIT + 1` and
 * comparing `result.byteLength > HARD_LIMIT`.
 */
export async function readBytesBounded(uri: vscode.Uri, maxBytes: number): Promise<Uint8Array> {
  const handle = await nodeFs.open(uri.fsPath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    // The slice view shares the underlying allocation but tells the decoder
    // how many bytes are actually valid. We deliberately do NOT copy here —
    // the bounded buffer goes straight into the TextDecoder downstream.
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    try {
      await handle.close();
    } catch {
      // Best-effort. If close fails the file descriptor leaks at process exit;
      // throwing here would mask the actual read result.
    }
  }
}
