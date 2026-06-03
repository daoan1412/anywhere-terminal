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
import {
  type BuildCandidatesResult,
  buildCandidates as buildCandidatesShared,
  escapeGlob as escapeGlobShared,
  hasTraversal,
  isAbsolutePath,
} from "./pathResolution";

/** Dependencies for openFileLink — injectable for unit tests. */
export interface OpenFileLinkDeps {
  /** Look up the resolved cwd recorded at PTY spawn time. */
  getInitialCwd(sessionId: string): string | undefined;
  /** Look up the latest cwd parsed from PTY OSC 7 / OSC 633 reports. */
  getCurrentCwd(sessionId: string): string | undefined;
  /**
   * Async query of the PTY child process's current cwd via the OS process
   * table. Authoritative for local sessions; preferred over `getCurrentCwd`
   * because it doesn't require shell cooperation. Optional so test fixtures
   * that pre-date this addition stay compatible — when undefined the
   * resolver simply skips step 2.
   */
  getLiveCwd?(sessionId: string): Promise<string | undefined>;
  /** Snapshot of workspace folders at handler invocation time. */
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
  /** File system stat (rejects on missing file). */
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
  /**
   * Workspace-wide file search (used as last-resort fallback). Accepts a
   * `RelativePattern` so we can root the search at a specific cwd when
   * `workspaceFolders` is empty (e.g. user opened a single file or no folder
   * at all). Falls back to plain string glob when a workspace IS open. The
   * `token` is fired on our 2-second timeout so a slow filesystem walk
   * (e.g. accidentally rooted at `/`) doesn't keep enumerating in the
   * background after the click handler has given up.
   */
  findFiles(
    include: vscode.GlobPattern,
    exclude: string,
    maxResults: number,
    token?: vscode.CancellationToken,
  ): Thenable<vscode.Uri[]>;
  /** Modal warning dialog. */
  showWarning: typeof vscode.window.showWarningMessage;
  /** Error toast (no buttons). Retained for dependency compatibility. */
  showError: typeof vscode.window.showErrorMessage;
  /** Open an editor for the given URI. */
  showTextDocument: typeof vscode.window.showTextDocument;
  /** Pick-one-of-many dialog used when findFiles returns multiple matches. */
  showQuickPick: typeof vscode.window.showQuickPick;
  /**
   * Resolve the cap on findFiles results (controls how many matches the
   * QuickPick UI is willing to show). Read from
   * `anywhereTerminal.fileSearch.maxResults` by the providers; optional
   * here so legacy test deps keep working — falls back to `DEFAULT_FIND_FILES_MAX_RESULTS`.
   */
  getFileSearchMaxResults?(): number;
}

/** Time budget for the findFiles fallback before we give up. */
const FIND_FILES_TIMEOUT_MS = 2000;
const FIND_FILES_EXCLUDE = "{**/node_modules/**,**/.git/**}";
/**
 * Default cap on findFiles results when ambiguity is possible. Most
 * workspaces have < 50 same-named files; the quickPick UI degrades past
 * that. Users can override via `anywhereTerminal.fileSearch.maxResults`
 * (e.g. when working in monorepos with many duplicate filenames).
 */
export const DEFAULT_FIND_FILES_MAX_RESULTS = 50;
/** Hard ceiling — `findFiles` enumerates everything matched up to this
 * cap before timing out, so a runaway setting would freeze the click. */
const FIND_FILES_MAX_RESULTS_CEILING = 1000;

// Re-export `escapeGlob` from `pathResolution.ts` so existing import sites in
// other modules and tests keep working without churn.
export const escapeGlob = escapeGlobShared;

/**
 * Promise.race wrapper that rejects with a fixed Error if the thenable
 * doesn't settle in time. The optional `onTimeout` callback fires before
 * the rejection so the caller can release external resources (e.g.
 * `CancellationTokenSource.cancel()` so the underlying `findFiles` stops
 * enumerating).
 */
