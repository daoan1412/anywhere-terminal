## 1. OSC parser

- [x] 1_1 Implement `oscParser` module
  - **Deps**: none
  - **Refs**: specs/terminal-cwd-tracking/spec.md `OSC 7 cwd detection`, `OSC 633 cwd detection`, `Chunk-boundary handling`, `Sanitization before storage`; design.md D2, D3, D4, Interfaces §`oscParser.ts`; docs/research/20260521-osc7-implementation.md
  - **Scope**: `src/pty/oscParser.ts`
  - **Acceptance**:
    - Outcome: Module exports `OscParser` interface and `createOscParser()` factory. `feed(chunk, onCwd)` maintains a pending buffer capped at 4096 bytes (truncates to last 128 on overflow), scans for `\x1b]7;...BEL|ST` and `\x1b]633;P;Cwd=...BEL|ST`, sanitizes per D3 (URL-decode OSC 7 only, `path.resolve`, reject non-absolute, reject null bytes), and invokes `onCwd(cwd)` for accepted updates. Unknown OSCs are skipped past their terminator without calling `onCwd`.
    - Verify: unit src/pty/oscParser.test.ts
  - **Plan**:
    1. Create the file with the interface from Interfaces §.
    2. Implement the `feed` loop per D4 algorithm in design.md Interfaces.
    3. Sanitization per D3 — wrap `new URL` + `decodeURIComponent` in try/catch; check `path.isAbsolute` and `\0`.
    4. Drop to last 128 bytes on MAX_PENDING overflow.

- [x] 1_2 Test `oscParser` exhaustively
  - **Deps**: 1_1
  - **Refs**: specs/terminal-cwd-tracking/spec.md `OSC 7 cwd detection`, `OSC 633 cwd detection`, `Chunk-boundary handling`, `Sanitization before storage`, `Pass-through guarantee`; design.md D2-D4
  - **Scope**: `src/pty/oscParser.test.ts`
  - **Acceptance**:
    - Outcome: Test suite covers: (a) OSC 7 with BEL terminator → onCwd called with decoded path; (b) OSC 7 with ST (ESC \\) terminator → same; (c) OSC 7 with URL-encoded chars (e.g. `file:///foo%20bar/baz`) → decodes to `/foo bar/baz`; (d) OSC 633 `P;Cwd=/foo/bar` → onCwd called with `/foo/bar` (no URL decode); (e) parametric "split chunk at every byte offset" test for a known OSC 7 sequence — asserts onCwd called exactly once for each split; (f) malformed `file:` URL → no call, no throw; (g) non-absolute payload (e.g. `relative/path`) → no call; (h) null-byte payload (`file:///foo\0bar`) → no call; (i) MAX_PENDING overflow: feed 5000 bytes starting with `\x1b]7;` no terminator → no crash, no call, internal buffer bounded; (j) interleaved unknown OSCs followed by OSC 7 — must cover OSC 0 (title), OSC 8 (hyperlink), OSC 52 (clipboard), OSC 1337 (iTerm) → only OSC 7 triggers onCwd; (k) property/fuzz test: feed 200 randomly-generated chunks each containing a mix of ESC/BEL/ST/partial OSCs/complete OSCs (mix of OSC 7, OSC 633, OSC 52, random unknown) and assert the parser never throws AND the concatenation of `onData` chunks delivered to a forwarding sink equals the concatenation of inputs. All tests pass.
    - Verify: unit src/pty/oscParser.test.ts
  - **Plan**:
    1. Build a small helper to construct test sequences (e.g. `osc7(path, term)` returns `"\x1b]7;file://host" + encodeURI(path) + term`).
    2. Use `describe.each` for terminator variants × path variants.
    3. For the chunk-split test, iterate offsets 1..len(sequence)-1, slice into two parts, feed both, assert callback fires exactly once with the right path.
    4. Assert the parser does NOT call `onCwd` for rejected payloads (malformed URL, relative, null byte, unknown OSC including OSC 0, 8, 52, 1337).
    5. For MAX_PENDING test, feed `"\x1b]7;" + "A".repeat(5000)` without terminator; assert no callback, no exception.
    6. For the property/fuzz test: generate 200 chunk sequences using a seeded PRNG. Each sequence is 1-50 chunks; each chunk has random bytes drawn from `{printable ASCII, ESC, BEL, complete OSC 7 with valid path, complete OSC 633, OSC 52 payload, unknown ESC sequence}`. After feeding all chunks via `parser.feed`, assert (i) no throw, (ii) any `onCwd` calls were absolute paths, (iii) when wired through a forwarding sink that records what `feed` was called with, the joined input equals the joined recorded output.

