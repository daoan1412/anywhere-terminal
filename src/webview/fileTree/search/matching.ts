// src/webview/fileTree/search/matching.ts — Vendor-isolating fuzzy-score
// adapter for the file-tree in-panel search.
//
// This file is the ONLY consumer of `vs/base/common/filters`. The rest of
// the search controller talks to this module via the project-local
// `ITreeMatchData` shape, so swapping the scorer later (or moving back to
// a vendored `HighlightedLabel`) only touches one boundary. See: design.md D7.
//
// Edge cases pinned by `file-tree-search/spec.md "Search input edge cases"`:
//   - empty / whitespace-only query → no score, callers handle per mode
//   - wildcard chars (`*?[]{}`) → treated as literal letters by fuzzyScore
//   - unicode / emoji → indices are UTF-16 code units, ranges preserve surrogates
//   - backslash → literal character, no path normalization

import { createMatches, FuzzyScoreOptions, fuzzyScore } from "vs/base/common/filters";
import type { FileTreeSearchResult } from "../../../types/messages";
import type { ITreeMatchData } from "../ITreeRenderer";

export type SearchMode = "filter" | "highlight";

/** One scored candidate. `matchData` is undefined for no-match rows. */
export interface ScoredCandidate {
  readonly result: FileTreeSearchResult;
  readonly matchData?: ITreeMatchData;
}

/**
 * Whether a query string is "empty" for matching purposes — null/undefined,
 * empty string, or all whitespace. Wildcard chars (`*`, `?`, etc) are NOT
 * empty; they're treated as literal characters by `fuzzyScore`.
 */
export function isEmptyQuery(query: string): boolean {
  return query.length === 0 || /^\s+$/.test(query);
}

/**
 * Score a single candidate against `query`. Returns null when the query is
 * empty/whitespace OR the candidate's `relativePath` does not match (the
 * vendored `fuzzyScore` returns `undefined` in that case).
 *
 * Scoring target is `relativePath` ONLY — basename matches surface naturally
 * because `fuzzyScore` weights word-starts heavily. See: design.md D7.
 */
export function scoreOne(query: string, candidate: FileTreeSearchResult): ITreeMatchData | null {
  if (isEmptyQuery(query)) {
    return null;
  }
  const target = candidate.relativePath;
  const raw = fuzzyScore(query, query.toLowerCase(), 0, target, target.toLowerCase(), 0, FuzzyScoreOptions.default);
  if (!raw) {
    return null;
  }
  return {
    score: raw[0],
    matches: createMatches(raw),
  };
}

/** Sort comparator: higher score first, then shorter path, then alphabetic. */
function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  const sa = a.matchData?.score ?? Number.NEGATIVE_INFINITY;
  const sb = b.matchData?.score ?? Number.NEGATIVE_INFINITY;
  if (sa !== sb) {
    return sb - sa;
  }
  const la = a.result.relativePath.length;
  const lb = b.result.relativePath.length;
  if (la !== lb) {
    return la - lb;
  }
  return a.result.relativePath.localeCompare(b.result.relativePath);
}

/** Alphabetic comparator for the non-matched tail in Highlight mode. */
function compareAlphabetic(a: ScoredCandidate, b: ScoredCandidate): number {
  return a.result.relativePath.localeCompare(b.result.relativePath);
}

/**
 * Score every candidate and return a presentation-ready array per spec.
 *
 * Filter mode:
 *   - Empty/whitespace query → empty array (no rows)
 *   - Non-empty query → only candidates with a non-null score; sorted by
 *     compareScored
 *
 * Highlight mode:
 *   - Empty/whitespace query → all candidates, alphabetic, no matchData
 *     (no rows are "non-matched" when no query exists, so the dim color
 *     does NOT apply — see file-tree-search spec scenario)
 *   - Non-empty query → matched rows (compareScored) followed by non-matched
 *     rows (compareAlphabetic, no matchData on these)
 */
export function scoreAndSort(
  query: string,
  candidates: ReadonlyArray<FileTreeSearchResult>,
  mode: SearchMode,
): ScoredCandidate[] {
  const empty = isEmptyQuery(query);

  if (mode === "filter") {
    if (empty) {
      return [];
    }
    const matched: ScoredCandidate[] = [];
    for (const result of candidates) {
      const m = scoreOne(query, result);
      if (m) {
        matched.push({ result, matchData: m });
      }
    }
    matched.sort(compareScored);
    return matched;
  }

  // Highlight mode.
  if (empty) {
    return candidates.map((result): ScoredCandidate => ({ result })).sort(compareAlphabetic);
  }
  const matched: ScoredCandidate[] = [];
  const unmatched: ScoredCandidate[] = [];
  for (const result of candidates) {
    const m = scoreOne(query, result);
    if (m) {
      matched.push({ result, matchData: m });
    } else {
      unmatched.push({ result });
    }
  }
  matched.sort(compareScored);
  unmatched.sort(compareAlphabetic);
  return matched.concat(unmatched);
}
