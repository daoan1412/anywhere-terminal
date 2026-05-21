# Design: fix-open-file-path-resolution

## Decisions

### D1: Port VS Code's `updateLinkWithRelativeCwd` as `resolveCwdRelative`

Reference: `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkHelpers.ts:221-251`.

Algorithm reverse-walks the cwd segments and the link segments together. While both share a prefix from the end (cwd) and start (link), we know the link's leading segments might be re-encoding the cwd's trailing segments — so each "common segment" generates an additional candidate with that link prefix stripped. The first candidate is always `cwd/<full link>`, each subsequent strips one leading link segment.

```typescript
// src/providers/resolveCwdRelative.ts
import * as path from "node:path";

export function resolveCwdRelative(
  cwd: string,
  link: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!cwd) return [];
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(cwd)) return [];
  const sep = platform === "win32" ? "\\" : "/";
  const splitRe = platform === "win32" ? /[\\/]+/ : /\/+/;
  const cwdParts = cwd.split(splitRe).filter(Boolean).reverse();
  const linkParts = link.split(splitRe).filter(Boolean);
  // Single-segment link (no separator) → degenerates to plain join.
  if (linkParts.length <= 1) return [p.resolve(p.join(cwd, link))];
  const eq = platform === "win32"
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;
  const out: string[] = [];
  let common = 0;
  for (let i = 0; i < cwdParts.length; i++) {
    out.push(p.resolve(cwd + sep + linkParts.slice(common).join(sep)));
    if (cwdParts[i] !== undefined && linkParts[i] !== undefined && eq(cwdParts[i], linkParts[i])) {
      common++;
    } else {
      break;
    }
  }
  return out;
}
```

**Worked examples (matching the spec)**:

- `cwd=/x/y/a`, `link=a/file.md` → `['/x/y/a/a/file.md', '/x/y/a/file.md']` (first candidate is plain join; second strips `a` from link because `cwd` ends with `a`).
- `cwd=/home/common`, `link=common/file.md` → `['/home/common/common/file.md', '/home/common/file.md']` (VS Code source comment example).
- `cwd=/x/y`, `link=a/file.md` → `['/x/y/a/file.md']` (loop pushes once, then breaks because `y !== a`).
- `cwd=/x/y/a`, `link=file.md` → `['/x/y/a/file.md']` (single-segment short-circuit).
- `cwd=` or `undefined` → `[]`.
- `cwd=/x/y/a/` (trailing slash) → behaves identical to `/x/y/a` (filter(Boolean) drops the empty segment).
- `cwd=C:\X\A`, `link=a\file.md`, platform=win32 → `['C:\\X\\A\\a\\file.md', 'C:\\X\\A\\file.md']` (case-insensitive).

**Rejected alternatives**:

- Plain `path.join` with a one-shot "strip cwd basename if it equals link first segment" hack — misses the multi-segment case `cwd=/x/a/b` + `link=a/b/file` (needs two strips).
- Using host `path` directly — cross-platform tests need to inject behaviour; using `path.posix`/`path.win32` lets the test harness exercise both without process spoofing.
- VS Code's exact `osPath.join` style — kept the explicit `cwd + sep + ...` form because `join` would normalize away leading dots in cwd's last segment in a way that diverges from the reference implementation in edge cases. Behaviour matches reference; only the internal mechanics differ.

`filter(Boolean)` is an INTENTIONAL divergence from the VS Code source (which uses raw split). Reason: callers may have minor inconsistencies (`liveCwd` from `lsof` sometimes has a trailing `/`, OSC 7 emitters too) and the resulting empty-segment in the reversed array would corrupt the comparison. Tested explicitly.

### D2: Fan-out per cwd source; deduplicate via `path.resolve` + Set

`buildCandidates` becomes:

```typescript
function buildCandidates(msg: OpenFileMessage, deps: OpenFileLinkDeps, liveCwd: string | undefined): string[] {
  const { path: transformed, kind } = expandTildeAndFileUri(msg.path);
  if (kind === "passthrough-malformed") return [];
  if (isAbsolutePath(transformed)) return [path.resolve(transformed)];
  const sources: (string | undefined)[] = [
    liveCwd,
    deps.getCurrentCwd(msg.sessionId),
    deps.getInitialCwd(msg.sessionId),
    ...(deps.workspaceFolders?.map(f => f.uri.fsPath) ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cwd of sources) {
    if (!cwd) continue;
    for (const c of resolveCwdRelative(cwd, transformed)) {
      const n = path.resolve(c);
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}
```

