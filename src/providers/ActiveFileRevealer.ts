// src/providers/ActiveFileRevealer.ts — Per-webview listener that turns
// active-editor-tab changes into auto-reveal messages.
//
// See: specs/auto-reveal-active-file/spec.md, design.md D2-D8.

import * as path from "node:path";
import { Minimatch } from "minimatch";
import * as vscode from "vscode";
import { type FileTreeAutoRevealConfig, readFileTreeSettings } from "../settings/FileTreeSettingsReader";
import type { RevealInFileTreeMessage } from "../types/messages";

const DEBOUNCE_MS = 100;

// macOS HFS+/APFS + Windows NTFS are case-insensitive by default; Linux ext4 is not.
const NOCASE = process.platform !== "linux";

/**
 * Returns true when `relPosix` (workspace-relative POSIX path) OR any of its
 * ancestor folder paths matches any of `matchers`. Exported so tests can
 * exercise the ancestor-walk logic without the rest of the host wiring.
 *
 * The matcher input MUST already be POSIX-separator-normalized — see D8.
 */
export function matchesExclude(relPosix: string, matchers: ReadonlyArray<Minimatch>): boolean {
  if (matchers.length === 0 || relPosix.length === 0) {
    return false;
  }
  const parts = relPosix.split("/").filter((p) => p.length > 0);
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    for (const m of matchers) {
      if (m.match(candidate)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extracts a `file:`-scheme URI from a tab's input when the input is one of
 * the three shapes auto-reveal supports. Returns null for diffs, terminals,
 * webviews, untitled-only inputs, or any non-`file:` scheme.
 */
function extractFileUri(input: unknown): vscode.Uri | null {
  if (input instanceof vscode.TabInputText) {
    return input.uri.scheme === "file" ? input.uri : null;
  }
  if (input instanceof vscode.TabInputCustom) {
    return input.uri.scheme === "file" ? input.uri : null;
  }
  if (input instanceof vscode.TabInputNotebook) {
    return input.uri.scheme === "file" ? input.uri : null;
  }
  return null;
}

/**
 * Listens to `window.tabGroups.onDidChangeActiveTab` for one webview and posts
 * a `RevealInFileTreeMessage` when the active editor's file should be revealed
 * in that webview's file tree.
 *
 * Lifecycle: construct on webview attach, dispose on webview teardown.
 */
export class ActiveFileRevealer implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private matchersCache: Minimatch[] = [];
  private cachedPatternsKey = "";
  private readonly invalidPatternsLogged = new Set<string>();

  constructor(
    private readonly getWorkspaceRoot: () => string | null,
    private readonly post: (msg: RevealInFileTreeMessage) => void,
    private readonly readSettings: () => FileTreeAutoRevealConfig = readFileTreeSettings,
  ) {
    // VS Code 1.105 exposes onDidChangeTabs + onDidChangeTabGroups, NOT a
    // dedicated active-tab event. The reliable signal is reading
    // `tabGroups.activeTabGroup.activeTab` after either event fires.
    this.subs.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
    );

    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((ev) => {
        if (ev.affectsConfiguration("anywhereTerminal.fileTree.autoRevealExclude")) {
          // Force rebuild on next flush
          this.cachedPatternsKey = "";
          this.matchersCache = [];
        }
      }),
    );
  }

  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

  private flush(): void {
    // Re-read settings AFTER the debounce so a mid-flight toggle is honored.
    const settings = this.readSettings();
    if (settings.mode === "none") {
      return;
    }

    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      return;
    }
    const uri = extractFileUri(activeTab.input);
    if (!uri) {
      return;
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      return;
    }

    const rel = path.relative(root, uri.fsPath);
    // `rel === ".."` or `rel` starting with `".."` + sep means "above root".
    // A first-path-component like `..foo` (legal folder name) must NOT trip
    // this gate — guard against the literal parent-directory segment only.
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return; // outside the (first) workspace folder
    }

    const relPosix = rel.split(path.sep).join("/");
    const matchers = this.ensureMatchers(settings.excludePatterns);
    if (matchesExclude(relPosix, matchers)) {
      return;
    }

    this.post({
      type: "reveal-in-file-tree",
      absPath: uri.fsPath,
      focusNoScroll: settings.mode === "focusNoScroll",
      source: "autoReveal",
    });
  }

  private ensureMatchers(patterns: ReadonlyArray<string>): Minimatch[] {
    const key = patterns.join("\n");
    if (key === this.cachedPatternsKey && this.matchersCache.length === patterns.length) {
      return this.matchersCache;
    }
    const built: Minimatch[] = [];
    for (const p of patterns) {
      try {
        const mm = new Minimatch(p, { dot: true, nocase: NOCASE, matchBase: false });
        // minimatch is lenient about syntax — it won't throw on `[unclosed`,
        // it'll produce a matcher that compiles to a regex that may not match
        // anything sensible. `makeRe()` returns false when the pattern can't
        // be compiled; treat that as an invalid glob and drop it.
        if (mm.makeRe() === false) {
          this.warnInvalid(p, "failed to compile to regex");
          continue;
        }
        built.push(mm);
      } catch (err) {
        this.warnInvalid(p, (err as Error).message);
      }
    }
    this.matchersCache = built;
    this.cachedPatternsKey = key;
    return built;
  }

  private warnInvalid(pattern: string, reason: string): void {
    if (this.invalidPatternsLogged.has(pattern)) {
      return;
    }
    this.invalidPatternsLogged.add(pattern);
    console.warn(`[AnyWhere Terminal] autoRevealExclude: invalid glob '${pattern}' — ${reason}`);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs.length = 0;
    this.matchersCache = [];
    this.invalidPatternsLogged.clear();
  }
}
