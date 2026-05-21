# Design: track-terminal-cwd

## Decisions

### D1: Splice the OSC listener inside `PtySession`, NOT `OutputBuffer`

`PtySession` (`src/pty/PtySession.ts:75-131`) owns the raw node-pty `onData` callback and forwards to the user callback at L130. `OutputBuffer` is a coalescing buffer that should stay dumb (no escape awareness). We intercept inside `PtySession`'s data-receive path: pass the chunk through `oscParser` (which mutates its own pending-buffer state and may emit cwd updates), then call the user callback with the **unchanged** chunk.

Pseudocode:

```ts
ptyProcess.onData((data) => {
  oscParser.feed(data, (cwd) => sessionManager.setCurrentCwd(this.sessionId, cwd));
  if (this._onData) this._onData(data);
});
```

Rejected: parsing in `OutputBuffer.append()`. Adds escape awareness to a buffer that should remain a pure FIFO; harder to wire to SessionManager (which already owns `PtySession`).

### D2: Pure stateful parser module `oscParser.ts`

New file `src/pty/oscParser.ts` (parallel to `PtySession.ts`). Exposes a single factory `createOscParser(): { feed(chunk: string, onCwd: (cwd: string) => void): void }`. The returned object encapsulates the pending buffer; one instance per `PtySession`.

The parser is a pure function except for its own pending-buffer state. No imports of `vscode` or `node:path` (sanitization is delegated to the caller — but in practice we centralize sanitization inside the parser so a test exercises the full path). Reason: keep `PtySession` glue thin; let the parser own everything escape-sequence-related.

Implementation skeleton (~40 lines):

```ts
export function createOscParser() {
  let pending = "";
  const MAX_PENDING = 4096;
  return {
    feed(chunk: string, onCwd: (cwd: string) => void) {
      pending += chunk;
      if (pending.length > MAX_PENDING) {
        // Drop open OSCs; keep the tail in case a new ESC is starting.
        pending = pending.slice(-128);
      }
      // Scan for OSC 7 and OSC 633 in pending buffer.
      // ... see Interfaces § for full algorithm ...
    },
  };
}
```

### D3: Sanitization rules

Before invoking the `onCwd` callback, the parser MUST:

1. **OSC 7**: parse the payload as a URL via `new URL(raw)`. Take the `.pathname`. Call `decodeURIComponent(pathname)`. Reject if decoding throws.
2. **OSC 633 `P;Cwd=...`**: take the payload after `Cwd=` literally (no URL decoding). VS Code emits raw paths here.
3. Both paths: normalize via `path.resolve(<decoded>)` (the parser imports `node:path`).
4. Reject if `!path.isAbsolute(normalized)`.
5. Reject if `normalized.includes("\0")`.

Rejected updates silently consume their bytes and continue scanning.

### D4: OSC sequence boundary rules

- Start markers: `\x1b]7;` (OSC 7) or `\x1b]633;P;Cwd=` (OSC 633 Cwd specifically — we only consume cwd reports, ignore other OSC 633 sub-commands).
- Terminators: `\x07` (BEL) OR `\x1b\\` (ST). Whichever appears first ends the payload.
- If the start marker is present but no terminator is found AND the pending buffer is under `MAX_PENDING`, retain the buffer and wait for the next chunk.
- If `MAX_PENDING` is exceeded with an open OSC, drop everything except the last 128 bytes (which may contain the start of a new `ESC]`).
- Other OSCs (`OSC 0` title, `OSC 8` hyperlinks, etc.) are skipped — but the parser MUST handle them correctly enough to not misinterpret their payload as our markers. Specifically: when the scanner sees `\x1b]` followed by a number that is NOT 7 or 633, it should advance past the next terminator without inspecting the content.

### D5: SessionManager surface — `setCurrentCwd` + `getCurrentCwd`

`TerminalSession` interface gains `currentCwd?: string`. Two new public methods on `SessionManager`:

```ts
setCurrentCwd(sessionId: string, cwd: string): void;  // no-op on unknown id
getCurrentCwd(sessionId: string): string | undefined;
```

`setCurrentCwd` does NO validation — that's the parser's job. SessionManager is a dumb store.

