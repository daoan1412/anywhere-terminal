// src/providers/fileTreeRpcHandler.ts — Extension-host handler for
// `request-read-directory` RPC from the webview file-tree.
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D10
//
// The handler validates the request's `rootGeneration` against the host's
// current generation (stale requests are rejected), confirms the requested
// path is contained within the active workspace folder (out-of-workspace
// requests are rejected), then enumerates the directory via the injected
// `fs.readDirectory` and posts a `ReadDirectoryResponseMessage` back.
//
// `fs` and `Uri` are injected (rather than imported from `vscode` directly)
// so unit tests can pass lightweight mocks without standing up an extension
// host. The production call site in `TerminalViewProvider` passes
// `vscode.workspace.fs` and `vscode.Uri`.

import * as path from "node:path";
import * as vscode from "vscode";
import type { FileEntry, ReadDirectoryResponseMessage, RequestReadDirectoryMessage } from "../types/messages";
import type { GitDecorationProvider } from "./gitDecorationProvider";
import { getIgnoredPaths } from "./gitIgnoreChecker";

/**
 * Read the user's enabled `files.exclude` glob patterns. Patterns set to
 * `true` are returned; `false`-disabled entries are filtered out. Both
 * `TerminalViewProvider` (sidebar / panel) and `TerminalEditorProvider`
 * (editor) call this when forwarding a `request-read-directory` to the
 * handler so the webview never sees excluded names.
 */
export function readEnabledExcludePatterns(): string[] {
  const config = vscode.workspace.getConfiguration("files");
  const exclude = config.get<Record<string, boolean>>("exclude") ?? {};
  return Object.entries(exclude)
    .filter(([, enabled]) => enabled === true)
    .map(([pattern]) => pattern);
}

/**
 * Subset of the provider that the file-tree RPC + search handlers need.
 * Just the monotonic workspace-folder generation; consumers that need
 * folder paths (e.g. the search handler historically did before policy
 * alignment) layer that on themselves.
 */
export interface RootProvider {
  readonly rootGeneration: number;
}

/**
 * Compile a single VS Code `files.exclude` glob pattern down to a basename
 * predicate. We only filter at one directory level at a time (the RPC handler
 * enumerates a single folder per call), so we strip the leading `**\/` and
 * trailing `/` and match the remainder against the entry name.
 *
 * Supports: `*` (any chars), `?` (single char). Does NOT support `{a,b}`
 * brace expansion or character classes — patterns shipped by default in
 * VS Code (`**\/.git`, `**\/.DS_Store`, `**\/node_modules`, `**\/Thumbs.db`)
 * only use bare names + wildcards, so this is enough.
 */