## 2. SessionManager state

- [x] 2_1 Add `currentCwd` field + setter/getter to SessionManager
  - **Deps**: none
  - **Refs**: specs/terminal-cwd-tracking/spec.md `SessionManager cwd surface`; design.md D5, Interfaces §`SessionManager additions`
  - **Scope**: `src/session/SessionManager.ts`, `src/session/SessionManager.test.ts`
  - **Acceptance**:
    - Outcome: `TerminalSession` interface has `currentCwd?: string` alongside the existing `initialCwd?`. `SessionManager.setCurrentCwd(sessionId, cwd)` updates the field for an existing session and silently no-ops for an unknown id. `SessionManager.getCurrentCwd(sessionId)` returns the stored value or `undefined`.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Add `currentCwd?: string` to `TerminalSession` (next to `initialCwd?`).
    2. Add public `setCurrentCwd(sessionId, cwd): void` — look up session, set field, no error on unknown id.
    3. Add public `getCurrentCwd(sessionId): string | undefined` — symmetric to `getInitialCwd`.
    4. Add 4 unit tests under `describe("SessionManager: getCurrentCwd")`: (a) returns undefined when never set; (b) returns the value after setCurrentCwd; (c) returns the latest value after multiple sets; (d) returns undefined for an unknown sessionId; (e) setCurrentCwd no-ops silently for unknown id.

## 3. PtySession wiring

- [x] 3_1 Wire OSC parser into PtySession + provide setter sink
  - **Deps**: 1_1
  - **Refs**: specs/terminal-cwd-tracking/spec.md `Pass-through guarantee`; design.md D1, D9, Interfaces §`PtySession.ts change`
  - **Scope**: `src/pty/PtySession.ts`, `src/pty/PtySession.test.ts`
  - **Acceptance**:
    - Outcome: `PtySession` owns one `OscParser` instance per session. New public method `setCurrentCwdSink(fn: (cwd: string) => void): void` registers a callback. In the existing `ptyProcess.onData` handler, the chunk is first passed to `oscParser.feed(data, sink)` (if sink registered), then forwarded UNCHANGED to the existing `_onData` user callback. A new test asserts byte-identical pass-through.
    - Verify: unit src/pty/PtySession.test.ts
  - **Plan**:
    1. Import `createOscParser` from `./oscParser`.
    2. Add private `_oscParser = createOscParser()` and `_setCurrentCwd?: (cwd: string) => void` to the class.
    3. Add public `setCurrentCwdSink(fn): void { this._setCurrentCwd = fn; }`.
    4. In the `onData` handler (around L124-131 per discovery.md), invoke `if (this._setCurrentCwd) this._oscParser.feed(data, this._setCurrentCwd);` BEFORE the existing `_onData` invocation. Original `data` flows to `_onData` unchanged.
    5. Add unit test: install sink, emit a known OSC 7 sequence via `getControls().emitData(...)`, assert sink fires with decoded cwd AND the user's `onData` callback also received the same chunk byte-for-byte.
    6. Add pass-through test: emit a random non-OSC binary chunk; assert user `onData` received exactly that chunk.

