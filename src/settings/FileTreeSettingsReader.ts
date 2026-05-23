// src/settings/FileTreeSettingsReader.ts — Reads anywhereTerminal.fileTree.* settings
// See: specs/auto-reveal-active-file/spec.md#requirement-disabled-state

import * as vscode from "vscode";

/** Normalized auto-reveal mode used by ActiveFileRevealer. */
export type AutoRevealMode = "reveal" | "none" | "focusNoScroll";

/** Resolved file-tree auto-reveal configuration. */
export interface FileTreeAutoRevealConfig {
  mode: AutoRevealMode;
  excludePatterns: ReadonlyArray<string>;
}

/** Default exclude patterns — mirrors VS Code's explorer.autoRevealExclude. */
const DEFAULT_EXCLUDE: Record<string, true> = {
  "**/node_modules": true,
  "**/bower_components": true,
};

// One-shot warn flag: we don't honor `when`-condition exclude values in v1.
let _warnedWhenCondition = false;

/**
 * Read `anywhereTerminal.fileTree.*` settings and return a normalized config.
 *
 * - autoReveal: `true` / `"true"` → `'reveal'`; `false` / `"false"` → `'none'`;
 *   `"focusNoScroll"` → `'focusNoScroll'`; anything else → `'reveal'` (default).
 * - autoRevealExclude: keep keys whose value is truthy (boolean `true`).
 *   Values that are objects (VS Code's `{ when: '...' }` shape) are ignored
 *   in v1 — logged once at warn level.
 */
export function readFileTreeSettings(): FileTreeAutoRevealConfig {
  const config = vscode.workspace.getConfiguration("anywhereTerminal.fileTree");
  const rawMode = config.get<boolean | string>("autoReveal", true);
  const rawExclude = config.get<Record<string, unknown>>("autoRevealExclude", DEFAULT_EXCLUDE);

  return {
    mode: normalizeMode(rawMode),
    excludePatterns: normalizeExclude(rawExclude),
  };
}

function normalizeMode(raw: unknown): AutoRevealMode {
  if (raw === true || raw === "true") {
    return "reveal";
  }
  if (raw === false || raw === "false") {
    return "none";
  }
  if (raw === "focusNoScroll") {
    return "focusNoScroll";
  }
  return "reveal";
}

function normalizeExclude(raw: Record<string, unknown> | null | undefined): ReadonlyArray<string> {
  if (!raw || typeof raw !== "object") {
    return Object.keys(DEFAULT_EXCLUDE);
  }
  const patterns: string[] = [];
  for (const [pattern, value] of Object.entries(raw)) {
    if (value === true) {
      patterns.push(pattern);
    } else if (value && typeof value === "object") {
      // 'when'-condition shape: keep the pattern (treat as 'true') and warn once
      if (!_warnedWhenCondition) {
        console.warn(
          `[AnyWhere Terminal] autoRevealExclude: pattern '${pattern}' has a 'when'-condition value, which is not honored in this version. Treating as 'true'.`,
        );
        _warnedWhenCondition = true;
      }
      patterns.push(pattern);
    }
  }
  return patterns;
}

// ─── Test helpers ───────────────────────────────────────────────────

/** Reset module-level state. Test-only. */
export function __resetFileTreeSettingsWarnings(): void {
  _warnedWhenCondition = false;
}