function patternToBasenameRegex(pattern: string): RegExp | null {
  const body = pattern.replace(/^\*\*\//, "").replace(/\/$/, "");
  if (!body || body.includes("/")) {
    // Patterns with internal slashes (e.g. `src/foo/**`) can't be evaluated
    // at a single directory level without a full path — drop them.
    return null;
  }
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function nameMatchesAnyExclude(name: string, regexes: ReadonlyArray<RegExp>): boolean {
  for (const r of regexes) {
    if (r.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * `vscode.FileType` bit values we depend on. The real `vscode.FileType` enum
 * has the same numeric values (File=1, Directory=2, SymbolicLink=64) and is
 * bitmask-compatible: a directory symlink is `Directory | SymbolicLink` = 66.
 */
const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;

// VS Code Explorer default sort: directories first, then files; alphabetic
// within each group using locale-aware case-insensitive comparison so e.g.
// `README` and `readme` sort together and `é` lands next to `e`.
const nameCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  return nameCollator.compare(a.name, b.name);
}

/**
 * Handle a `request-read-directory` message. Posts exactly one
 * `ReadDirectoryResponseMessage` per call, never throws.
 *
 * Error codes:
 *   - `STALE_ROOT` — `msg.rootGeneration` does not match `provider.rootGeneration`.
 *   - `FS_ERROR`   — `fs.readDirectory` threw (permission denied, ENOENT, etc).
 *
 * NOTE: The handler intentionally does NOT restrict reads to paths inside
 * the workspace folder. The webview's file tree can re-root to any directory
 * the shell `cd`'d into (e.g. via "Reveal Working Directory"), which is the
 * mental model users expect from a terminal-adjacent file browser. The OS
 * remains the effective security boundary — `fs.readDirectory` will refuse
 * paths the user can't read.
 */
export async function handleRequestReadDirectory(
  msg: RequestReadDirectoryMessage,
  provider: RootProvider,
  postMessage: (m: ReadDirectoryResponseMessage) => void,
  fs: typeof vscode.workspace.fs,
  Uri: typeof vscode.Uri,
  /**
   * Optional list of enabled `files.exclude` glob patterns from VS Code
   * config. Entries whose basename matches any pattern are dropped from
   * the response so the webview never even learns about hidden files.
   * Caller is responsible for filtering out disabled (`false`) entries.
   */
  excludePatterns: ReadonlyArray<string> = [],
  /**
   * Optional git decoration provider. When provided, each `FileEntry` is
   * stamped with `gitStatus` (when decorated) and `gitRevision` (always — used
   * by the webview to defeat snapshot/delta ordering races). When `null`,
   * the entries' `gitStatus`/`gitRevision` fields are omitted.
   */
  gitDecorationProvider: GitDecorationProvider | null = null,
): Promise<void> {
  const currentGeneration = provider.rootGeneration;

  // 1. Stale-generation guard. The webview's generation MUST match the host's
  //    current generation; mismatch means the workspace root changed between
  //    request and arrival, so the response is moot.
  if (msg.rootGeneration !== currentGeneration) {
    postMessage({
      type: "read-directory-response",
      requestId: msg.requestId,
      rootGeneration: currentGeneration,
      error: {
        code: "STALE_ROOT",
        message: `Request rootGeneration ${msg.rootGeneration} does not match current ${currentGeneration}.`,
      },
    });
    return;
  }

  // 2. Resolve the path. We deliberately accept any absolute path the
  //    webview asks for — out-of-workspace navigation is supported by design
  //    so users can browse folders the shell `cd`'d into. The OS is the
  //    effective security boundary (fs.readDirectory will refuse paths the
  //    user can't read). `workspaceRoot` is still tracked on the provider
  //    for git-ignore checks (which scope to the active repo) but is no
  //    longer a containment gate.
  const absPath = path.resolve(msg.path);

  // 3. Enumerate. `vscode.workspace.fs.readDirectory` returns `[name, FileType][]`.
  let raw: Array<[string, number]>;
  try {
    raw = (await fs.readDirectory(Uri.file(absPath))) as Array<[string, number]>;
  } catch (err) {
    postMessage({
      type: "read-directory-response",
      requestId: msg.requestId,
      rootGeneration: currentGeneration,
      error: {
        code: "FS_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  // 5. Map FileType → FileEntry.kind. Symlinks (FileType.SymbolicLink = 64)
  //    have File/Directory bits OR'd in when followable; we bitmask-test for
  //    those bits and drop symlinks that resolve to neither.
  //    Entries whose basename matches an enabled `files.exclude` pattern are
  //    dropped here so the webview never sees them.
  const compiledExcludes = excludePatterns.map(patternToBasenameRegex).filter((r): r is RegExp => r !== null);
  const entries: FileEntry[] = [];
  for (const [name, type] of raw) {
    if (compiledExcludes.length > 0 && nameMatchesAnyExclude(name, compiledExcludes)) {
      continue;
    }
    let kind: FileEntry["kind"] | undefined;
    if ((type & FILE_TYPE_DIRECTORY) !== 0) {
      kind = "directory";
    } else if ((type & FILE_TYPE_FILE) !== 0) {
      kind = "file";
    }
    if (kind === undefined) {
      continue;
    }
    entries.push({
      name,
      path: path.join(absPath, name),
      kind,
    });
  }

  // 6. Sort: directories before files, then case-insensitive locale order
  //    within each group (matches VS Code's default Explorer sort).
  entries.sort(compareEntries);

  // 7. Annotate gitignored entries. We invoke `git check-ignore --stdin` from
  //    the listed directory itself (`absPath`) so the matching honours the
  //    enclosing repo's .gitignore — even when the user navigated outside the
  //    workspace folder. Errors / timeout / non-git-repo collapse to an empty
  //    set (no annotations) — the file tree just doesn't dim anything.
  if (entries.length > 0) {
    const ignored = await getIgnoredPaths(
      absPath,
      entries.map((e) => e.path),
    );
    if (ignored.size > 0) {
      for (const e of entries) {
        if (ignored.has(e.path)) {
          e.ignored = true;
        }
      }
    }
  }

  // 8. Stamp each entry with the current git status + revision (D3, D7, D10).
  //    Higher-severity statuses from the git extension win over `.gitignore`
  //    detection (e.g. a file matched by .gitignore but force-added stays
  //    `added`, not `ignored`). The revision is always present so the webview
  //    can reject stale snapshots that race against fresher delta messages.
  if (gitDecorationProvider) {
    for (const e of entries) {
      const { status, revision } = gitDecorationProvider.getStatus(e.path);
      if (status !== undefined) {
        e.gitStatus = status;
      } else if (e.ignored) {
        e.gitStatus = "ignored";
      }
      e.gitRevision = revision;
    }
  }

  postMessage({
    type: "read-directory-response",
    requestId: msg.requestId,
    rootGeneration: currentGeneration,
    entries,
  });
}
