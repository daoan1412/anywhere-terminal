// src/providers/previewFileLink.ts — Host-side handler for hover-preview requests.
//
// Mirrors the click flow's path-resolution chain (buildCandidates → workspace
// findFiles) but diverges in three ways for the passive hover UX:
//   1. STOP at the first file that exists — no quickPick on ≥2 matches; return
//      `ambiguous` instead.
//   2. NEVER show "File not found" toast — return `not-found`.
//   3. NEVER show the out-of-workspace modal — the popup header discloses absPath.
//
// See: asimov/changes/add-hover-file-preview/design.md D5, D6, D9, D13
// See: asimov/changes/add-hover-file-preview/specs/file-link-hover-preview/spec.md
//   #requirement-first-hit-path-resolution-for-hover

import * as path from "node:path";
import type * as vscode from "vscode";
import type { FilePreviewResultMessage, RequestFilePreviewMessage } from "../types/messages";
import { endsWithPath } from "./openFileLink";
import { type BuildCandidatesDeps, buildCandidates, escapeGlob, hasTraversal, isAbsolutePath } from "./pathResolution";
import { type ReadFileForPreviewFs, readFileForPreview } from "./readFileForPreview";

/** Time budget for the `findFiles` fallback. Matches the click flow. */
const FIND_FILES_TIMEOUT_MS = 2000;
const FIND_FILES_EXCLUDE = "{**/node_modules/**,**/.git/**}";

/** Curated extension → VSCode `languageId` map. See: design.md D13. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".sql": "sql",
  ".rb": "ruby",
  ".php": "php",
};

/** Resolve a `languageId` from a file URI via the curated map. Unknown extensions → `"plaintext"`. */
export function languageIdFromUri(uri: vscode.Uri): string {
  const match = uri.path.toLowerCase().match(/\.[^./\\]+$/);
  return (match && LANGUAGE_BY_EXTENSION[match[0]]) || "plaintext";
}

/** Detect markdown via extension. */
function isMarkdownPath(fsPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(fsPath);
}

/**
 * Folder names treated as known-sensitive — any path segment match blocks
 * auto-preview. Narrow allowlist of folders that DO commonly hold secrets:
 *   - `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker` — credential stores.
 *   - `.config` — many Linux tools persist auth tokens here (gh, gcloud, ...).
 *   - `.git` — `config` can carry remote URLs with embedded credentials.
 *   - `node_modules` — performance guardrail more than security; few users
 *     deliberately want hover-preview into deps.
 *
 * Tool-data dot-folders that are NOT sensitive (`.vscode`, `.next`, `.cache`,
 * `.idea`, `.claude`, `.reviews`, `.asimov`, `.opencode`, …) are intentionally
 * NOT in this list — the earlier generic ".any-dot-folder" rule made everyday
 * project files require the modifier-key override.
 */
const SENSITIVE_DIR_SEGMENTS = new Set<string>([
  ".ssh", // SSH keys
  ".aws", // AWS credentials, config
  ".gnupg", // GPG keys
  ".kube", // Kubernetes cluster credentials
  ".docker", // Docker registry auth
  ".config", // many Linux tools store auth tokens here (gh, gcloud, …)
  ".git", // config can carry remote URLs with embedded credentials
  "node_modules", // performance guardrail more than security
  // Round-2 W7 additions: vendors that deposit RAW API tokens into these
  // dot-folders even though the basenames inside are not dot-prefixed
  // (so the dotfile-basename rule does NOT catch them).
  ".terraform", // .terraform.d/credentials.tfrc.json — Terraform Cloud tokens
  ".terraform.d",
  ".npm", // _logs / per-registry auth headers in error dumps
  ".gem", // credentials file — RubyGems API key
  ".azure", // Azure CLI tokens
  ".bluemix", // IBM Cloud CLI tokens
  ".helm", // Helm repo credentials
]);