- [x] 3_2 Wire SessionManager → PtySession sink at spawn
  - **Deps**: 2_1, 3_1
  - **Refs**: design.md D1, D5
  - **Scope**: `src/session/SessionManager.ts`, `src/session/SessionManager.test.ts`
  - **Acceptance**:
    - Outcome: In `SessionManager.createSession`, after `pty.spawn(...)` and before wiring `pty.onData`, call `pty.setCurrentCwdSink((cwd) => this.setCurrentCwd(id, cwd))`. When the mocked PTY emits an OSC 7 sequence, the session's `getCurrentCwd(id)` returns the decoded path. The existing onData wiring continues to deliver raw data to OutputBuffer.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Locate `pty.spawn(nodePty, resolvedShell, resolvedArgs, { cwd, env });` in `createSession`.
    2. Immediately after, add `pty.setCurrentCwdSink((cwd) => this.setCurrentCwd(id, cwd));`.
    3. Add unit test in SessionManager.test.ts: create a session, retrieve the underlying mock PTY (from `mockPtySessions`), trigger its onData with `"\x1b]7;file:///tmp/foo\x07"`, assert `sm.getCurrentCwd(id) === "/tmp/foo"`.

## 4. Opener resolver extension

- [x] 4_1 Extend `OpenFileLinkDeps` with `getCurrentCwd` and `findFiles`
  - **Deps**: 2_1
  - **Refs**: specs/terminal-cwd-tracking/spec.md `Path resolution chain`; design.md D6, D7, D8, Interfaces §`openFileLink async flow`
  - **Scope**: `src/providers/openFileLink.ts`, `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: `OpenFileLinkDeps` interface gains `getCurrentCwd(sessionId): string | undefined` and `findFiles(include, exclude, maxResults): Thenable<vscode.Uri[]>`. `buildCandidates` inserts a new step 2 (currentCwd) before initialCwd, preserving dedup behavior. After the stat loop produces no resolved path, the opener calls `findFiles("**/" + escapeGlob(msg.path), "{**/node_modules/**,**/.git/**}", 1)` with a 2000ms timeout via `Promise.race`; if exactly 1 match, opens it (running through the same scope-check + selection logic as the stat-resolved paths). On `findFiles` throw or timeout, logs `console.warn` and falls through to "File not found". `escapeGlob(s)` is a pure helper exported from the same file that wraps each of `*?[]{}` in `[...]` literal char-class.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Add `getCurrentCwd` and `findFiles` to `OpenFileLinkDeps` per design.md Interfaces §`OpenFileLinkDeps changes`.
    2. In `buildCandidates`: after `if (isAbsolutePath(msg.path)) push(msg.path);`, add `const current = deps.getCurrentCwd(msg.sessionId); if (current) push(path.join(current, msg.path));`.
    3. Add small helpers in the same file: `function escapeGlob(s: string): string` that does `s.replace(/[*?[\]{}]/g, (c) => "[" + c + "]")`; and `function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T>` that does `Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("findFiles timeout")), ms))])`.
    4. In `openFileLink` body, after the stat loop, before `if (resolvedFsPath === undefined) { showError(...) }`: call `await withTimeout(deps.findFiles("**/" + escapeGlob(msg.path), "{**/node_modules/**,**/.git/**}", 1), 2000)` in try/catch; on success+1-match set resolvedFsPath; on error log warn.
    5. Update all existing test fixtures in `openFileLink.test.ts` that build deps to include `getCurrentCwd: vi.fn(() => undefined)` and `findFiles: vi.fn(async () => [])` defaults — they don't need behavior, just to satisfy the type.

- [x] 4_2 Test the extended resolver
  - **Deps**: 4_1
  - **Refs**: specs/terminal-cwd-tracking/spec.md `Path resolution chain`; design.md D6, D7
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: Tests cover: (a) currentCwd hit short-circuits before initialCwd — assert `showTextDocument` called with currentCwd-resolved path even when initialCwd would also resolve; (b) currentCwd undefined falls through to initialCwd; (c) all stat candidates miss → findFiles returns 1 match → opens it; (d) findFiles returns 0 matches → showError "File not found"; (e) assert findFiles called with the right args (include `**/`-prefixed-and-glob-escaped, exclude glob, max 1); (f) findFiles throws → catches, logs warn, shows error toast; (g) absolute path still short-circuits (no findFiles call); (h) glob-meta paths: `msg.path = "foo[1]*.ts"` → findFiles called with `"**/foo[[]1[]][*].ts"` (each meta wrapped); (i) timeout: findFiles returns a never-resolving promise → after 2000ms `console.warn` fires and "File not found" toast appears (use `vi.useFakeTimers()`). All tests pass.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Reuse existing `makeDeps` factory; add `getCurrentCwd` and `findFiles` parameters.
    2. Add a "currentCwd resolution" describe block for cases (a) and (b).
    3. Add a "findFiles fallback" describe block for (c), (d), (e), (f).
    4. For (f) use `vi.spyOn(console, "warn").mockImplementation(...)` to capture.
    5. For (g) verify `findFiles` was never called when absolute resolves.

- [x] 4_3 Wire `findFiles` and `getCurrentCwd` into both providers
  - **Deps**: 2_1, 4_1
  - **Refs**: design.md D8; existing pattern in `case "openFile"` arm of both providers
  - **Scope**: `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`
  - **Acceptance**:
    - Outcome: Both providers' `case "openFile":` arms construct deps with the two new entries: `getCurrentCwd: (id) => this.sessionManager.getCurrentCwd(id)` and `findFiles: (include, exclude, max) => vscode.workspace.findFiles(include, exclude, max)`. `pnpm run check-types` passes; existing dispatch tests still pass.
    - Verify: unit src/providers/TerminalViewProvider.test.ts
  - **Plan**:
    1. In `TerminalViewProvider.ts:262` (current openFile arm), add the two new fields to the deps object literal.
    2. Same change in `TerminalEditorProvider.ts:205`.
    3. Existing `expect.objectContaining` checks in the dispatch tests already accept additional fields — but update both tests to ALSO assert `getCurrentCwd: expect.any(Function)` and `findFiles: expect.any(Function)` to lock the contract.

## 5. Test mock extension

- [x] 5_1 Add `workspace.findFiles` to vscode mock
  - **Deps**: none
  - **Refs**: discovery.md §8
  - **Scope**: `src/test/__mocks__/vscode.ts`
  - **Acceptance**:
    - Outcome: `workspace.findFiles` exists as `(include: string, exclude?: string, maxResults?: number) => Promise<vscode.Uri[]>` returning `[]` by default. A `__setFindFiles(fn)` test helper allows per-test overrides (mirrors `__setWorkspaceFolders` pattern at L153). `__resetAll` restores the default empty implementation. `pnpm run check-types` passes.
    - Verify: manual pnpm run check-types passes
  - **Plan**:
    1. Add a module-level `let _findFilesImpl = async () => [];`.
    2. In the `workspace` object literal, add `findFiles: (include, exclude, maxResults) => _findFilesImpl(include, exclude, maxResults)`.
    3. Export `__setFindFiles(fn)` and add `_findFilesImpl = async () => []` to `__resetAll`.

## 7. Live cwd via PID query (Option B — added during build after manual smoke surfaced "no workspace + no OSC 7" gap)

- [x] 7_1 Implement `processCwd` module + tests
  - **Deps**: none
  - **Refs**: specs/terminal-cwd-tracking/spec.md `Live cwd query via process table`; design.md D10
  - **Scope**: `src/pty/processCwd.ts`, `src/pty/processCwd.test.ts`
  - **Acceptance**:
    - Outcome: `queryProcessCwd(pid, deps?)` returns the cwd of the process. Linux: `fs.promises.readlink('/proc/<pid>/cwd')`. macOS: `execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 500 })`, parses `n<path>` line. Windows/other: `undefined`. Invalid pids (≤0, NaN, non-integer) → `undefined`. Any thrown error → `undefined`. Deps injection (`{ readlink, exec, platform }`) for testability.
    - Verify: unit src/pty/processCwd.test.ts
  - **Plan**:
    1. Define `Deps` interface; defaultDeps wraps `fs.promises.readlink` + promisified `child_process.execFile` + `process.platform`.
    2. Validate pid (positive integer); platform dispatch.
    3. Linux path: try/catch readlink. macOS path: shell out, parse output (split by lines, find first starting with `n`).
    4. Tests: mock deps, assert each branch (Linux happy + miss; macOS happy + miss + timeout + malformed output; Windows; invalid pid).

- [x] 7_2 Add `SessionManager.getLiveCwd(sessionId)` + test
  - **Deps**: 7_1
  - **Refs**: specs/terminal-cwd-tracking/spec.md `Live cwd query via process table`; design.md D10
  - **Scope**: `src/session/SessionManager.ts`, `src/session/SessionManager.test.ts`
  - **Acceptance**:
    - Outcome: `getLiveCwd(sessionId): Promise<string | undefined>` looks up the session, reads `session.pty.pid`, calls `queryProcessCwd(pid)`. Returns `undefined` for unknown ids or when pid is undefined. Existing tests untouched.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Import `queryProcessCwd` from `../pty/processCwd`.
    2. Add the public method; unknown session → resolve `undefined`; missing pid → resolve `undefined`.
    3. Mock `queryProcessCwd` via `vi.mock` to assert it's called with the session's pid.

- [x] 7_3 Extend `OpenFileLinkDeps` + resolver chain + provider wiring + tests
  - **Deps**: 7_2
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `Path resolution chain` (MODIFIED to 6 steps); design.md D11
  - **Scope**: `src/providers/openFileLink.ts`, `src/providers/openFileLink.test.ts`, `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`, `src/providers/TerminalViewProvider.test.ts`, `src/providers/TerminalEditorProvider.test.ts`
  - **Acceptance**:
    - Outcome: `OpenFileLinkDeps` gains optional `getLiveCwd?(sessionId): Promise<string | undefined>`. `openFileLink` awaits it once at the top, passes the resolved value to a refactored `buildCandidates(msg, deps, liveCwd)`. liveCwd is inserted as step 2 (between absolute and currentCwd). Both providers wire `getLiveCwd: (id) => this.sessionManager.getLiveCwd(id)`. Dispatch tests updated to assert `getLiveCwd: expect.any(Function)`.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Update interface.
    2. Refactor `buildCandidates` to accept `liveCwd` param and insert push BEFORE currentCwd block.
    3. At top of `openFileLink`, `const liveCwd = await deps.getLiveCwd?.(msg.sessionId).catch(() => undefined)`.
    4. Add `liveCwd=...` line to the trace log.
    5. Wire both providers.
    6. New tests: (a) liveCwd hit short-circuits before currentCwd; (b) liveCwd undefined falls through to currentCwd; (c) liveCwd throws → caught, treated as undefined; (d) order of candidates verified via stat-call sequence.

- [x] 7_4 Re-verify gate

## 8. QuickPick disambiguation for findFiles fallback (added when user noted AI CLI prints subfolder-relative paths)

- [x] 8_1 Extend `OpenFileLinkDeps` with `showQuickPick` + quickPick logic + tests
  - **Deps**: 4_2 (resolver tests in place)
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `Path resolution chain` step 6 (MODIFIED — 1→open, ≥2→quickPick); design.md D7
  - **Scope**: `src/providers/openFileLink.ts`, `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: `OpenFileLinkDeps` gains `showQuickPick: typeof vscode.window.showQuickPick`. findFiles call now passes `maxResults = 20`. Behavior by match count: 0 → "File not found"; 1 → open (existing); ≥2 → `showQuickPick` items map to `{ label: <workspace-relative>, description: <absolute fsPath> }`; on selection, open the chosen path through the existing scope-check + selection-range flow; on cancel/ESC (`undefined`), no-op (no error toast). For multi-root workspaces, label prefixes with the folder basename (`<folder>/<rel>`).
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Add `showQuickPick` to `OpenFileLinkDeps`.
    2. Bump `findFiles` call from `1` to `20`.
    3. Branch on `matches.length`: 0 (no-op, fall through to error), 1 (existing path), 2+ (build items + await `showQuickPick`).
    4. Helper `workspaceRelative(fsPath, folders)` — `path.relative(folder, fsPath)` for the containing folder; multi-root prepends `<folder-name>/`.
    5. Tests: 0/1/2+ matches; quickPick cancel; quickPick select returns the right path; label format single-root vs multi-root; absolute paths still skip findFiles.

