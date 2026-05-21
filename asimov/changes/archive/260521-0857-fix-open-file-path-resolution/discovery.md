# Discovery — fix-open-file-path-resolution

## Workstreams

| Workstream | Outcome |
| --- | --- |
| Architecture Snapshot (finder) | Current resolver chain mapped — `src/providers/openFileLink.ts#L161-194` `buildCandidates`, `#L228-447` handler. Detection: `src/webview/links/filePathParser.ts#L62-113`. |
| External Research (finder over `/Users/huybuidac/Projects/ai-oss/vscode`) | VS Code resolver: `terminalLinkResolver.ts#L27-156`, **key algorithm** `terminalLinkHelpers.ts#L221-251` `updateLinkWithRelativeCwd`. Tests: `terminalLocalLinkDetector.test.ts#L33-95`. |

## Key Findings

### F1 — Cwd-suffix duplication is the dominant bug

Scenario: PTY cwd is `/x/y/a`, user clicks `a/file.md` (file actually at `/x/y/a/file.md`).

Current behaviour (`buildCandidates`, `openFileLink.ts:161-194`):
- Step 1 absolute → skipped (path is relative).
- Steps 2–4 (liveCwd/currentCwd/initialCwd) → all produce `path.join('/x/y/a', 'a/file.md')` = `/x/y/a/a/file.md` → **miss**.
- Step 5 workspace folder join → same miss.
- Step 6 `findFiles` with glob `**/a/file.md` → searches workspace for a file whose tail is literally `a/file.md` — `/x/y/a/file.md`'s tail is `file.md`, so **no match**.
- Result: "File not found" toast despite the file being right there.

This is the exact shape `tail -f /var/log/a/file.md` (or `ls a/file.md` after `cd /x/y/a`) produces — common.

### F2 — VS Code solves this with `updateLinkWithRelativeCwd`

`/Users/huybuidac/Projects/ai-oss/vscode/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkHelpers.ts:221-251`:

```typescript
const cwdPath = cwd.split(sep).reverse();
const linkPath = text.split(sep);
let commonDirs = 0;
const result: string[] = [];
while (i < cwdPath.length) {
  result.push(osPath.resolve(cwd + sep + linkPath.slice(commonDirs).join(sep)));
  if (cwdPath[i] === linkPath[i]) commonDirs++; else break;
  i++;
}
return result; // multiple candidates, most-specific first
```

Worked example (from VS Code source comments):
- cwd `/home/common`, text `common/file.md` → candidates `['/home/common/common/file.md', '/home/common/file.md']`.
- cwd `/x/y/a`, text `a/file.md` → candidates `['/x/y/a/a/file.md', '/x/y/a/file.md']`. Second hits (cwd-join with first link segment stripped).

Each cwd source (liveCwd, currentCwd, initialCwd) and each workspaceFolder should fan out into this candidate set, not a single join.

### F3 — Absolute-path failure is most likely a *display* artefact

Re-walked the absolute case in `buildCandidates`:
- `isAbsolutePath('/Users/.../a/file.md')` → true (POSIX `/^\//`).
- `push(msg.path)` → `path.resolve` → same path → `fs.stat` succeeds if file exists.

No code-path bug for a clean absolute path. Plausible regression sources:
- **Detection regex `pathBody = [\w./@~+\-]+`** rejects characters that legitimately appear in user homes / repo names: spaces (`/Users/My Name/…`), parentheses, `#`, `&`, non-ASCII (Vietnamese diacritics, CJK). VS Code's regex (`terminalLinkParsing.ts:212`) is much broader: `[^\s\|<>\[\({][^\s\|<>]*` — *anything except whitespace and a small set of delimiters*.
- **Boundary `(?<=^|[\s'"<({\[])`** rejects mid-token starts but is fine for typical terminal output. Not the issue.
- **`TRAIL_PUNCT_REGEX = /[.,;:!?]+$/`** trims trailing punctuation. If a terminal output is `… /Users/x/a/file.md.` (sentence end) the trailing `.` is trimmed correctly. But if the absolute path itself ends in `.md` and is followed by `…/file.md:42` the suffixed regex should fire first — fine.

Working hypothesis: the user's absolute-path example is the same file as the relative-path example, displayed via something like `Compiled /Users/huybuidac/.../a/file.md` where the path contains a character the bare regex rejects. Concrete evidence needed at build time (capture `msg.path` from the real failing case), but this is the only credible explanation given the code.

### F4 — `findFiles` fallback is fragile for relative paths