/**
 * Classify a resolved file against the trust policy. Returns the reason for
 * blocking auto-preview, or `null` when the file is freely previewable.
 *
 * Trust policy (round-1 B1 + user clarification + round-2 narrowing):
 * - **dotfile** — basename starts with `.` (e.g. `.env`, `.bashrc`, `.gitignore`).
 * - **sensitive-dir** — any path segment matches the SENSITIVE_DIR_SEGMENTS
 *   allowlist (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.config`, `.git`,
 *   `node_modules`). Previously this was "any `.`-prefix segment" which over-
 *   blocked common tool dirs like `.vscode/`, `.next/`, `.claude/`.
 * - **out-of-workspace** — resolved `fsPath` is not under any trust base
 *   (initialCwd + every workspace folder). Importantly, `currentCwd`
 *   (shell-emitted OSC 7) is NOT included, mirroring the click flow's modal
 *   gate at `openFileLink.ts:457-462`.
 *
 * Order matters: dotfile is detected even when the file IS inside the workspace,
 * because the user clarified blocking dotfiles takes precedence over location.
 */
export function classifyTrust(
  resolvedFsPath: string,
  trustBases: readonly string[],
): "dotfile" | "sensitive-dir" | "out-of-workspace" | null {
  const segments = resolvedFsPath.split(/[/\\]/).filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? "";
  // Dotfile takes precedence — basename starts with `.` (e.g. `.env`).
  if (basename.startsWith(".")) {
    return "dotfile";
  }
  // Any non-basename segment matches the explicit sensitive-folder allowlist.
  for (let i = 0; i < segments.length - 1; i++) {
    if (SENSITIVE_DIR_SEGMENTS.has(segments[i])) {
      return "sensitive-dir";
    }
  }
  // Trust bases empty → no known-good location to anchor the file against.
  // Failing OPEN here would let an absolute path like `/etc/passwd` auto-
  // preview when the user has no workspace folder AND `getInitialCwd` returned
  // undefined (stale session, race during shutdown, forged sessionId). Per
  // round-2 W3 we fail CLOSED: classify as out-of-workspace and require the
  // explicit Cmd/Ctrl override gesture before any content leaves the host.
  if (trustBases.length === 0) {
    return "out-of-workspace";
  }
  // Outside the trust bases? Compare with platform-appropriate case sensitivity.
  const insideAny = trustBases.some((base) => isInside(resolvedFsPath, base));
  if (!insideAny) {
    return "out-of-workspace";
  }
  return null;
}