**Bound**: candidate count is O(Σ cwd_depth) across (3 PTY cwd sources + N workspace folders). A typical 4-source × ~6-deep cwd produces ~24 entries; a multi-root workspace with 5 folders could push it to ~50. Each candidate is one `fs.stat` (warm cache: < 1 ms). No hard cap is added; if a future perf measurement shows pain, the dedup Set + early-break inside the algorithm are the natural levers. Symlink loops do NOT factor in — `stat` is non-recursive and only inspects the target path.

### D3: Broaden detection regex to VS Code parity, minus parens

Reference: `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts:212`.

New body charset: `[^\s'"<>(){}\[\]|]+` (POSIX and win32 — backslash is non-whitespace non-delimiter, so naturally included). Parens are REJECTED in the bare body for two reasons:

- VS Code's `[^\s|<>\[\({][^\s|<>]*` body permits `(` mid-token but not as the first char; that's complex and frequently confused with the existing suffix grammar `(LINE,COL)`. Refusing parens in the bare body removes the ambiguity entirely.
- Bare paths with parens are uncommon outside macOS user folders (e.g. `/Users/Bob (work)/file.ts`). Users can always wrap in quotes (`"..."`) to bring them into the detector.

`URL_SCHEME_REGEX` MUST become `/^(?:https?|ftp|ssh|git|mailto):/i` — `file:` is dropped so `file://` URIs pass through to the resolver. `looksLikeFile` and the version-string filter are unchanged; they still reject `Version=1.2.3.4` and `package@1.2.3`.

**Rejected alternative**: keeping the narrow body `[\w./@~+\-]+`. Doesn't accept `#`, `&`, `=`, `%`, or non-ASCII; misses legitimate paths in repos with hash-suffixed dirs, encoded segments, or Asian/accented user names.

### D4: Tilde expansion lives in resolver, not detector

Reasoning: the detector should preserve what the user clicked (matched `text` = what is underlined). Expansion to a real path is the resolver's job. Tests inject `homedir` so behaviour is deterministic.

### D5: `file://` URI handling via `vscode.Uri.parse` with scheme/query/fragment guards

`vscode.Uri.parse(path, true)` with `strict=true` validates basic shape and throws on empty scheme. We additionally REQUIRE:

- `uri.scheme === "file"` (rejects bizarre inputs like `file/whatever` that parse but aren't real `file://`).
- `uri.query === ""` AND `uri.fragment === ""` (a path containing literal `?` or `#` could otherwise be parsed as query/fragment and silently mangled).
- `uri.fsPath` non-empty.

Wrapped in try/catch — malformed URIs fall through silently to "File not found". Tests cover: well-formed `file:///abs/file.md`, percent-encoded `file:///abs/foo%20bar.md`, malformed `file://garbage`, wrong scheme `file/whatever`, with query `file:///abs/file.md?x=1`, with fragment `file:///abs/file.md#frag`.

`vscode.Uri.parse` is NOT present in the existing test mock at `src/test/__mocks__/vscode.ts`; task 3_2 adds a minimal implementation (parse `file://...` shape, expose `scheme`/`fsPath`/`query`/`fragment`/`authority`; throw on malformed when `strict=true`).

**Rejected alternative**: hand-rolled URL decoder. Misses Windows drive-letter weirdness (`file:///c:/...`) that `vscode.Uri.parse` handles correctly.

### D6: Basename fallback in `findFiles` with one shared timeout

When the clicked text is `a/file.md` and workspace tree contains the file as `<root>/a/file.md` (full match) OR as `<root>/sub/a/file.md` (where `**/a/file.md` matches), the existing glob is sufficient. The case the basename fallback addresses: workspace `/x/y`, click `a/file.md`, real file at `/x/y/a/file.md` — `**/a/file.md` DOES match this. But: workspace `/x/y/a`, click `a/file.md`, real file at `/x/y/a/file.md` — `**/a/file.md` does NOT match (no `a/` subdir to match against from workspace root). The fan-out from D1 handles this directly; basename fallback is the safety net for cases where the cwd is misaligned with workspace folders (e.g. user runs the terminal `cd`'d into a non-workspace path).

Implementation contract:

- One `vscode.CancellationTokenSource` covers both invocations.
- `withTimeout` wraps the ENTIRE basename-fallback sequence (full-path search → if 0, basename search → filter). Total budget: 2000ms.
- If full-path returns ≥1, do NOT do the basename query (don't waste budget; the user's clicked text matched something concrete).
- If full-path returns 0 AND `path.includes(sep)`, issue basename query reusing the same token; filter results by `endsWithPath(uri.fsPath, msg.path)` where `endsWithPath` normalizes `/` vs `\` to the OS separator and matches case-insensitively on Windows.
- If timeout fires during basename query, the outer race rejects and we fall through to "File not found" with the trace.

**Rejected alternative**: split the budget 1000ms + 1000ms. Asymmetric — the full-path query is usually faster (more specific glob), and a slow workspace shouldn't double-pay.

### D7: Symlink-to-directory check via Directory-bit mask

`vscode.FileType` is a bit field (`File=1, Directory=2, SymbolicLink=64, Unknown=0`). Current check `fileStat.type === vscode.FileType.Directory` (strict equality with `2`) misses any FileType combined with `SymbolicLink`. Change to:

```typescript
if ((fileStat.type & vscode.FileType.Directory) !== 0) { /* directory, fall through */ }
```

This is correct independent of what bit combination the underlying provider chooses: if the provider sets the Directory bit, we treat the entry as a directory. Whether the provider reports `66` (Directory|SymbolicLink) or just `64` for a symlink-to-directory is provider-specific and not relied on by this check.

### D8: Bug #2 (absolute-path failure) — RESOLVED as false alarm; latent `path.join(cwd, absolute)` bug found

User-supplied trace (2026-05-21) for the originally-reported "absolute path doesn't open" case:

```
msg.path="/Users/huybuidac/Projects/gmi/arco-contract/arco-audit.md"
liveCwd=/Users/huybuidac/Projects/gmi/arco-contract
initialCwd=/Users/huybuidac/Projects/gmi/arco-contract
workspaceFolders=["/Users/huybuidac/Projects/gmi/arco-contract"]
stat(/Users/huybuidac/Projects/gmi/arco-contract/arco-audit.md) → FileNotFound
stat(/Users/huybuidac/Projects/gmi/arco-contract/Users/huybuidac/Projects/gmi/arco-contract/arco-audit.md) → FileNotFound
findFiles skipped (absolute=true traversal=false)
```

User confirmed the file genuinely did not exist on disk — the toast was correct behaviour. Bug #2 is closed as USER-ERROR.

However, the trace exposes a **latent code-path defect**: candidate #2 is `path.join(liveCwd, msg.path)` where `msg.path` is absolute. Node's `path.join` does NOT short-circuit on an absolute second argument — it strips the leading separator and concatenates, producing the meaningless `/cwd/<full-absolute-path-without-leading-slash>`. The current code at `openFileLink.ts:175-187` generates this for every cwd source, polluting the candidate list with N "double-rooted" paths that can never resolve. The D2 short-circuit (`if (isAbsolutePath(transformed)) return [path.resolve(transformed)]`) eliminates this latent bug as a free side effect.

Task `5_1` smoke test verifies the latent fix: clicking an existing absolute path on the EDH should produce a candidate list with exactly ONE entry (the absolute path itself), not two-or-more bogus concatenations.

## Interfaces

### `resolveCwdRelative` helper

```typescript
// src/providers/resolveCwdRelative.ts
export function resolveCwdRelative(
  cwd: string,
  link: string,
  platform?: NodeJS.Platform,
): string[];
```

- Pure function, no I/O.
- `cwd` MUST be absolute; returns `[]` for empty/falsy/non-absolute.
- `link` MAY be relative or already-absolute; if absolute, caller is expected to short-circuit before invoking; algorithm safely degenerates if invoked anyway.
- Platform parameter defaults to `process.platform`; tests inject `"linux"` / `"win32"` to verify case sensitivity and separator handling.

### `expandTildeAndFileUri` helper

```typescript
// src/providers/pathPreprocess.ts
export type PathKind = "absolute-file-uri" | "tilde-expanded" | "passthrough" | "passthrough-malformed";
export function expandTildeAndFileUri(
  raw: string,
  homedir?: string,
): { path: string; kind: PathKind };
```

- `homedir` injectable for tests; defaults to `os.homedir()`.
- For malformed `file://` (parse throws, wrong scheme, non-empty query/fragment) returns `{ path: raw, kind: "passthrough-malformed" }`. Caller treats this as "definitely not openable" and short-circuits to "File not found".

### `endsWithPath` helper (used by D6)

```typescript
// inside src/providers/openFileLink.ts (private)
function endsWithPath(absPath: string, clickedPath: string, platform?: NodeJS.Platform): boolean;
```

- Normalizes separator differences. On Windows, comparison is case-insensitive.

## Risk Map

| Component | Risk | Mitigation |
| --- | --- | --- |
| `filePathParser` broadened body `[^\s'"<>(){}\[\]|]+` | False-positive underlines: `package@1.2.3`, ANSI escape codes, JSON keys like `"foo.ts":`, git SHA refs like `abc1234:src/foo.ts`. | Existing `looksLikeFile` + version-string filter + URL rejection still apply. Task 2_2 ADDS negative tests for each pattern. If a regression slips, the change is reverted in isolation (regex live in one file). |
| `resolveCwdRelative` candidate count growth | More `fs.stat` per click (~24 typical, ~50 multi-root). | Set-based dedup collapses duplicates across sources. `fs.stat` warm < 1 ms; total < 50 ms. Measured during build (manual smoke); if > 100 ms, add hard cap of 32. |
| Out-of-scope modal triggered more often | Resolution now succeeds for paths the old chain missed; some land outside both workspace and `initialCwd` → modal pops. | Acceptable cost of fixing the resolver. Trust-bases UNCHANGED (cwd + workspaceFolders only). `currentCwd` and `liveCwd` both explicitly excluded from trust-bases — calling this out in the spec so a future change can revisit with security review. |
| `vscode.Uri.parse(path, true)` semantics | Strict mode only throws on empty scheme; can silently accept paths with `?`/`#` as query/fragment, corrupting the resolved path. | Hard scheme=file + empty-query + empty-fragment guards in D5; test cases for `file://...?x=1` and `file://...#frag` both fall through to "File not found". |
| `vscode.Uri.parse` missing from test mock | Existing mock at `src/test/__mocks__/vscode.ts` has `Uri.file` and `Uri.joinPath` but no `Uri.parse`. Tests for D5 break. | Task 3_2 extends the mock with a minimal `Uri.parse` that handles `file://...` shape. |
| `findFiles` shared timeout | Without a shared budget, sequential calls could give 4s total click latency. | D6 mandates a single `withTimeout` wrapping the full sequence; task 1_4 explicitly tests timeout during the second call. |
| Symlink-to-directory currently opens as text | Existing latent bug exposed when users click a symlinked directory; not directly user-reported but on the critical path. | Bit-mask check in D7. Unit test mocks `FileType.Directory | FileType.SymbolicLink`. |
| Bug #2 root cause unknown | Plan lands but absolute-path case still fails. | **Mitigation is procedural, not technical**: task `0_1` reproduces bug #2 on current `main` BEFORE coding (D8). No resolver/detector code is touched until the failing layer is identified and a regression test is staged. Builder reports back via `bug2-repro.md` in the change folder. |
| Spec MODIFIED requirement churn | `asm change apply` replaces the resolution chain wholesale; reviewers must diff manually. | Spec re-states ALL preserved contracts (exclude glob string, NaN/Infinity/throw fallback for maxResults, `escapeGlob` meta-char list, `..` traversal skip, `RelativePattern` when no workspace, `currentCwd` exclusion). Diff against archived spec verifies no contract drops silently. |

## Constraints

- **No new dependencies.** All helpers use Node `path`, `os`, `node:fs/promises` and existing `vscode` API.
- **`vscode.Uri.parse` exists in the extension host** (no version bump). The test mock at `src/test/__mocks__/vscode.ts` is updated by task 3_2 to add a minimal stub.
- **Test harness is Vitest** (`pnpm run test:unit`). Tests are co-located next to source (no `__tests__/` subdir) per existing convention (see `src/providers/openFileLink.test.ts`).
- **Manual reproduction in task 0_1** runs against the Extension Development Host (`pnpm run watch` + F5 in VS Code) — not in CI.
