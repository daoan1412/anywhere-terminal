# Tasks: fix-open-file-path-resolution

## 1. Resolver core

- [x] 1_1 Create `resolveCwdRelative(cwd, link, platform?)` helper
  - **Deps**: none
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Path resolution chain" → `resolveCwdRelative` algorithm; `design.md` D1
  - **Scope**: `src/providers/resolveCwdRelative.ts`
  - **Acceptance**:
    - Outcome: Exported pure function returns ordered candidate list per the spec algorithm. Uses `path.posix` when `platform !== "win32"`, `path.win32` otherwise. Handles: empty/undefined/non-absolute cwd (returns `[]`); single-segment link (degenerates to plain join); cwd trailing slash (filter-Boolean drops empty); case-insensitive Windows segment compare. Worked examples from `design.md` D1 pass.
    - Verify: unit src/providers/resolveCwdRelative.test.ts
  - **Plan**:
    1. Copy the typescript sketch from `design.md` D1 verbatim — it IS the contract.
    2. Add JSDoc citing `terminalLinkHelpers.ts:221-251` and noting `filter(Boolean)` as intentional divergence.

- [x] 1_2 Create `expandTildeAndFileUri(raw, homedir?)` helper
  - **Deps**: none
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirements "Tilde expansion in resolver", "file:// URI handling in resolver"; `design.md` D4, D5
  - **Scope**: `src/providers/pathPreprocess.ts`
  - **Acceptance**:
    - Outcome: Returns `{path, kind}` per the design interface. `file://` parsed via `vscode.Uri.parse(raw, true)` inside try/catch. Requires `scheme === "file"` AND empty `query` AND empty `fragment`; otherwise `kind = "passthrough-malformed"`. `~/...` and bare `~` expanded with injected `homedir`. `~user` left as-is (kind=passthrough). Plain absolute / plain relative → kind=passthrough.
    - Verify: unit src/providers/pathPreprocess.test.ts
  - **Plan**:
    1. Branch on `raw.startsWith("file://")` → try-parse via `vscode.Uri.parse`; validate scheme/query/fragment; return `{path: uri.fsPath, kind: "absolute-file-uri"}` on success, `{path: raw, kind: "passthrough-malformed"}` on failure or guard fail.
    2. Branch on `raw === "~"` → expand to `homedir ?? os.homedir()`; kind=tilde-expanded.
    3. Branch on `raw.startsWith("~/")` → replace leading `~` with `homedir`.
    4. Default: `{path: raw, kind: "passthrough"}`.

- [x] 1_3 Refactor `buildCandidates` to fan out per cwd source
  - **Deps**: 1_1, 1_2
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Path resolution chain"; `design.md` D2, D7
  - **Scope**: `src/providers/openFileLink.ts`
  - **Acceptance**:
    - Outcome: `buildCandidates` invokes `expandTildeAndFileUri` first; on `passthrough-malformed` returns `[]`; on absolute returns single candidate; otherwise loops `[liveCwd, currentCwd, initialCwd, ...workspaceFolders]` through `resolveCwdRelative`. `path.resolve`+Set dedup unchanged. Directory bit-mask check updated to `(fileStat.type & vscode.FileType.Directory) !== 0` (D7). Trace logger prints candidate count per source for diagnostics.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Replace `buildCandidates` body with the sketch from `design.md` D2.
    2. Delete per-source `path.join` calls (subsumed).
    3. Update the directory-skip check at `openFileLink.ts:278` to use the bit-mask form.
    4. Extend the trace logger to include `candidates from liveCwd: N, currentCwd: N, ...`.

- [x] 1_4 Add basename fallback to findFiles step with shared 2s timeout
  - **Deps**: 1_3
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Path resolution chain" → `findFiles fallback`; `design.md` D6
  - **Scope**: `src/providers/openFileLink.ts`
  - **Acceptance**:
    - Outcome: When `msg.path` contains a separator and the first `findFiles` returns 0 matches, the handler issues a second `findFiles` with `escapeGlob(basename(path))`, then filters `result.fsPath` ending with the OS-normalized clicked path. **Both invocations share ONE 2000ms timeout budget via a single `withTimeout` wrapping the basename-fallback sequence**, and share the same `CancellationTokenSource`. If timeout fires during the second call, the outer race rejects and falls through to "File not found".
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Wrap the full sequence (call 1, conditional call 2, filter) inside a single `withTimeout(..., 2000, () => cancelSource.cancel())`.
    2. Implement `endsWithPath(absPath, clickedPath, platform)` private helper — normalize separator, lower-case on win32.
    3. Reuse the existing `matches.length === 1 / >= 2` UX branch for the filtered set.
    4. Add timing tests: full-path takes 1900ms → basename call cancelled by shared budget.