Even after the suffix-removal fix, `findFiles` is invoked with `**/<path>`. When `<path>` contains a slash (e.g. `a/file.md`), VS Code's `RelativePattern` / glob engine matches files whose **trailing segments** equal that pattern. So `**/a/file.md` only matches if some directory `a/` contains `file.md` directly — it won't find `/x/y/a/file.md` if the workspace root is `/x/y` (the file's relative path is `a/file.md` — that *would* match, ok). So this is fine when workspace == parent. It still misses when only the basename is desired (clicking `a/file.md` should also try `file.md` workspace-wide). VS Code's `TerminalSearchLinkOpener` (`terminalLinkOpeners.ts:180-251`) does an additional "exact-suffix filter" on results — we don't.

### F5 — Detection regex divergence

VS Code regex (broad, `[^\s\|<>\[\({][^\s\|<>]*`) accepts almost anything; ours (narrow, `[\w./@~+\-]+`) rejects spaces, parens, `#`, `&`, non-ASCII. This is the most likely culprit for "absolute paths don't open" — they aren't even being **detected**, so no link, no click, no resolver call.

## Gap Analysis

| Gap | Spec source today | What needs to change |
| --- | --- | --- |
| G1 | `terminal-clickable-file-paths` Requirement "Path resolution chain" step 2/3/4: single `path.join` per cwd source | Each cwd source MUST fan out into N candidates via cwd-vs-link reverse-segment matching (VS Code `updateLinkWithRelativeCwd`). |
| G2 | `terminal-clickable-file-paths` step 6: `findFiles` uses `**/<path>` only | Add basename fallback when `<path>` contains a separator and the full-path search returns 0 results — search by basename, then filter results whose suffix matches `<path>`. |
| G3 | `terminal-clickable-file-paths` "File path detection" — narrow body `[\w./@~+\-]+` | Broaden path body to accept spaces, parens, `#`, `&`, non-ASCII chars; align with VS Code's "anything except whitespace+delimiters" model. Must preserve URL rejection + version-string heuristic. |
| G4 (deferred) | No tilde expansion | Spec says nothing about `~/path`. VS Code expands `~` to user home. Out of scope unless user requests. |
| G5 (deferred) | No `file://` URI handling in resolver | Spec says nothing. VS Code handles `file:///…` directly. Out of scope. |

## Options

| Option | Scope | Risk | Effort | Notes |
| --- | --- | --- | --- | --- |
| **A. Port VS Code's `updateLinkWithRelativeCwd` + broaden detection regex + basename fallback** (Recommended) | G1 + G2 + G3 | LOW–MED | ~S (≤1d) | Closes both reported bugs and the regression-prone path-with-spaces case. Algorithm is well-tested upstream — direct port. |
| B. Suffix-removal only (G1) | G1 | LOW | XS | Fixes bug #1 only. Bug #2 (absolute path with spaces / unusual chars) remains. |
| C. Full VS Code parity — port detector, resolver, opener, capability-aware CWD | G1 + G2 + G3 + tilde + file:// + URI verify | MED | L (>3d) | Overkill for a bug fix; introduces architecture coupling to upstream module shapes. |
| D. Add a debug logger and ask user for trace before fixing | none | LOW | XS | Already have trace logging in `openFileLink.ts:258`. User would have to reproduce + paste DevTools log. Doesn't fix anything. |

## Risks

- **R1 (regex broadening)**: a wider detection regex underlines noise (e.g. arbitrary tokens containing `.`). Mitigation: keep `looksLikeFile` heuristic (separator OR valid extension AND not a version string), add a max-length cap per match.
- **R2 (multiple candidates per cwd source)**: candidate count grows from O(cwd_sources) to O(cwd_sources × cwd_depth). For deep cwds (`/a/b/c/d/e/f`) this is ≤ 6 extra stats — bounded and fast. Mitigation: existing dedup `seen` Set already handles cross-source duplicates.
- **R3 (security — path traversal)**: broader detection + more candidates do NOT change the trust boundary; absolute escape-from-workspace still triggers the modal at `openFileLink.ts:432`. No new attack surface.
- **R4 (basename fallback false positives)**: searching workspace for `file.md` when user clicked `a/file.md` could surface a different file. Mitigation: only trigger when full-path search yields 0 results AND filter by trailing-segment match (VS Code's approach).

## Open Questions

- (Q1) For the absolute-path bug: do we have a real reproduction with the *literal* characters the user clicked? If the bug is detection regex (likely), we want a test case using the actual problematic path. **Will surface at Gate 1** — if user confirms F5 hypothesis, F3 is fully explained.
- (Q2) Performance budget for the candidate fan-out: at most how many `fs.stat` calls per click before bailing? Suggest soft cap of 16 across all cwd sources combined (4 cwd sources × 4-deep average). Recorded in design if we choose Option A.

## Recommendation

**Option A**. Closes both reported bugs definitively by porting the algorithm VS Code itself uses, plus the detection-regex broadening that is the most plausible root cause of bug #2. Bounded blast radius — no spec restructuring, additive to the resolution chain, no new dependencies. Builder reads VS Code source as reference, not a runtime dependency.