- [x] 8_2 Wire `showQuickPick` into both providers + update dispatch tests
  - **Deps**: 8_1
  - **Refs**: design.md D8 + section 7 wiring
  - **Scope**: `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`, `src/providers/TerminalViewProvider.test.ts`, `src/providers/TerminalEditorProvider.test.ts`
  - **Acceptance**:
    - Outcome: Both providers add `showQuickPick: vscode.window.showQuickPick` to the deps object. Dispatch contract tests updated to assert `showQuickPick: expect.any(Function)`.
    - Verify: unit src/providers/TerminalViewProvider.test.ts (+EditorProvider test)
  - **Plan**:
    1. Edit both providers' `case "openFile"` deps block.
    2. Add the assertion line to both dispatch tests.

- [x] 8_3 Add `showQuickPick` to vscode mock + reset helper
  - **Deps**: none
  - **Refs**: section 5 mock additions
  - **Scope**: `src/test/__mocks__/vscode.ts`
  - **Acceptance**:
    - Outcome: `window.showQuickPick` exists as a stub returning `undefined` by default. Optional `__setShowQuickPick(fn)` helper for per-test overrides. `__resetAll` restores the default.
    - Verify: manual — `tsc --noEmit` passes

- [x] 8_4 Re-verify gate
  - **Deps**: 8_1, 8_2, 8_3
  - **Refs**: `asimov/project.md` §Commands
  - **Scope**: (no code)
  - **Acceptance**:
    - Outcome: `tsc --noEmit`, `biome check src/`, `vitest run` all green.
    - Verify: manual pnpm run check-types && pnpm run lint && pnpm run test:unit all green
  - **Deps**: 7_1, 7_2, 7_3
  - **Refs**: `asimov/project.md` §Commands
  - **Scope**: (no code)
  - **Acceptance**:
    - Outcome: `tsc --noEmit`, `biome check src/`, `vitest run` all green.
    - Verify: manual pnpm run check-types && pnpm run lint && pnpm run test:unit all green

