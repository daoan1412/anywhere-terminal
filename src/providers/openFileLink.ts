// src/providers/openFileLink.ts — Resolve and open a file path detected in terminal output.
//
// Receives an `OpenFileMessage` from the webview, walks the resolution chain
// (absolute → PTY initial cwd → workspace folders), verifies existence via
// fs.stat, shows a confirm modal for paths outside the workspace, and opens
// the file at the parsed line/column.
//
// See: asimov/specs/terminal-clickable-file-paths/spec.md
// See: asimov/changes/add-clickable-file-paths/design.md D7, D8

import * as path from "node:path";
import * as vscode from "vscode";
import type { OpenFileMessage } from "../types/messages";

/** Dependencies for openFileLink — injectable for unit tests. */
export interface OpenFileLinkDeps {
  /** Look up the resolved cwd recorded at PTY spawn time. */
  getInitialCwd(sessionId: string): string | undefined;
  /** Snapshot of workspace folders at handler invocation time. */
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
  /** File system stat (rejects on missing file). */
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
  /** Modal warning dialog. */
  showWarning: typeof vscode.window.showWarningMessage;
  /** Error toast (no buttons). */
  showError: typeof vscode.window.showErrorMessage;
  /** Open an editor for the given URI. */
  showTextDocument: typeof vscode.window.showTextDocument;
}

const POSIX_ABSOLUTE = /^\//;
const WIN32_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function isAbsolutePath(p: string): boolean {
  return process.platform === "win32" ? WIN32_ABSOLUTE.test(p) : POSIX_ABSOLUTE.test(p);
}

/** Build the ordered list of candidate absolute paths to try, deduplicated. */
function buildCandidates(msg: OpenFileMessage, deps: OpenFileLinkDeps): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const normalized = path.resolve(p);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };

  if (isAbsolutePath(msg.path)) {
    push(msg.path);
  }
  const cwd = deps.getInitialCwd(msg.sessionId);
  if (cwd) {
    push(path.join(cwd, msg.path));
  }
  for (const folder of deps.workspaceFolders ?? []) {
    push(path.join(folder.uri.fsPath, msg.path));
  }
  return candidates;
}

/** Compare two normalized paths with platform-appropriate case sensitivity. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Return true when `target` is `base` or any descendant. */
function isInside(target: string, base: string): boolean {
  const normTarget = path.resolve(target);
  const normBase = path.resolve(base);
  if (samePath(normTarget, normBase)) {
    return true;
  }
  const rel =
    process.platform === "win32"
      ? path.relative(normBase.toLowerCase(), normTarget.toLowerCase())
      : path.relative(normBase, normTarget);
  if (rel === "" || rel === ".") {
    return true;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function buildSelection(line: number | undefined, col: number | undefined): vscode.Range | undefined {
  if (line === undefined) {
    return undefined;
  }
  const colZero = col !== undefined ? Math.max(0, col - 1) : 0;
  const lineZero = Math.max(0, line - 1);
  return new vscode.Range(lineZero, colZero, lineZero, colZero);
}

/** Resolve the message's path and open it; surface errors and confirms via deps. */
export async function openFileLink(msg: OpenFileMessage, deps: OpenFileLinkDeps): Promise<void> {
  if (typeof msg.path !== "string" || msg.path.length === 0) {
    return;
  }

  const candidates = buildCandidates(msg, deps);

  let resolvedFsPath: string | undefined;
  for (const candidate of candidates) {
    const uri = vscode.Uri.file(candidate);
    try {
      const fileStat = await deps.stat(uri);
      // Skip directories — fall through to next candidate.
      if (fileStat.type === vscode.FileType.Directory) {
        continue;
      }
      resolvedFsPath = candidate;
      break;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      // FileNotFound is the common case (silently try next). Surface anything
      // unexpected (permission denied, I/O error) so support has signal — we
      // still fall through and try remaining candidates.
      if (code !== "FileNotFound" && code !== "ENOENT") {
        console.warn(`[AnyWhere Terminal] stat(${candidate}) failed:`, err);
      }
    }
  }

  if (resolvedFsPath === undefined) {
    await deps.showError(`File not found: ${msg.path}`);
    return;
  }

  // Out-of-scope confirm dialog when the resolved path is outside both
  // the PTY's initial cwd and every workspace folder.
  const bases: string[] = [];
  const cwd = deps.getInitialCwd(msg.sessionId);
  if (cwd) {
    bases.push(cwd);
  }
  for (const folder of deps.workspaceFolders ?? []) {
    bases.push(folder.uri.fsPath);
  }
  const insideAny = bases.some((b) => isInside(resolvedFsPath as string, b));
  if (!insideAny) {
    const choice = await deps.showWarning(
      `Open file outside workspace?\n\n${resolvedFsPath}`,
      { modal: true },
      "Open",
      "Cancel",
    );
    if (choice !== "Open") {
      return;
    }
  }

  const selection = buildSelection(msg.line, msg.col);
  const uri = vscode.Uri.file(resolvedFsPath);
  await deps.showTextDocument(uri, selection ? { selection } : undefined);
}