/** Trust-base membership check — `child` lives inside `base` (or equals it). */
function isInside(child: string, base: string): boolean {
  if (process.platform === "win32") {
    const c = child.toLowerCase();
    const b = base.toLowerCase();
    return c === b || c.startsWith(b.endsWith("/") || b.endsWith("\\") ? b : `${b}${path.sep}`);
  }
  return child === base || child.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/** Build the trust-base set: initialCwd + every workspace folder. Excludes currentCwd (OSC-7-injectable). */
function trustBasesFor(msg: RequestFilePreviewMessage, deps: PreviewFileLinkDeps): string[] {
  const bases: string[] = [];
  const initial = deps.getInitialCwd(msg.sessionId);
  if (initial) {
    bases.push(initial);
  }
  for (const folder of deps.workspaceFolders ?? []) {
    bases.push(folder.uri.fsPath);
  }
  return bases;
}

/**
 * Minimal `vscode.Uri.file` reproducer — kept here to avoid importing
 * `vscode` synchronously in module scope (callers pass a `uriFactory` so unit
 * tests can stub Uri creation without loading the extension-host shim).
 */
export interface UriFactory {
  file(p: string): vscode.Uri;
}

/**
 * Snapshot of the hover-preview user settings the resolver needs. Subset of
 * `HoverPreviewSettings` — only the policy-affecting fields. UI-only settings
 * (`delay`) don't reach here.
 */
export interface PreviewPolicySettings {
  /** Trust-policy switch. When false, the dotfile/sensitive-dir/out-of-workspace check is skipped. */
  blockSensitive: boolean;
}

/** Dependencies for `previewFileLink` — subset of openFileLink's deps. */
export interface PreviewFileLinkDeps extends BuildCandidatesDeps {
  /** Look up the live PID cwd via the OS process table (optional — falls back to OSC/initial). */
  getLiveCwd?(sessionId: string): Promise<string | undefined>;
  /** File-system stat + readFile (narrow shape for testability). */
  fs: ReadFileForPreviewFs;
  /** Workspace search — used as last-resort resolution step. */
  findFiles(
    include: vscode.GlobPattern,
    exclude: string,
    maxResults: number,
    token?: vscode.CancellationToken,
  ): Thenable<vscode.Uri[]>;
  /** Uri constructor (vscode.Uri.file). */
  uriFactory: UriFactory;
  /** Token-source factory. Allows tests to swap out the timeout cancellation. */
  createCancellationTokenSource(): vscode.CancellationTokenSource;
  /** FileType enum value for Directory — passed in to keep tests from importing vscode. */
  directoryFileType: number;
  /**
   * FileType enum value for SymbolicLink (vscode.FileType.SymbolicLink === 64).
   * Optional for backward-compat with existing tests; when omitted, symlinks
   * are treated as regular files (legacy behavior). Round-2 W4: a symlink
   * inside a trusted workspace folder can point to `~/.ssh/id_rsa` or any
   * other secret; the LEXICAL path classifies as workspace-internal even
   * though the read dereferences external content. With this flag set, the
   * resolver flags symlinks and `previewFileLink` returns
   * `requires-confirmation` (reason `out-of-workspace`) — the Cmd/Ctrl
   * override still works for the legitimate "preview my workspace symlink"
   * case.
   */
  symbolicLinkFileType?: number;
  /**
   * `vscode.RelativePattern` constructor — used to anchor a `findFiles` search at
   * a specific filesystem base when no workspace folder is open. Optional: when
   * absent OR no base is available, the no-workspace branch falls through to
   * `not-found`. Tests can stub it (returning any structural object — `findFiles`
   * mocks accept the value verbatim).
   */
  relativePatternFactory?: (base: vscode.Uri, glob: string) => vscode.GlobPattern;
  /**
   * Hover-preview policy settings. Optional — when omitted, both checks behave
   * as if enabled (auto-preview ON + trust-policy ON). Tests typically pass
   * `undefined` to exercise the legacy paths.
   */
  settings?: PreviewPolicySettings;
}

interface ResolveOk {
  kind: "ok";
  uri: vscode.Uri;
  /** True iff `stat.type` carried the SymbolicLink bit — see W4 in deps comment. */
  isSymlink: boolean;
}
interface ResolveNotFound {
  kind: "not-found";
  sawDirectory: boolean;
}
interface ResolveAmbiguous {
  kind: "ambiguous";
  candidateCount: number;
}
type ResolveOutcome = ResolveOk | ResolveNotFound | ResolveAmbiguous;

async function withTimeout<T>(p: Thenable<T>, ms: number, onTimeout?: () => void): Promise<T> {
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
        // Cancel handler shouldn't fail; if it does, surface the timeout below.
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
 * Walk the candidate chain + workspace search to resolve the FIRST file hit.
 * Returns a structured outcome — does NOT show any UI.
 */
async function resolveFirstFile(
  msg: RequestFilePreviewMessage,
  deps: PreviewFileLinkDeps,
  token: vscode.CancellationToken,
): Promise<ResolveOutcome> {
  let liveCwd: string | undefined;
  try {
    liveCwd = (await deps.getLiveCwd?.(msg.sessionId)) ?? undefined;
  } catch {
    liveCwd = undefined;
  }
  if (token.isCancellationRequested) {
    return { kind: "not-found", sawDirectory: false };
  }

  const { candidates, malformed } = buildCandidates(msg, deps, liveCwd);
  if (malformed) {
    return { kind: "not-found", sawDirectory: false };
  }

  let sawDirectory = false;
  for (const candidate of candidates) {
    if (token.isCancellationRequested) {
      return { kind: "not-found", sawDirectory };
    }
    const uri = deps.uriFactory.file(candidate);
    try {
      const stat = await deps.fs.stat(uri);
      if ((stat.type & deps.directoryFileType) !== 0) {
        sawDirectory = true;
        continue;
      }
      // Symlink bit (FileType.SymbolicLink === 64) may be combined with File
      // — we still want to display the link as resolvable but mark it for
      // the trust check downstream. When `symbolicLinkFileType` isn't passed
      // (legacy tests), the flag stays false and behavior is unchanged.
      const isSymlink = deps.symbolicLinkFileType !== undefined ? (stat.type & deps.symbolicLinkFileType) !== 0 : false;
      return { kind: "ok", uri, isSymlink };
    } catch {
      // Miss — try next candidate.
    }
  }

  // `findFiles` fallback. Skip when:
  //   - absolute (already tried in stat loop)
  //   - traversal segments (defense in depth)
  //   - directory hit earlier (the click target is a folder — don't bother)
  if (isAbsolutePath(msg.path) || hasTraversal(msg.path) || sawDirectory) {
    return { kind: "not-found", sawDirectory };
  }

  const hasWorkspace = (deps.workspaceFolders?.length ?? 0) > 0;
  const escapedGlob = `**/${escapeGlob(msg.path)}`;
  // For findFiles we limit to 2 results — that's enough to detect ambiguity.
  // No need to enumerate up to N like the click flow's quickPick does.
  const maxResults = 2;

  let searchPattern: vscode.GlobPattern | undefined;
  let baseUriForBasename: vscode.Uri | undefined;
  if (hasWorkspace) {
    searchPattern = escapedGlob;
  } else {
    const searchBase = liveCwd ?? deps.getInitialCwd(msg.sessionId);
    if (searchBase && deps.relativePatternFactory) {
      // Anchor the search at the PTY cwd via `vscode.RelativePattern` — this
      // is the documented VSCode API for searching outside an open workspace.
      // Mirrors the click flow at `openFileLink.ts:343-345`.
      baseUriForBasename = deps.uriFactory.file(searchBase);
      searchPattern = deps.relativePatternFactory(baseUriForBasename, escapedGlob);
    }
  }
  if (!searchPattern) {
    return { kind: "not-found", sawDirectory };
  }

  // Click-flow parity: basename fallback when the first findFiles returns zero
  // matches AND the original path contains a path separator. Without this,
  // hovering `src/foo.ts` while the workspace is opened at `src/`'s parent
  // returns `not-found`, but clicking the same path would resolve it.
  // Mirrors `openFileLink.ts:391-411`.
  const pathHasSep = msg.path.includes("/") || msg.path.includes("\\");
  const buildBasenamePattern = (): vscode.GlobPattern => {
    const basenameGlob = `**/${escapeGlob(path.basename(msg.path))}`;
    if (baseUriForBasename && deps.relativePatternFactory) {
      return deps.relativePatternFactory(baseUriForBasename, basenameGlob);
    }
    return basenameGlob;
  };

  const cancelSource = deps.createCancellationTokenSource();
  // Both the first pattern and the basename fallback share the same 2s budget
  // via a single `withTimeout` (matches click flow design D6).
  const runSearch = async (): Promise<vscode.Uri[]> => {
    const firstPattern = searchPattern as vscode.GlobPattern;
    const first = await deps.findFiles(firstPattern, FIND_FILES_EXCLUDE, maxResults, cancelSource.token);
    if (first.length > 0 || !pathHasSep) {
      return first;
    }
    const basenamePattern = buildBasenamePattern();
    const basenameMatches = await deps.findFiles(basenamePattern, FIND_FILES_EXCLUDE, maxResults, cancelSource.token);
    return basenameMatches.filter((uri) => endsWithPath(uri.fsPath, msg.path));
  };

  try {
    const matches = await withTimeout(runSearch(), FIND_FILES_TIMEOUT_MS, () => cancelSource.cancel());
    if (matches.length === 1) {
      // findFiles results don't carry stat info — symlink detection happens
      // on the candidate-stat path. A workspace findFiles match is by
      // definition workspace-resident, so symlink flagging here is moot.
      return { kind: "ok", uri: matches[0], isSymlink: false };
    }
    if (matches.length >= 2) {
      return { kind: "ambiguous", candidateCount: matches.length };
    }
    return { kind: "not-found", sawDirectory };
  } catch {
    return { kind: "not-found", sawDirectory };
  } finally {
    cancelSource.dispose();
  }
}

/**
 * Top-level entry point. Resolves the path, reads the file (capped), and
 * shapes a `FilePreviewResultMessage`. Returns `null` when the request was
 * cancelled — caller must NOT post anything in that case.
 */
export async function previewFileLink(
  msg: RequestFilePreviewMessage,
  deps: PreviewFileLinkDeps,
  token: vscode.CancellationToken,
): Promise<FilePreviewResultMessage | null> {
  // Build a base envelope shared by every variant — the popup needs `path`
  // even on `not-found` / `ambiguous` so the header is never empty. The
  // optional `line` echo lets the popup scroll-to-line on ok results.
  const baseEnvelope = {
    type: "filePreviewResult",
    requestId: msg.requestId,
    path: msg.path,
    ...(msg.line !== undefined ? { line: msg.line } : {}),
  } as const;
  const notFound = (): FilePreviewResultMessage => ({ ...baseEnvelope, status: "not-found" });

  if (typeof msg.path !== "string" || msg.path.length === 0) {
    return notFound();
  }
  // Reject trailing-separator paths — those are explicitly directories.
  if (/[/\\]$/.test(msg.path)) {
    return notFound();
  }

  const outcome = await resolveFirstFile(msg, deps, token);
  if (token.isCancellationRequested) {
    return null;
  }

  if (outcome.kind === "ambiguous") {
    return { ...baseEnvelope, status: "ambiguous" };
  }
  if (outcome.kind === "not-found") {
    return notFound();
  }

  const { uri } = outcome;
  const absPath = uri.fsPath;
  const languageId = languageIdFromUri(uri);
  const isMarkdown = isMarkdownPath(uri.fsPath) || languageId === "markdown";

  // Hover-preview policy (round-1 B1 + Phase E + round-3 simplification):
  //   - `blockSensitive: true` (default) → run the trust check.
  //   - `override: true` → skip the check.
  // The previous master `enabled` switch was removed in round 3 — without an
  // in-UI toggle, stale `enabled: false` in user settings.json silently broke
  // every hover. Auto-preview is now always on; only the trust policy gates it.
  const settings = deps.settings;
  if (!msg.override) {
    // Trust policy — default-on; skipped when `blockSensitive: false`.
    if (settings?.blockSensitive !== false) {
      // Symlinks (W4): even when the LEXICAL path is workspace-internal, the
      // target may dereference a secret outside the workspace. Force the
      // override gesture regardless of lexical classification. Re-use the
      // `out-of-workspace` reason — the popup placeholder is generic ("Press
      // Cmd to preview") and "the link's target could be anywhere" is the
      // operative meaning for users.
      const lexicalReason = classifyTrust(absPath, trustBasesFor(msg, deps));
      const reason = outcome.isSymlink && lexicalReason === null ? "out-of-workspace" : lexicalReason;
      if (reason !== null) {
        let totalBytes: number | undefined;
        try {
          const stat = await deps.fs.stat(uri);
          if (!token.isCancellationRequested) {
            totalBytes = stat.size;
          }
        } catch {
          // ignore.
        }
        if (token.isCancellationRequested) {
          return null;
        }
        return {
          ...baseEnvelope,
          status: "requires-confirmation",
          reason,
          absPath,
          ...(totalBytes !== undefined ? { totalBytes } : {}),
        };
      }
    }
  }

  const read = await readFileForPreview(uri, deps.fs, token);
  if (read.status === "cancelled") {
    return null;
  }

  if (read.status === "error") {
    return { ...baseEnvelope, status: "error" };
  }
  if (read.status === "too-large") {
    return {
      ...baseEnvelope,
      status: "too-large",
      languageId,
      isMarkdown,
      totalBytes: read.totalBytes ?? 0,
      absPath,
    };
  }
  if (read.status === "binary") {
    return {
      ...baseEnvelope,
      status: "binary",
      languageId,
      isMarkdown,
      totalBytes: read.totalBytes ?? 0,
      absPath,
    };
  }
  // status === "ok"
  return {
    ...baseEnvelope,
    status: "ok",
    content: read.content ?? "",
    languageId,
    isMarkdown,
    truncated: read.truncated ?? false,
    totalBytes: read.totalBytes ?? 0,
    totalLines: read.totalLines ?? 0,
    absPath,
  };
}