### D6: Opener resolver chain change

`openFileLink.buildCandidates()` (`src/providers/openFileLink.ts:39-59`) becomes:

```ts
function buildCandidates(msg, deps): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => { /* unchanged dedup logic */ };

  if (isAbsolutePath(msg.path)) push(msg.path);
  const current = deps.getCurrentCwd(msg.sessionId);   // NEW step 2
  if (current) push(path.join(current, msg.path));
  const initial = deps.getInitialCwd(msg.sessionId);
  if (initial) push(path.join(initial, msg.path));
  for (const folder of deps.workspaceFolders ?? []) {
    push(path.join(folder.uri.fsPath, msg.path));
  }
  return candidates;
}
```

The `findFiles` step is NOT folded into `buildCandidates` (which is sync) — it lives as a separate async step in `openFileLink()` after the stat loop fails. See Interfaces.

### D7: `findFiles` fallback shape

After the stat loop produces no resolved path:

```ts
if (resolvedFsPath === undefined) {
  const escapedPath = escapeGlob(msg.path);
  try {
    const matches = await withTimeout(
      deps.findFiles(`**/${escapedPath}`, "{**/node_modules/**,**/.git/**}", 1),
      2000,  // 2-second timeout — large workspaces can be slow
    );
    if (matches.length === 1) resolvedFsPath = matches[0].fsPath;
  } catch (err) {
    console.warn("[AnyWhere Terminal] findFiles fallback failed/timed out:", err);
  }
}
```

**Glob-meta escape** — `msg.path` is terminal-controlled. Filenames containing `[`, `]`, `*`, `?`, `{`, `}` would otherwise be interpreted as glob syntax (false positives or expensive expansion). `escapeGlob` wraps each meta char in `[...]` character classes (POSIX glob syntax for "literal this char") — e.g. `?` → `[?]`, `*` → `[*]`.

**Timeout** — `withTimeout` is a small helper: `Promise.race([p, timer])` where the timer rejects after `ms`. Without it, a cold-index `~/` workspace search could take many seconds and lock the click. 2000ms balances responsiveness with giving VS Code time to index.

`maxResults=1` ensures only first match is returned; if `matches.length === 0`, fall through to "File not found" toast.

### D8: OpenFileLinkDeps changes

Add two fields:

```ts
export interface OpenFileLinkDeps {
  getInitialCwd(sessionId: string): string | undefined;
  getCurrentCwd(sessionId: string): string | undefined;   // NEW
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
  findFiles(include: string, exclude: string, maxResults: number): Thenable<vscode.Uri[]>;   // NEW
  showWarning: typeof vscode.window.showWarningMessage;
  showError: typeof vscode.window.showErrorMessage;
  showTextDocument: typeof vscode.window.showTextDocument;
}
```

Both providers (`TerminalViewProvider` + `TerminalEditorProvider`) update their `case "openFile"` deps construction:

```ts
getCurrentCwd: (id) => this.sessionManager.getCurrentCwd(id),
findFiles: (include, exclude, max) => vscode.workspace.findFiles(include, exclude, max),
```

### D9: Forwarding correctness — the audit rule

The parser MUST NOT consume, transform, or delay the bytes passed to the user callback. Concretely: in `PtySession`, the sequence is `oscParser.feed(data, ...); userCallback(data);`. There is no path by which `data` is modified between receipt and forwarding. A unit test asserts this: for an arbitrary byte sequence, the chunk delivered to the user callback equals the chunk received from node-pty exactly.

## Interfaces

### `oscParser.ts`

```ts
/** Pure-state OSC parser. One instance per PtySession. */
export interface OscParser {
  /** Feed a chunk of PTY output. Invokes onCwd when a complete cwd report is parsed. */
  feed(chunk: string, onCwd: (cwd: string) => void): void;
}

export function createOscParser(): OscParser;
```

Algorithm for `feed`:

```
1. Append chunk to pending.
2. If pending.length > MAX_PENDING (4096):
   - Truncate to last 128 bytes.
3. Loop:
   a. Find next "\x1b]" in pending (start of any OSC).
   b. If none, set pending = pending.slice(-2) and return (might have a trailing ESC).
   c. Try to match start markers:
      - "\x1b]7;" → OSC 7 (URL form)
      - "\x1b]633;P;Cwd=" → OSC 633 (raw form)
      - Otherwise → unknown OSC; scan for its terminator and skip past.
   d. Find the first BEL (\x07) or ST (\x1b\\) AFTER the marker.
      - If neither found, retain pending starting at the OSC start, return.
   e. Extract payload, advance past terminator.
   f. Sanitize (per D3):
      - OSC 7: parse as URL, decode pathname.
      - OSC 633: take after "Cwd=" literally.
      - Both: path.resolve; reject if not absolute or contains \0.
   g. On accept: invoke onCwd(normalized).
   h. Continue loop from current position.
```

### `PtySession.ts` change

```ts
// In the existing onData wiring (around L124-131):
private _oscParser = createOscParser();
private _setCurrentCwd?: (cwd: string) => void;

setCurrentCwdSink(fn: (cwd: string) => void): void {
  this._setCurrentCwd = fn;
}

// In the data callback:
ptyProcess.onData((data: string) => {
  if (this._setCurrentCwd) {
    this._oscParser.feed(data, this._setCurrentCwd);
  }
  if (this._onData) this._onData(data);
});
```

`SessionManager.createSession` wires `pty.setCurrentCwdSink((cwd) => this.setCurrentCwd(id, cwd))` after constructing the PTY.

### `SessionManager` additions

```ts
class SessionManager {
  // ... existing
  setCurrentCwd(sessionId: string, cwd: string): void;
  getCurrentCwd(sessionId: string): string | undefined;
}
interface TerminalSession {
  // ... existing
  currentCwd?: string;
}
```

### `openFileLink` async flow

```ts
export async function openFileLink(msg: OpenFileMessage, deps: OpenFileLinkDeps): Promise<void> {
  if (!msg.path) return;
  const candidates = buildCandidates(msg, deps);
  let resolvedFsPath: string | undefined;
  for (const candidate of candidates) {
    // existing stat-loop
  }
  // NEW: findFiles fallback
  if (resolvedFsPath === undefined) {
    try {
      const matches = await deps.findFiles(
        `**/${msg.path}`,
        "{**/node_modules/**,**/.git/**}",
        1,
      );
      if (matches.length === 1) resolvedFsPath = matches[0].fsPath;
    } catch (err) {
      console.warn("[AnyWhere Terminal] findFiles fallback failed:", err);
    }
  }
  if (resolvedFsPath === undefined) {
    await deps.showError(`File not found: ${msg.path}`);
    return;
  }
  // existing scope-check + open
}
```

### D10: PID-based live cwd query

New module `src/pty/processCwd.ts` exposes `queryProcessCwd(pid: number, deps?: Deps): Promise<string | undefined>`. Platform dispatch:

```ts
export async function queryProcessCwd(pid: number, deps: Deps = defaultDeps): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  switch (deps.platform) {
    case "linux":  return readlinkLinux(pid, deps);
    case "darwin": return queryDarwinViaLsof(pid, deps);
    default:       return undefined;
  }
}
```

- **Linux**: `await fs.promises.readlink(`/proc/${pid}/cwd`)` — sub-millisecond, no shell.
- **macOS**: `execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 500 })` — parses `n<path>` lines. ~150ms latency, but capped at 500ms.
- **Windows / other**: returns `undefined`; resolver falls through to existing OSC/initial/workspace/findFiles chain.

`Deps` is a small interface (`{ readlink, exec, platform }`) so unit tests can mock without touching real fs/child_process. The default implementation imports from `node:fs/promises` and `node:child_process`.

### D11: Resolution chain v2 — liveCwd at step 2

`buildCandidates` becomes a sync function that takes the already-resolved `liveCwd: string | undefined` as a parameter; the async `queryProcessCwd` runs once at the top of `openFileLink` before building candidates. Order:

```ts
export async function openFileLink(msg, deps) {
  if (!msg.path) return;
  const liveCwd = await deps.getLiveCwd?.(msg.sessionId);
  const candidates = buildCandidates(msg, deps, liveCwd);
  // ... existing stat loop
}

function buildCandidates(msg, deps, liveCwd) {
  // 1. absolute
  // 2. liveCwd (NEW — authoritative for local)
  // 3. currentCwd (OSC 7/633)
  // 4. initialCwd
  // 5. workspaceFolders
}
```

`getLiveCwd` is OPTIONAL on `OpenFileLinkDeps` (interface signature uses `?`) so existing call sites that don't yet wire it don't break — they just skip step 2 silently. Both providers MUST wire it in the same change.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| OSC parser | Chunk-boundary bug misses sequences split across `onData` | Pending buffer per D2; parser unit tests deliberately split a known sequence at every byte offset (parametric test) |
| OSC parser | Unbounded pending growth on malicious never-terminating OSC | D2/D4 cap MAX_PENDING=4096, drop to last 128 bytes on overflow; unit test feeds 5000 bytes starting with `\x1b]7;` and asserts memory bounded |
| OSC parser | Misparses unknown OSCs as OSC 7 | D4 explicit start markers `\x1b]7;` and `\x1b]633;P;Cwd=`; other OSCs are skipped past their terminator; unit test feeds OSC 0/8/9 and asserts onCwd not called |
| Pass-through | Listener mutates/swallows bytes → breaks terminal rendering | D9 audit rule; unit test asserts `userCallback` receives byte-identical chunks; integration test feeds random bytes including escape sequences and verifies forward equals input |
| Sanitization | Malicious `..` segments escape workspace | D3 step 3 `path.resolve` normalizes; out-of-workspace confirm modal (from add-clickable-file-paths D8) catches anything outside scope |
| Sanitization | Null-byte injection | D3 step 5 rejects |
| Sanitization | URL parsing throws | D3 catches via try/wrapped `new URL`; rejected payloads silently dropped |
| `findFiles` | Slow search in large workspace (`~/` root) | maxResults=1, exclude `node_modules`/`.git`, 2-second timeout (D7 `withTimeout`) |
| `findFiles` | Returns wrong file (multiple checkouts) | Documented limitation; out-of-workspace confirm modal still gates; first-match is a v1 trade-off (Gate 1 D2) |
| `findFiles` | Throws (cancelled, workspace closed, timed out) | try/catch wraps the call; logs and falls through to "File not found" toast |
| `findFiles` | Glob meta chars in `msg.path` cause false positives or expansion (e.g. `foo[1].ts`) | D7 `escapeGlob` wraps each of `[]*?{}` in a literal char class; parser unit test asserts `escapeGlob("a[1]*.ts")` → `"a[[]1[]][*].ts"` |
| Cross-platform | Windows path joining with currentCwd containing forward slashes | `path.resolve` normalizes; existing D8 from prior change handles case-insensitive comparison |
| Live cwd | macOS `lsof` slow under load (>500ms) | Hard timeout via `execFile({ timeout: 500 })`; falls through silently to existing chain |
| Live cwd | macOS `lsof` not installed / different output format | Try/catch around exec returns `undefined`; resolver falls through |
| Live cwd | PID belongs to a process that exited mid-query | `readlink`/`lsof` returns error → caught → `undefined`; no crash |
| Live cwd | PID injection (user-controlled?) | PID comes from node-pty (internal); validated as positive integer before query |
| Live cwd | Windows unsupported | Returns `undefined`; existing OSC 7/633 + initialCwd + findFiles chain still works |
| Live cwd | Malformed `lsof` output (warning text on stdout) | `sanitize()` checks for absolute-path shape + control bytes; non-conforming values → `undefined` |
| Live cwd | Linux `/proc/<pid>/cwd` returns `<path> (deleted)` after rmdir | `sanitize()` rejects values ending in ` (deleted)`; resolver falls through |
| Live cwd | Local PID query wins over OSC for SSH session, picks wrong file | Documented as v2 limitation in proposal §Out of scope; mitigation deferred to future change |
| Live cwd | currentCwd or liveCwd added to trust-boundary bases (security regression) | Regression test in `openFileLink.test.ts` locks that ONLY initialCwd + workspaceFolders are in `bases` |
