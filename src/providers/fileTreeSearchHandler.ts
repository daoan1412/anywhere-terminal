// src/providers/fileTreeSearchHandler.ts — Extension-host handler for
// `request-file-tree-search` RPC from the webview file-tree search.
//
// Backend strategy: enumerate ALL files inside the scope folder ONCE per
// (scope, rootGeneration) tuple. The webview fuzzy-scores client-side per
// keystroke against the cached enumeration — no query is shaped into the
// glob here. See: asimov/changes/add-file-tree-search/design.md D11.
//
// Lifecycle:
//   - At most ONE in-flight enumeration; a new accepted request cancels the
//     previous via `CancellationTokenSource.cancel()`.
//   - Every `CancellationTokenSource` is disposed in a `finally` block.
//   - `rootGeneration` is re-checked AFTER each await (findFiles + gitignore).
//   - The webview can also cancel via `cancel-file-tree-search` (see
//     `cancelCurrent`) when the user closes the search bar / workspace root
//     changes — so slow filesystems don't keep enumerating in the background.

import * as nodePath from "node:path";
import * as vscode from "vscode";
import type {
  FileTreeSearchResponseMessage,
  FileTreeSearchResult,
  RequestFileTreeSearchMessage,
} from "../types/messages";
import type { RootProvider } from "./fileTreeRpcHandler";
import { getIgnoredPaths } from "./gitIgnoreChecker";

/** Hard floor / ceiling on the enumeration cap. */
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 5000;
const DEFAULT_MAX_RESULTS = 2000;

/**
 * Injection seam — only the two genuinely external operations are injected:
 *   - `findFiles` hits VS Code's search pipeline (slow, I/O bound).
 *   - `getIgnoredPaths` spawns `git check-ignore --stdin` (subprocess).
 * Everything else (RelativePattern, Uri, CancellationTokenSource, config
 * read) is imported directly from `vscode` because there's no meaningful
 * production-vs-test variance.
 */
export interface SearchVscodeApi {
  findFiles: (
    include: vscode.RelativePattern,
    exclude: vscode.GlobPattern | undefined,
    maxResults: number,
    token: vscode.CancellationToken,
  ) => Thenable<Array<{ fsPath: string }>>;
  getIgnoredPaths: (scopePath: string, paths: readonly string[]) => Promise<Set<string>>;
}

/**
 * Combine `files.exclude` and `search.exclude` user settings into a single
 * brace-expansion glob suitable for `findFiles`'s exclude parameter. Patterns
 * disabled with `false` are dropped. Returns `undefined` when no patterns are
 * enabled (caller falls back to VS Code defaults).
 */
export function readCombinedExcludeGlob(): string | undefined {
  const files = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude") ?? {};
  const search = vscode.workspace.getConfiguration("search").get<Record<string, boolean>>("exclude") ?? {};
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const source of [files, search]) {
    for (const [pattern, enabled] of Object.entries(source)) {
      if (enabled !== true) {
        continue;
      }
      if (seen.has(pattern)) {
        continue;
      }
      seen.add(pattern);
      combined.push(pattern);
    }
  }
  if (combined.length === 0) {
    return undefined;
  }
  return combined.length === 1 ? combined[0] : `{${combined.join(",")}}`;
}

export function createDefaultSearchVscodeApi(): SearchVscodeApi {
  return {
    findFiles: (include, exclude, max, token) => vscode.workspace.findFiles(include, exclude, max, token),
    getIgnoredPaths: (scope, paths) => getIgnoredPaths(scope, paths),
  };
}

interface InFlightRequest {
  readonly requestId: string;
  readonly tokenSource: vscode.CancellationTokenSource;
}

/** Convert an absolute path to a scope-relative path with forward slashes. */
function toForwardSlashRelative(scopeAbsolute: string, fileAbsolute: string): string {
  const raw = nodePath.relative(scopeAbsolute, fileAbsolute);
  return raw.split(nodePath.sep).join("/");
}

/** Clamp `value` (any) to the protocol's documented [1, 5000] range; falls back to 2000. */
function normalizeMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.max(MIN_MAX_RESULTS, Math.min(MAX_MAX_RESULTS, Math.floor(value)));
}

