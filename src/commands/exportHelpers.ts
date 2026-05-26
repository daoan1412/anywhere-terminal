// src/commands/exportHelpers.ts — Pure helpers for the export commands.
//
// All public functions here are side-effect-free OR take `vscode.workspace.fs`
// as a parameter so callers can substitute a stub in tests. No direct
// `vscode.window` calls — toasts live in the command modules.
//
// See:
//   asimov/changes/export-terminal-session/specs/terminal-session-export/spec.md
//   asimov/changes/export-terminal-session/design.md D7, D8

import stripAnsi from "strip-ansi";
import * as vscode from "vscode";
import type { TrackedCommand } from "../session/TrackedCommand";

/**
 * Replace any character outside `[A-Za-z0-9._-]` with `_`. Empty input becomes
 * `"terminal"` to avoid producing a filename that starts with the timestamp
 * separator. Used to sanitize the session name segment of the default
 * export filename.
 */
export function sanitizeFilenameSegment(name: string): string {
  if (!name) return "terminal";
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Build the default export filename — `<sanitized-session>-<timestamp>.<ext>`.
 * Timestamp is local wall-clock at invocation time, format `YYYYMMDD-HHmmss`.
 * Accepts `now` for deterministic tests.
 */
export function defaultExportFilename(sessionName: string, ext: string, now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => n.toString().padStart(width, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const stamp = `${y}${m}${d}-${hh}${mm}${ss}`;
  const safe = sanitizeFilenameSegment(sessionName);
  return `${safe}-${stamp}.${ext}`;
}

/**
 * Strip ANSI escapes from `text` iff `preserveAnsi === false`. Returns
 * `text` unchanged when `preserveAnsi === true` (the "Raw" save-dialog
 * filter).
 *
 * NOTE: `strip-ansi` v7 covers SGR (CSI ... m) sequences plus the broader
 * CSI/OSC alphabet (cursor moves, DEC private, etc.). Files written with
 * `preserveAnsi=false` are intended to be legible in `$EDITOR` — confirm
 * with the actual library if non-SGR sequences ever start to leak through.
 */
export function applyAnsiPreference(text: string, preserveAnsi: boolean): string {
  return preserveAnsi ? text : stripAnsi(text);
}

/**
 * Render a single tracked command as the on-disk block layout from the spec:
 *
 *     $ <commandLine>
 *     [exit <code|?>] [cwd <cwd|?>]
 *
 *     <output>
 *
 * Missing fields render as `?`. Output is appended verbatim — no trailing
 * newline normalisation (the shell already emits one).
 */
export function formatCommandBlock(cmd: TrackedCommand): string {
  const cmdLine = cmd.commandLine || "(command line not recorded)";
  const exit = cmd.exitCode === null ? "?" : String(cmd.exitCode);
  const cwd = cmd.cwd ?? "?";
  const truncatedSuffix = cmd.outputTruncated
    ? `\n\n[output truncated — total ${cmd.outputBytes} bytes, captured ${cmd.output.length}]`
    : "";
  return `$ ${cmdLine}\n[exit ${exit}] [cwd ${cwd}]\n\n${cmd.output}${truncatedSuffix}`;
}

/** Subset of `vscode.workspace.fs` used by `writeExportAtomically`. */
export interface FsLike {
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  rename(source: vscode.Uri, target: vscode.Uri, options: { overwrite: boolean }): Thenable<void>;
  delete(uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>;
}

/**
 * Write `content` (UTF-8) to `target` via `.tmp` + rename, mirroring the
 * atomic-write pattern in `src/session/SessionStorage.ts`. If the rename
 * fails, the orphan `.tmp` is best-effort deleted before the original
 * error propagates.
 */
export async function writeExportAtomically(target: vscode.Uri, content: string, fs: FsLike): Promise<void> {
  // Use `.file(...)` rather than `target.with(...)` so callers that pass a
  // simple `{ fsPath }`-shaped Uri (e.g. test mocks) still work. The real
  // `vscode.Uri.file` returns a `file://`-scheme Uri — adequate for v1; if
  // remote/virtual workspaces need scheme preservation later, switch to
  // `target.with({ path: target.path + ".tmp" })`.
  const tmpUri = vscode.Uri.file(`${target.fsPath}.tmp`);
  const bytes = Buffer.from(content, "utf8");
  // Some VS Code FS providers don't widen Buffer → Uint8Array automatically.
  const payload = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await fs.writeFile(tmpUri, payload);
  try {
    await fs.rename(tmpUri, target, { overwrite: true });
  } catch (err) {
    // Best-effort cleanup so we don't leave orphan `.tmp` files behind.
    try {
      await fs.delete(tmpUri);
    } catch {
      /* swallow — original error matters more */
    }
    throw err;
  }
}

/** Choose ANSI preservation based on the save-dialog filter the user picked. */
export function preferenceFromExtension(filename: string): { preserveAnsi: boolean } {
  const lower = filename.toLowerCase();
  // `.ansi` is the marker extension for the Raw filter (spec).
  return { preserveAnsi: lower.endsWith(".ansi") };
}