function withTimeout<T>(p: Thenable<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        onTimeout?.();
      } catch {
        // Cancellation handler shouldn't fail; if it does, prefer to
        // surface the timeout error rather than swallow it.
      }
      reject(new Error(`findFiles timeout after ${ms}ms`));
    }, ms);
    Promise.resolve(p).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * True when `absPath` ends with `clickedPath` at a separator boundary.
 *
 * Used by the basename fallback to filter workspace-wide `**\/<basename>`
 * matches down to those whose trailing segments equal the clicked text.
 * Example: clicked `a/file.md` matches `/x/y/a/file.md` (boundary anchored at
 * the separator before `a`) but NOT `/x/y/za/file.md` (no separator before `a`).
 *
 * Separator differences (POSIX `/` vs Windows `\`) are normalized; comparison
 * is case-insensitive on Windows. Exposed as a free function so tests can
 * exercise it directly without going through `openFileLink`.
 */
export function endsWithPath(
  absPath: string,
  clickedPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    const norm = (p: string) => p.replace(/[\\/]+/g, "\\").toLowerCase();
    const a = norm(absPath);
    const c = norm(clickedPath);
    return a === c || a.endsWith(`\\${c}`);
  }
  const norm = (p: string) => p.replace(/\/+/g, "/");
  const a = norm(absPath);
  const c = norm(clickedPath);
  return a === c || a.endsWith(`/${c}`);
}

/**
 * Compute a workspace-relative path for a quickPick label. Returns
 * `<folder-name>/<rel>` when multi-root (to disambiguate between folders),
 * `<rel>` when single-root, and the absolute path as-is if the match
 * happens to fall outside any workspace folder (rare — findFiles is
 * workspace-constrained, but defensive).
 */
function workspaceRelative(fsPath: string, folders: readonly { uri: { fsPath: string } }[] | undefined): string {
  if (!folders || folders.length === 0) {
    return fsPath;
  }
  for (const folder of folders) {
    const rel = path.relative(folder.uri.fsPath, fsPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return folders.length > 1 ? `${path.basename(folder.uri.fsPath)}/${rel}` : rel;
    }
  }
  return fsPath;
}

// `buildCandidates` was extracted to `./pathResolution.ts` so it can be shared
// with the hover-preview resolver (`previewFileLink.ts`). The wrapper here
// preserves the local `BuildCandidatesResult` shape that downstream code expects.
function buildCandidates(
  msg: OpenFileMessage,
  deps: OpenFileLinkDeps,
  liveCwd: string | undefined,
): BuildCandidatesResult {
  return buildCandidatesShared(msg, deps, liveCwd);
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

  // Trailing path separator → click target is explicitly a directory.
  // Defense in depth: the link provider already rejects trailing-`/`
  // candidates so the underline never appears, but if a future change to
  // the parser regresses, this keeps the handler from emitting a misleading
  // "File not found" for something the user knew was a folder.
  if (/[/\\]$/.test(msg.path)) {
    console.warn(
      `[AnyWhere Terminal] openFileLink: trailing slash on ${JSON.stringify(msg.path)}, treating as directory`,
    );
    return;
  }

  // Resolve liveCwd FIRST so it can join the candidate chain at step 2.
  // Errors are swallowed — the resolver falls through to OSC/initial/workspace.
  let liveCwd: string | undefined;
  try {
    liveCwd = (await deps.getLiveCwd?.(msg.sessionId)) ?? undefined;
  } catch {
    liveCwd = undefined;
  }

  const { candidates, transformedPath, sourceCounts, malformed } = buildCandidates(msg, deps, liveCwd);
  // Per-attempt diagnostics for exceptional resolver failures. Normal misses
  // are ignored, so this trace is only emitted when a deeper operation warns.
  const trace: string[] = [
    `msg.path=${JSON.stringify(msg.path)} sessionId=${msg.sessionId}`,
    `transformed=${JSON.stringify(transformedPath)}`,
    `liveCwd=${liveCwd ?? "(unset)"}`,
    `currentCwd=${deps.getCurrentCwd(msg.sessionId) ?? "(unset)"}`,
    `initialCwd=${deps.getInitialCwd(msg.sessionId) ?? "(unset)"}`,
    `workspaceFolders=${JSON.stringify(deps.workspaceFolders?.map((f) => f.uri.fsPath) ?? [])}`,
    `candidates-by-source=${JSON.stringify(sourceCounts)}`,
  ];

  let resolvedFsPath: string | undefined;
  // If any candidate resolves to a directory, the click target IS a folder
  // path (e.g. `src/providers`). When no file candidate hits we abort
  // silently — showing "File not found" is misleading because the path
  // exists, just not as a file. findFiles is also skipped (it only returns
  // files, never directories, so it can't find what the user actually clicked).
  let sawDirectory = false;
  for (const candidate of candidates) {
    const uri = vscode.Uri.file(candidate);
    try {
      const fileStat = await deps.stat(uri);
      // Skip directories — fall through to next candidate.
      // Use the Directory BIT MASK rather than strict equality so a
      // symlink-to-directory (`type === FileType.Directory | FileType.SymbolicLink`)
      // is also treated as a directory. Strict equality previously slipped
      // through as a file and `showTextDocument` would error on the directory.
      if ((fileStat.type & vscode.FileType.Directory) !== 0) {
        sawDirectory = true;
        trace.push(`stat(${candidate}) → directory, skip`);
        continue;
      }
      trace.push(`stat(${candidate}) → file ✓`);
      resolvedFsPath = candidate;
      break;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      trace.push(`stat(${candidate}) → ${code ?? (err as Error)?.message ?? "miss"}`);
      // FileNotFound is the common case (silently try next). Surface anything
      // unexpected (permission denied, I/O error) so support has signal — we
      // still fall through and try remaining candidates.
      if (code !== "FileNotFound" && code !== "ENOENT") {
        console.warn(`[AnyWhere Terminal] stat(${candidate}) failed:`, err);
      }
    }
  }

  // Last-resort: search the workspace for a matching filename. Wrapped in a
  // 2-second timeout via Promise.race — large workspaces can index slowly,
  // and a click that hangs is worse than one that surfaces "not found".
  //
  // Skipped when the click target is absolute (the absolute candidate already
  // ran in the stat loop above — a workspace search can't find what disk
  // already said is missing) or contains `..` traversal segments (defense in
  // depth — `vscode.workspace.findFiles` is workspace-constrained but we
  // refuse to send glob patterns that try to escape).
  //
  // Match-count UX (spec terminal-clickable-file-paths step 6):
  //   0 → silent no-op
  //   1 → open it
  //   ≥2 → quickPick disambiguation; user-cancel is no-op (no error toast)
  // Directory click → silent abort. Skip findFiles + skip toast.
  if (resolvedFsPath === undefined && sawDirectory) {
    console.warn(
      `[AnyWhere Terminal] openFileLink: target resolved to a directory, skipping. Trace:\n  ${trace.join("\n  ")}`,
    );
    return;
  }

  let quickPickCancelled = false;
  // Build the search pattern:
  //  - workspace open → plain string glob (searches all workspace folders).
  //  - no workspace + has cwd → `RelativePattern` rooted at liveCwd or initialCwd
  //    (lets us still find files in the user's working tree without a folder open).
  //  - no workspace + no cwd → skip findFiles, then silently give up.
  let searchPattern: vscode.GlobPattern | undefined;
  const hasWorkspace = (deps.workspaceFolders?.length ?? 0) > 0;
  const escapedGlob = `**/${escapeGlob(msg.path)}`;
  // Skip findFiles when:
  // - msg.path is absolute (the absolute candidate already ran in the stat loop)
  // - msg.path contains `..` (defense in depth against escape patterns)
  // - buildCandidates flagged `malformed` (e.g. broken `file://` URI) — without
  //   this guard we would have sent a bogus glob like `**/file:[/][/]garbage`
  //   to `vscode.workspace.findFiles`, which is wasted work and a noisy log.
  if (resolvedFsPath === undefined && !isAbsolutePath(msg.path) && !hasTraversal(msg.path) && !malformed) {
    if (hasWorkspace) {
      searchPattern = escapedGlob;
    } else {
      const searchBase = liveCwd ?? deps.getInitialCwd(msg.sessionId);
      if (searchBase) {
        searchPattern = new vscode.RelativePattern(vscode.Uri.file(searchBase), escapedGlob);
        trace.push(`findFiles anchored at ${searchBase} (no workspace open)`);
      } else {
        trace.push("findFiles skipped: no workspace, no cwd to anchor search");
      }
    }
  }

  if (searchPattern !== undefined) {
    const patternForLog = (sp: vscode.GlobPattern) =>
      typeof sp === "string"
        ? sp
        : `RelativePattern(${(sp as vscode.RelativePattern).baseUri.fsPath}, ${(sp as vscode.RelativePattern).pattern})`;
    // Resolve max-results: deps override → fall back to default. Clamp to
    // [1, ceiling] so a misconfigured setting (negative, NaN, huge) can't
    // freeze the click handler chasing 100k results before timeout. The
    // provider read can throw if `getConfiguration` rejects (e.g. the
    // schema check fails after a corrupt settings.json edit) — swallow it
    // rather than reject the whole `openFileLink` promise.
    let rawMax: unknown = DEFAULT_FIND_FILES_MAX_RESULTS;
    try {
      rawMax = deps.getFileSearchMaxResults?.() ?? DEFAULT_FIND_FILES_MAX_RESULTS;
    } catch (err) {
      console.warn("[AnyWhere Terminal] getFileSearchMaxResults threw, using default:", err);
    }
    const maxResults =
      typeof rawMax === "number" && Number.isFinite(rawMax)
        ? Math.min(Math.max(Math.floor(rawMax), 1), FIND_FILES_MAX_RESULTS_CEILING)
        : DEFAULT_FIND_FILES_MAX_RESULTS;
    // Cancel the underlying findFiles if our 2-second budget expires.
    // Without this, a slow walk (e.g. searchBase=`/`) can keep
    // enumerating after we've already given up — wasting CPU and potentially
    // blocking the extension host.
    const cancelSource = new vscode.CancellationTokenSource();
    // Two-stage findFiles wrapped in ONE shared `withTimeout`: the basename
    // fallback (call 2) doesn't get a fresh 2s budget — it shares whatever
    // remains of the original. If the full-path search consumes most of
    // 2s, the basename call is cancelled by the same cancelSource. Design
    // D6 prohibits the split-budget interpretation.
    const pathHasSep = msg.path.includes("/") || msg.path.includes("\\");
    // Reuse the original RelativePattern's base for the basename glob —
    // without this the basename pattern would default to all open workspace
    // folders, which is wrong when we entered the branch via the no-workspace
    // + cwd-anchored case.
    const baseUriForBasename =
      typeof searchPattern === "string" ? undefined : (searchPattern as vscode.RelativePattern).baseUri;
    const buildBasenamePattern = (): vscode.GlobPattern => {
      const basenameGlob = `**/${escapeGlob(path.basename(msg.path))}`;
      return baseUriForBasename ? new vscode.RelativePattern(baseUriForBasename, basenameGlob) : basenameGlob;
    };
    const runSearch = async (): Promise<vscode.Uri[]> => {
      const firstPattern = searchPattern as vscode.GlobPattern;
      const first = await deps.findFiles(firstPattern, FIND_FILES_EXCLUDE, maxResults, cancelSource.token);
      trace.push(`findFiles(${patternForLog(firstPattern)}) → ${first.length} matches`);
      if (first.length > 0 || !pathHasSep) {
        return first;
      }
      // Basename fallback. Shares the same cancellation token; if the outer
      // timeout fires during this call, both `withTimeout` rejects and this
      // promise is abandoned.
      const basenamePattern = buildBasenamePattern();
      const basenameMatches = await deps.findFiles(basenamePattern, FIND_FILES_EXCLUDE, maxResults, cancelSource.token);
      const filtered = basenameMatches.filter((uri) => endsWithPath(uri.fsPath, msg.path));
      trace.push(
        `findFiles(${patternForLog(basenamePattern)}) basename-fallback → ${basenameMatches.length} raw, ${filtered.length} ending-match`,
      );
      return filtered;
    };
    try {
      const matches = await withTimeout(runSearch(), FIND_FILES_TIMEOUT_MS, () => cancelSource.cancel());
      if (matches.length === 1) {
        resolvedFsPath = matches[0].fsPath;
      } else if (matches.length >= 2) {
        const items = matches.map((uri) => ({
          label: workspaceRelative(uri.fsPath, deps.workspaceFolders),
          description: uri.fsPath,
          fsPath: uri.fsPath,
        }));
        const picked = await deps.showQuickPick(items, {
          placeHolder: `${matches.length} files match "${msg.path}" — pick one`,
          matchOnDescription: true,
        });
        if (picked) {
          resolvedFsPath = (picked as { fsPath: string }).fsPath;
        } else {
          // ESC / cancel — silently abort. Do NOT show "File not found".
          quickPickCancelled = true;
        }
      }
    } catch (err) {
      trace.push(`findFiles fallback → threw: ${(err as Error)?.message ?? err}`);
      console.warn("[AnyWhere Terminal] findFiles fallback failed:", err);
    } finally {
      cancelSource.dispose();
    }
  } else if (resolvedFsPath === undefined && (isAbsolutePath(msg.path) || hasTraversal(msg.path))) {
    trace.push(`findFiles skipped (absolute=${isAbsolutePath(msg.path)} traversal=${hasTraversal(msg.path)})`);
  }

  if (quickPickCancelled) {
    return;
  }

  if (resolvedFsPath === undefined) {
    return;
  }

  // Out-of-scope confirm dialog when the resolved path is outside both
  // the PTY's initial cwd and every workspace folder.
  //
  // SECURITY: `currentCwd` (parsed from shell-emitted OSC 7/633) is
  // INTENTIONALLY NOT included in the trust-boundary bases. The shell can
  // emit OSC 7 with any absolute path (`/`, `/etc`, etc.); including it
  // here would let any process running in the terminal silently disable
  // the modal for arbitrary file opens. We only use currentCwd as a
  // resolution hint in `buildCandidates`.
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