/**
 * Stateful handler — owns at most ONE in-flight enumeration per instance.
 * Construct once per webview-hosting provider and route every
 * `request-file-tree-search` message through `handle()`. The provider also
 * forwards `cancel-file-tree-search` to `cancelCurrent()`.
 */
export class FileTreeSearchHandler {
  private currentRequest: InFlightRequest | null = null;

  constructor(
    private readonly provider: RootProvider,
    private readonly api: SearchVscodeApi,
  ) {}

  async handle(msg: RequestFileTreeSearchMessage): Promise<FileTreeSearchResponseMessage | null> {
    // 1. Validate the new request BEFORE cancelling the prior in-flight one —
    //    so a stale-generation request doesn't kill useful work in the
    //    background just to immediately reject itself.
    if (msg.rootGeneration !== this.provider.rootGeneration) {
      return {
        type: "file-tree-search-response",
        requestId: msg.requestId,
        rootGeneration: this.provider.rootGeneration,
        error: {
          code: "STALE_ROOT",
          message: `Request rootGeneration ${msg.rootGeneration} does not match current ${this.provider.rootGeneration}.`,
        },
      };
    }

    // 2. New request accepted — supersede any prior in-flight enumeration.
    this.cancelCurrent();

    // 3. Construct the cancellation token AFTER validation.
    const tokenSource = new vscode.CancellationTokenSource();
    const myRequest: InFlightRequest = { requestId: msg.requestId, tokenSource };
    this.currentRequest = myRequest;

    const maxResults = normalizeMaxResults(msg.maxResults);

    try {
      // 4. Enumerate. NO query in the glob — fuzzy filtering is client-side.
      //    Combined files.exclude + search.exclude is passed so node_modules /
      //    .git / .DS_Store and any user-customised excludes never enter
      //    enumeration.
      const scopeUri = vscode.Uri.file(msg.scopePath);
      const pattern = new vscode.RelativePattern(scopeUri, "**/*");
      const exclude = readCombinedExcludeGlob();
      const uris = await this.api.findFiles(pattern, exclude, maxResults, tokenSource.token);

      if (tokenSource.token.isCancellationRequested) {
        return null;
      }
      if (msg.rootGeneration !== this.provider.rootGeneration) {
        return null;
      }

      // 5. Drop gitignored paths. One subprocess over the entire candidate set
      //    (NUL-delimited). Failure (no git / not a repo / timeout) returns an
      //    empty set, leaving every result in place.
      let allPaths = uris.map((u) => u.fsPath);
      const ignored = await this.api.getIgnoredPaths(msg.scopePath, allPaths);

      // Re-check cancellation / generation after the (potentially slow) git
      // call — the workspace root may have rotated mid-spawn.
      if (tokenSource.token.isCancellationRequested) {
        return null;
      }
      if (msg.rootGeneration !== this.provider.rootGeneration) {
        return null;
      }

      if (ignored.size > 0) {
        allPaths = allPaths.filter((p) => !ignored.has(p));
      }

      const results: FileTreeSearchResult[] = allPaths.map((p) => ({
        absolutePath: p,
        relativePath: toForwardSlashRelative(msg.scopePath, p),
      }));

      return {
        type: "file-tree-search-response",
        requestId: msg.requestId,
        rootGeneration: this.provider.rootGeneration,
        results,
        // `truncated: true` when the underlying enumeration hit the cap,
        // even if some hits were later filtered out by gitignore.
        truncated: uris.length >= maxResults,
      };
    } catch (err) {
      if (tokenSource.token.isCancellationRequested) {
        return null;
      }
      return {
        type: "file-tree-search-response",
        requestId: msg.requestId,
        rootGeneration: this.provider.rootGeneration,
        error: {
          code: "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    } finally {
      tokenSource.dispose();
      if (this.currentRequest === myRequest) {
        this.currentRequest = null;
      }
    }
  }

  /**
   * Cancel any in-flight enumeration. Idempotent. Called both from inside
   * `handle()` when a new request supersedes the previous one, and from
   * outside via `cancel-file-tree-search` when the webview tears down its
   * search bar.
   */
  cancelCurrent(): void {
    const r = this.currentRequest;
    if (r) {
      r.tokenSource.cancel();
      this.currentRequest = null;
    }
  }

  /** Alias kept for symmetry with other host handlers. */
  dispose(): void {
    this.cancelCurrent();
  }
}
