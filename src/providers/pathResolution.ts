// src/providers/pathResolution.ts — Shared path-candidate generation for terminal file links.
//
// Hosts the absolute-vs-relative branching logic and the cwd-fanout loop
// that takes a raw click/hover target (e.g. `a/file.md`, `/abs/path`) and
// produces an ordered, deduplicated list of absolute candidate paths.
//
// Used by both `openFileLink.ts` (click → open) and `previewFileLink.ts`
// (hover → preview). The two callers diverge AFTER buildCandidates: click
// shows quickPick + toast + modal; hover stays silent.
//
// See: asimov/changes/add-hover-file-preview/design.md D5
// See: asimov/specs/terminal-clickable-file-paths/spec.md (Path resolution chain)

import * as path from "node:path";
import { expandTildeAndFileUri } from "./pathPreprocess";
import { resolveCwdRelative } from "./resolveCwdRelative";

const POSIX_ABSOLUTE = /^\//;
const WIN32_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** True when `p` is an absolute path under the current platform. */
export function isAbsolutePath(p: string): boolean {
  return process.platform === "win32" ? WIN32_ABSOLUTE.test(p) : POSIX_ABSOLUTE.test(p);
}

/** True when any path segment is exactly `..` — used to reject traversal before findFiles. */
export function hasTraversal(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => seg === "..");
}

/** Escape glob meta-characters in a user-controlled path so findFiles treats it literally. */
export function escapeGlob(p: string): string {
  return p.replace(/[*?[\]{}]/g, (c) => `[${c}]`);
}

/**
 * Narrow dependency surface for `buildCandidates`. Both `OpenFileLinkDeps`
 * and the future preview-side deps are supersets of this interface.
 */
export interface BuildCandidatesDeps {
  getInitialCwd(sessionId: string): string | undefined;
  getCurrentCwd(sessionId: string): string | undefined;
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
}

/** Minimal shape buildCandidates needs from the request message. */
export interface BuildCandidatesInput {
  path: string;
  sessionId: string;
}

/** Output of `buildCandidates` — candidate list plus diagnostics for trace logging. */
export interface BuildCandidatesResult {
  /** Ordered, deduplicated list of absolute candidate paths to stat. */
  candidates: string[];
  /** The input path after tilde / file:// expansion. */
  transformedPath: string;
  /** Count of candidates contributed per source (for diagnostic logging). */
  sourceCounts: Record<string, number>;
  /** True when the input was a malformed `file://` URI — short-circuit the chain. */
  malformed: boolean;
}

/**
 * Build the ordered, deduplicated list of candidate absolute paths to try.
 *
 * After `expandTildeAndFileUri` normalizes `~` and `file://` URIs, the
 * function branches on absoluteness:
 *
 * - `passthrough-malformed` (broken `file://`) → `[]`, caller short-circuits.
 * - Absolute → single candidate. The early short-circuit avoids the
 *   `path.join(cwd, absolutePath)` bug where Node strips the leading
 *   separator and produces bogus concatenations.
 * - Relative → each cwd source (liveCwd, currentCwd, initialCwd, every
 *   workspaceFolder) fans out via `resolveCwdRelative` so a click on
 *   `a/file.md` while the terminal is in `/x/y/a` tries BOTH `/x/y/a/a/file.md`
 *   AND `/x/y/a/file.md`.
 */
export function buildCandidates(
  msg: BuildCandidatesInput,
  deps: BuildCandidatesDeps,
  liveCwd: string | undefined,
): BuildCandidatesResult {
  const { path: transformed, kind } = expandTildeAndFileUri(msg.path);
  if (kind === "passthrough-malformed") {
    return {
      candidates: [],
      transformedPath: transformed,
      sourceCounts: { malformed: 1 },
      malformed: true,
    };
  }
  if (isAbsolutePath(transformed)) {
    return {
      candidates: [path.resolve(transformed)],
      transformedPath: transformed,
      sourceCounts: { absolute: 1 },
      malformed: false,
    };
  }
  const sources: Array<[string, string | undefined]> = [
    ["liveCwd", liveCwd],
    ["currentCwd", deps.getCurrentCwd(msg.sessionId)],
    ["initialCwd", deps.getInitialCwd(msg.sessionId)],
  ];
  for (const [i, folder] of (deps.workspaceFolders ?? []).entries()) {
    sources.push([`ws[${i}]`, folder.uri.fsPath]);
  }
  const seen = new Set<string>();
  const candidates: string[] = [];
  const sourceCounts: Record<string, number> = {};
  for (const [label, cwd] of sources) {
    if (!cwd) {
      continue;
    }
    let added = 0;
    for (const c of resolveCwdRelative(cwd, transformed)) {
      const normalized = path.resolve(c);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        candidates.push(normalized);
        added++;
      }
    }
    if (added > 0) {
      sourceCounts[label] = added;
    }
  }
  return { candidates, transformedPath: transformed, sourceCounts, malformed: false };
}