## 2. Detection regex

- [x] 2_1 Broaden bare/suffixed pathBody and drop `file:` from URL reject list
  - **Deps**: none
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "File path detection in terminal output"; `design.md` D3
  - **Scope**: `src/webview/links/filePathParser.ts`, `src/webview/links/filePathParser.test.ts` (the existing test file documents OLD behavior for `file://` rejection + POSIX-backslash rejection; both are intentionally changing per spec, so the test is updated alongside the source)
  - **Acceptance**:
    - Outcome: Bare body is `[^\s'"<>(){}\[\]|]+` (POSIX and win32 — backslash naturally included per design D3). Parens REJECTED in bare body (only quoted forms permit parens). `URL_SCHEME_REGEX` is `/^(?:https?|ftp|ssh|git|mailto):/i` (drops `file`). Boundaries, dedup, version-string filter, perf caps all behave identically. Tests that documented dropped behaviors (`file://` URL-reject; POSIX backslash-reject) are updated to reflect the new spec.
    - Verify: unit src/webview/links/filePathParser.test.ts
  - **Plan**:
    1. Replace `pathBody` in `buildSuffixedRegex` / `buildBareRegex` with the new charset.
    2. Update `URL_SCHEME_REGEX`.
    3. Update tests that document the dropped behaviors: remove `file:///...` from the URL-reject `it.each`; flip the "POSIX backslash" test to assert detection.
    4. Run full test file; confirm everything still passes.