## 6. Verification

- [x] 6_1 Run project verification commands
  - **Deps**: 1_1, 1_2, 2_1, 3_1, 3_2, 4_1, 4_2, 4_3, 5_1
  - **Refs**: `asimov/project.md` §Commands
  - **Scope**: (no code) — runs `pnpm run check-types`, `pnpm run lint`, `pnpm run test:unit`
  - **Acceptance**:
    - Outcome: All three commands exit 0.
    - Verify: manual pnpm run check-types && pnpm run lint && pnpm run test:unit all green
  - **Plan**:
    1. Run the three commands; fix any errors before declaring complete.

- [ ] 6_2 Manual smoke
  - **Deps**: 6_1
  - **Refs**: proposal.md §UI Impact & E2E
  - **Scope**: (no code) — exercises live flows in extension dev host
  - **Acceptance**:
    - Outcome: With dev host opened on workspace `~/`: (a) Open AnyWhere terminal; `cd ~/Projects/ai-oss/anywhere-terminal`; print `echo "src/extension.ts:1"`; click → file opens via current-cwd resolution (was failing in v1). (b) Repeat in a shell that does NOT emit OSC 7 (`bash` on Linux without vte.sh) — `cd` to project subdir; click → opens via `findFiles` fallback. (c) Print `echo "/abs/path/that/exists.ts:1"` → opens via absolute (regression check). (d) Print a path that genuinely doesn't exist → "File not found" toast. (e) After successful click flow (a), open VS Code Developer Tools → no errors logged. Record results in workflow.md Revision Log.
    - Verify: manual flows (a)-(d) succeed in extension dev host
  - **Plan**:
    1. `pnpm run watch` + F5 to launch dev host.
    2. Open `~/` as the workspace folder explicitly (reproduces the v1 failure scenario).
    3. Run the four flows; log outcomes.