- [x] 2_2 Add detection tests for broadened charset + negative tests
  - **Deps**: 2_1
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "File path detection in terminal output"; `design.md` D3
  - **Scope**: `src/webview/links/filePathParser.test.ts`
  - **Acceptance**:
    - Outcome: Positive tests cover: `#`/`&` in path (`/Users/me/repo&main/file.ts`), `=` in path, `%` percent-encoded segment (`/Users/me/foo%20bar/file.md`), non-ASCII (`/Users/huy/projects/à/file.md`, `/Users/huy/projects/项目/file.md`), tilde (`~/foo.md`), `file:///abs/file.md`. Negative tests cover: `package@1.2.3` (not a file), `Version=1.2.3.4` (version string), `"foo.ts":` JSON key (no — actually it's a Python compact match, document expected behavior), git SHA ref `abc1234:src/foo.ts` (current parser captures `src/foo.ts:line`? — write a test asserting whichever behavior we want), `https://example.com/x` NOT matched, `(/Users/me/file.ts)` (parens) NOT detected as bare (must use quoted form), unquoted path with space `/Users/Bob Smith/file.ts` NOT detected (use quoted form).
    - Verify: unit src/webview/links/filePathParser.test.ts
  - **Plan**:
    1. Add one `it()` block per positive row.
    2. Add one `it()` block per negative row with the exact expected detection count (usually 0).
    3. For ambiguous cases (`"foo.ts":` and the git SHA), assert on the observed behavior of the patched regex; document in a code comment why.

## 3. Helper tests + mock extension

- [x] 3_1 Unit-test `resolveCwdRelative` with all spec worked examples + edges
  - **Deps**: 1_1
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Path resolution chain" → worked examples; `design.md` D1
  - **Scope**: `src/providers/resolveCwdRelative.test.ts`
  - **Acceptance**:
    - Outcome: Table-driven tests cover all 7 worked examples from `design.md` D1 (including `cwd=""`, trailing-slash cwd, win32 case-insensitive), plus: link with leading `./` (e.g. `./foo.md`), link with `..` (e.g. `../foo.md` — verify candidates still produced; resolver later rejects findFiles for traversal but `resolveCwdRelative` is pure), non-absolute cwd returns `[]`.
    - Verify: unit src/providers/resolveCwdRelative.test.ts
  - **Plan**:
    1. Build a `[cwd, link, platform, expected]` table covering every example.
    2. Add cases marked `// edge:` for empty cwd, non-absolute cwd, trailing slash.

- [x] 3_2 Unit-test `expandTildeAndFileUri` + extend vscode mock with `Uri.parse`
  - **Deps**: 1_2
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirements "Tilde expansion in resolver", "file:// URI handling in resolver"; `design.md` D5
  - **Scope**: `src/providers/pathPreprocess.test.ts`, `src/test/__mocks__/vscode.ts`
  - **Acceptance**:
    - Outcome: Mock `Uri.parse(raw, strict?)` handles the `file://` shape — parses scheme/authority/path/query/fragment, computes `fsPath` (Windows drive case included), throws when `strict && scheme === ""`. Tests cover: `~/foo` (expansion with injected homedir `/home/test`), bare `~`, `~user/foo` (passthrough), `file:///abs/file.md` (decoded), `file:///abs/foo%20bar.md` (percent-decoded), malformed `file://garbage` (passthrough-malformed), wrong scheme `file/whatever` (passthrough-malformed), `file:///abs/file.md?x=1` (passthrough-malformed — query non-empty), `file:///abs/file.md#frag` (passthrough-malformed — fragment non-empty), plain absolute (passthrough), plain relative (passthrough).
    - Verify: unit src/providers/pathPreprocess.test.ts
  - **Plan**:
    1. Extend `src/test/__mocks__/vscode.ts` adding `Uri.parse(raw, strict?)` that handles `file://` shape (scheme, authority, path, query after `?`, fragment after `#`); throw on `strict && !scheme`.
    2. Use `homedir = "/home/test"` for deterministic expansion tests.

## 4. Integration coverage in openFileLink

- [x] 4_1 Integration tests — cwd-suffix duplication (bug #1)
  - **Deps**: 1_3
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Path resolution chain"; `design.md` D1, D2
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: With `liveCwd = "/x/y/a"`, click `a/file.md` — `stat` rejects `/x/y/a/a/file.md`, accepts `/x/y/a/file.md` → handler opens `/x/y/a/file.md` with no toast. Same scenario but file actually at `/x/y/a/a/file.md` (deeper hit) → first candidate wins. Second variant: `initialCwd` and `currentCwd` set instead of liveCwd → same outcome. Third variant: cwd-suffix duplication across multi-root workspace (workspace folders `/p1`, `/p2/a`; click `a/file.md` while liveCwd unset) → workspace-fan-out tries both `/p1/a/file.md` and `/p2/a/a/file.md`, `/p2/a/file.md`.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Mock `deps.stat` to selectively reject/accept candidates by path.
    2. Assert the resolved path passed to `showTextDocument`.
    3. Add three `it()` blocks for the three variants.

- [x] 4_2 Integration tests — tilde + `file://` URI handling
  - **Deps**: 1_3, 3_2
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirements "Tilde expansion in resolver", "file:// URI handling in resolver"
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: `~/foo.md` resolves with injected homedir to `/home/test/foo.md`. `file:///abs/foo.md` resolves. `file:///abs/foo%20bar.md` resolves to `/abs/foo bar.md`. Malformed `file://garbage` shows "File not found" toast. `file:///abs/foo.md?x=1` shows "File not found" (query rejected).
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. One `it()` per scenario.

- [x] 4_3 Integration tests — basename fallback in findFiles
  - **Deps**: 1_4
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Path resolution chain" → `findFiles fallback`; `design.md` D6
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: Click `a/file.md`, all stat candidates miss, first `findFiles("**/a/file.md", ...)` returns `[]`, second `findFiles("**/file.md", ...)` returns three matches, only one's `fsPath` ends with `a/file.md` → handler opens that one with no quickPick. Two ending-matches → quickPick shown. Full-path consumes 1900ms (slow workspace) → basename call cancelled by shared timeout, "File not found" toast. No-workspace + initialCwd set → `RelativePattern` used for both calls.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Mock `deps.findFiles` with per-call delays + result sets.
    2. Assert call count and per-call arguments (include glob + RelativePattern.base).
    3. Test the timeout-during-second-call case explicitly.

- [x] 4_4 Integration test — symlink-to-directory falls through (D7)
  - **Deps**: 1_3
  - **Refs**: `design.md` D7
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: Candidate stat returns `{ type: FileType.Directory | FileType.SymbolicLink }` (=66). Handler treats as directory and falls through. If no file candidate hits, silent abort (no toast, no `findFiles`).
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Mock `deps.stat` to return symlinked-directory FileStat for one candidate; reject others.
    2. Assert `showTextDocument` NOT called; assert `deps.showError` NOT called.

- [x] 4_5 Integration tests — trust-base regression coverage
  - **Deps**: 1_3
  - **Refs**: `specs/terminal-clickable-file-paths/spec.md` Requirement "Out-of-scope confirm dialog" (unchanged), "Path resolution chain" → security note
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: After fan-out, the modal still appears when the resolved file is outside both `initialCwd` AND all `workspaceFolders`, regardless of whether `liveCwd` or `currentCwd` contained it. Asserts `liveCwd` is NOT in trust-bases (file inside liveCwd but outside initialCwd+workspace → modal shown). Asserts `currentCwd` is NOT in trust-bases (same scenario via `currentCwd`).
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Mock workspace = `/ws`, initialCwd = `/init`, liveCwd = `/live`. Resolved file at `/live/foo.md` → modal.
    2. Same but resolved at `/init/foo.md` → no modal.
    3. Same but resolved at `/ws/foo.md` → no modal.

- [x] 4_6 Integration test — dedup across multiple cwd sources
  - **Deps**: 1_3
  - **Refs**: `design.md` D2
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: Set up `liveCwd = currentCwd = initialCwd = workspaceFolders[0] = "/same"`; click `foo.md`. `deps.stat` is called exactly ONCE for `/same/foo.md` (dedup collapses identical candidates).
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Mock `deps.stat` with a counter; assert count is 1 after handler returns.

## 5. Manual smoke test + verification

- [/] 5_1 Manual smoke test — bug #1 cwd-suffix duplication + absolute-path latent fix (smoke.md template written; awaiting user EDH run)
  - **Deps**: 1_1, 1_2, 1_3, 1_4, 2_1
  - **Refs**: `discovery.md` user reproductions; `design.md` D2 (latent absolute-path concatenation bug)
  - **Scope**: `asimov/changes/fix-open-file-path-resolution/smoke.md` (new doc)
  - **Acceptance**:
    - Outcome: Builder launches Extension Development Host and documents in `smoke.md`: (a) Bug #1 reproduction — cd into a directory whose basename is `a`, `touch file.md`, `echo a/file.md`, click → opens `<cwd>/file.md` ✓. (b) Latent absolute-path bug from the user's trace — verify a click on an absolute path that DOES exist results in candidates = `[<absolute>]` only (no `path.join(cwd, absolutePath)` concatenation candidate). Confirm via the trace logger output.
    - Verify: manual — both scenarios documented as PASS in `smoke.md` with trace evidence
  - **Plan**:
    1. `pnpm run watch`, launch EDH.
    2. Repro bug #1: `mkdir -p /tmp/a && cd /tmp/a && touch file.md`, then `echo a/file.md` in the terminal and click → must open `/tmp/a/file.md`.
    3. Repro latent absolute-path fix: `touch /tmp/realfile.md`, then `echo /tmp/realfile.md`, click → opens; verify DevTools trace shows only one candidate (`/tmp/realfile.md`) not the concatenated form.
    4. Paste trace into `smoke.md`.

- [x] 5_2 Run full check + lint + tests
  - **Deps**: 1_1, 1_2, 1_3, 1_4, 2_1, 2_2, 3_1, 3_2, 4_1, 4_2, 4_3, 4_4, 4_5, 4_6
  - **Refs**: `asimov/project.md` § Commands
  - **Scope**: none (verification only — no edits)
  - **Acceptance**:
    - Outcome: `pnpm run check-types`, `pnpm run lint`, `pnpm run test:unit` all pass.
    - Verify: none — verification gate
  - **Plan**:
    1. Run each command, fix any failures, re-run.
