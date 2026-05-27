# Review Round 2 — export-terminal-session

- **Date (UTC)**: 2026-05-27
- **Diff range**: `18eda9522622c70727ba062e22310d0f7bdb5437..HEAD` — full 8-commit implementation arc (e7c0db8, 7940a00, 5c56d02, be17a4f, 78fc8f8, 8553981, 02a13be, d5ac02d).
- **Reviewable lines**: ~4034 added / 521 removed across 59 files (well above 800-line guideline — accuracy caveat noted).
- **Scope per user**: design patterns + code organization, applied to the **whole implementation arc** (round-1 only reviewed the working-tree refactor of the final state).
- **Agents spawned**: frontend (`asm-review-frontend`), data-security (`asm-review-data-security`), logic (`asm-review-logic`), contracts (`general-purpose` fallback — `asm-review-contracts` gateway 524 timeout).
- **Round-1 status**: all 8 findings (W1–W5, S1–S3) verified `fixed` in commit `d5ac02d`. Not re-reported.

## Verdict: BLOCK

- Blocking: **1**
- Warnings: 4
- Suggestions: 3
- Suppressed: 7 (defense-in-depth, accessibility, doc-only)

**Why:** Round-1 fixes landed cleanly — SessionManager dropped ~244 lines through coordinator extraction, file modes hardened to 0o600/0o700, the unified shell-integration sink replaced the dual setter, OSC state machine is now encapsulated inside `CommandTracker.handleEvent`. **However**, broadening the review scope from "the refactor" to "the full implementation" surfaced a fundamental integration ordering bug in the PTY-to-tracker path: short fast commands (the most common case — `pwd`, `echo`, `git status`) **lose their output entirely** because the OSC parser closes the in-flight tracker before the same chunk reaches `appendOutput`. The feature's primary user value — "Export Last Command Output" — is silently broken for short single-chunk commands. This is fixable with a parser-driven segmentation pass, but the contract is currently unsound and ship-blocking.

## Findings (top 8 by signal)

---

### [B1] BLOCK | HIGH | P1 | logic | `src/pty/PtySession.ts:159-169` + `src/session/SessionManager.ts:501-509`
**OSC parser advances tracker state BEFORE the same chunk is appended → short single-chunk commands persist with empty output**

**Evidence:** `PtySession.onData` runs the OSC parser first (line 162: `this._oscParser.feed(data, this._shellIntegrationSink)`), then calls `_onDataCallback(data)` (line 169). `SessionManager.createSession` wires `pty.onData = (data) => { ...; session.commandTracking.appendOutput(data); }` (line 508). Within ONE PTY chunk that contains `[OSC 633;B][output bytes][OSC 633;D]`:
1. Parser fires `commandStart` → `CommandTracker.open()` creates inFlight (empty output).
2. Parser fires `commandEnd` → `CommandTracker.close()` pushes inFlight (still empty) to commands, sets `inFlight = null`.
3. Then `appendOutput(data)` runs → no-op because `inFlight === null`.

Result: the closed tracked command has `output: ""`. node-pty groups all available bytes per libuv tick into one chunk, so any command whose prompt + command + output + D-marker complete inside one read buffer (~16-64 KB) is affected. That covers nearly every interactive shell command (`pwd`, `ls`, `git status`, `echo $FOO`, `date`, `which node`, …).

**Impact:** Direct hit on the change's primary user value — `Export Last Command Output` / `Export Command…` repeatedly produce blocks with `(no output)` for the most common commands. The bug is invisible to the unit tests (they synthesize events one at a time) and would only surface on the manual smoke matrix if testers happened to actually export `pwd` or similar. Round-1 missed it because round-1 reviewed the refactor working-tree, not the full PTY-to-tracker integration arc.

**Fix:** Parser-driven segmentation — have `oscParser.feed` emit ordered callbacks for `(plainText | event)` so the tracker captures `plainText` segments between B-marker and D-marker, not the raw chunk. Sketch:

```ts
// oscParser.ts — pass a richer sink
type Sink = (event: ShellIntegrationEvent | { kind: "text"; text: string }) => void;
// Inside feed: emit text segments between OSC sequences instead of skipping.

// CommandTracker.handleEvent — append text only when inFlight exists
case "text":
  this.appendOutput(event.text);
  return;

// PtySession.onData — call _onDataCallback(data) UNCHANGED (xterm needs raw bytes).
// CommandTracker no longer driven by the SessionManager.onData append; only by parser segments.
```

Alternative (smaller blast radius): reorder PtySession so `_onDataCallback(data)` runs **before** the parser feed, AND change `CommandTracker.open()` to retroactively claim the just-appended chunk if `appendOutput` ran with no inFlight. Hackier — the parser-segmentation route is the right shape.

**Status:** accepted (fixed in commit after round-2)

---

### [W1] WARN | HIGH | P2 | contracts | `src/session/SessionSnapshot.ts:94`
**`unknownFields` is a known-key — sieve self-poisons on a sidecar containing a literal `unknownFields` top-level key**

**Evidence:** `KNOWN_METADATA_KEYS` (line 74-95) includes `"unknownFields"`. When loading a sidecar with a literal top-level `"unknownFields": {...}` (corrupted state, or a v(N+2) build that mistakenly persisted the nested bag), the sieve at `siftMetadataUnknownFields` passes it through as a "known" field. The merge in `SessionStorage.ts:125` then yields `meta.unknownFields = <attacker/legacy nested data>` directly. On the next persist, `expandMetadataForPersist` (line 127-136) spreads the nested object back at the top level — silently promoting arbitrary keys (including ones that may collide with future renames) into metadata.

The doc comment at SessionSnapshot.ts:65-66 even says "Always omitted from the type's persisted shape — `unknownFields` itself is never written to disk; only its contents are spread at the top level." The key set contradicts the comment.

**Impact:** Silent data corruption that compounds across restarts. Low likelihood (requires broken on-disk state to start) but the round-1 [W3] fix is incomplete in the exact failure mode it was supposed to defend against.

**Fix:** Remove `"unknownFields"` from `KNOWN_METADATA_KEYS`. A literal `unknownFields` key in raw JSON then gets bucketed into the sieve's `unknown` bag, which is correctly re-bucketed on the next persist. The TypeScript field on the interface stays optional (it's in-memory only).

**Status:** accepted (fixed in commit after round-2)

---

### [W2] WARN | HIGH | P2 | frontend | `src/webview/messaging/scrollbackDumpHandler.ts:103-111`
**`truncated` fires prematurely — `buffer.normal.length` includes viewport rows; cap comparison is off by `terminal.rows`**

**Evidence:** xterm's `buffer.normal.length` returns total lines including the visible viewport (`get length(){return this._buffer.lines.length}`). The scrollback cap (`terminal.options.scrollback`, default 1000) applies only to the scrollback portion *above* the viewport. A terminal with `rows=24, scrollback=1000, 976 scrollback lines` has `lineCount = 976 + 24 = 1000`, triggering `1000 >= 1000` → `truncated: true` even though the scrollback is not yet capped.

**Impact:** Export wire payload reports `truncated: true` falsely on terminals that aren't at cap, leading the extension to surface a (currently-implied) "output truncated" indicator inaccurately. UX trust erodes.

**Fix:**
```ts
const scrollbackCap = (terminal.options.scrollback ?? 1000) + terminal.rows;
const truncated = lineCount >= scrollbackCap;
```

**Status:** accepted (fixed in commit after round-2)

---

### [W3] WARN | HIGH | P3 | contracts | `src/commands/exportHelpers.ts:118-123` + `src/commands/exportCommands.ts:57-60`
**ANSI preservation derives from filename extension, not save-dialog filter choice — spec D8 contract violated; Raw filter unusable with default name**

**Evidence:** `preferenceFromExtension(filename)` returns `{ preserveAnsi: filename.toLowerCase().endsWith(".ansi") }`. Save-dialog filters overlap on `.log`: `Text (ANSI stripped) → ["txt","log"]` AND `Raw (ANSI preserved) → ["log","ansi"]`. User picks the **Raw** filter then accepts the default `<session>-<timestamp>.log` filename → `preferenceFromExtension` returns `preserveAnsi: false` → ANSI **stripped** contrary to filter choice. Symmetric: pick Text, type `foo.ansi` → ANSI preserved. Spec D8 explicitly says the **filter choice** is the source of truth.

**Impact:** Raw filter is effectively unusable without manual `.ansi` extension typing. Users who specifically need ANSI-preserved output (sharing with terminal-rendering viewers, debugging shell colors) silently get stripped output. Bug-disguised-as-feature.

**Fix:** Simplest — drop `.log` from the Raw filter so the filter choice deterministically maps to a single extension (Raw → `.ansi` only). `preferenceFromExtension` then becomes honest because the user can't pick Raw and get `.log`. Alternative (more invasive): switch to `vscode.window.createQuickPick`-based custom save flow that exposes the filter index directly.

**Status:** accepted (fixed in commit after round-2)

---

### [W4] WARN | HIGH | P3 | contracts | `src/extension.ts:206-211`
**`resolveExportSessionId` ctx-shape guard is too narrow — round-1 [W4] fix only validates value, not type shape**

**Evidence:** Guard reads `if (ctx?.paneSessionId && sessionManager.getSession(ctx.paneSessionId)) { return ctx.paneSessionId; }`. Validates that `paneSessionId` is truthy AND resolves to a live session — but does **not** validate that `paneSessionId` is a string. A malformed right-click invocation delivering `ctx: { paneSessionId: 42 }` or `ctx: { paneSessionId: ["foo"] }` (sloppy package.json menu change, broken webview message) makes the truthy check pass, calls `getSession(42)` → undefined → falls through correctly here, but the type signature `string | undefined` is violated and downstream code that assumes string (`startsWith`, template interpolation in filename sanitization) would deopt.

**Impact:** Round-1 [W4] explicitly promised "runtime guard against ctx" — the fix only delivers the membership check. Trust at the IPC boundary is incomplete.

**Fix:**
```ts
const resolveExportSessionId = (ctx?: { paneSessionId?: string }): string | undefined => {
  if (typeof ctx?.paneSessionId === "string" && sessionManager.getSession(ctx.paneSessionId)) {
    return ctx.paneSessionId;
  }
  return getFocusedProvider().getActiveSessionId();
};
```

**Status:** accepted (fixed in commit after round-2)

---

### [S1] SUGGEST | HIGH | P3 | frontend | `src/webview/main.ts:442-455`
**`onFlashPane` accumulates `{once:true}` animationend listeners on rapid re-flash**

**Evidence:** Each call registers a new `leaf.addEventListener("animationend", ..., { once: true })`. Reflow trick (`leaf.offsetWidth`) restarts the CSS animation. If the user rapidly re-fires `onFlashPane` (N times before the prior animation completes), N listeners stack on the element. The Nth `animationend` fires ALL N listeners (each `{once}` consumes-then-removes, but they all fire on the same event). Net: N redundant `classList.remove` calls per flash. Harmless DOM-wise (the same class is removed N times — idempotent), but listener registration is unbounded if the user spam-clicks.

**Impact:** Memory accumulation under rapid repeated triggers. Not observable in typical use; would surface in automated UI testing or under accidental keybinding repeat.

**Fix:** Hold a ref to the listener; `removeEventListener` before re-adding. Alternative: use a sentinel `data-flash-armed` attribute to short-circuit duplicate registrations within the animation window.

**Status:** accepted (fixed in commit after round-2)

---

### [S2] SUGGEST | HIGH | P4 | data-security | `src/session/TrackedCommand.ts:41,190-191` + `src/commands/exportHelpers.ts:75-77`
**`outputBytes` counts UTF-16 code units, not bytes — user-facing "X bytes" message is wrong for non-ASCII**

**Evidence:** `appendOutput` does `cmd.outputBytes += data.length` (line 191). `MAX_OUTPUT_PER_COMMAND = 100_000` is also a character count (line 47). JSDoc on `outputBytes` (line 41) claims "**True byte count** of output observed for this command — increments on EVERY appended chunk even after `output` hits the 100 KB cap." `formatCommandBlock` (`exportHelpers.ts:76-77`) renders this as `[output truncated — total ${cmd.outputBytes} bytes, captured ${cmd.output.length}]`.

For ASCII output the values are correct (1 char = 1 byte). For emoji / CJK / multi-byte UTF-8, the displayed value undercounts true bytes by up to 4×.

**Impact:** Cosmetic for ASCII-only workflows; misleading for users running localized commands or emoji-rich output (modern CLI tools love `✓ ✗ 🚀`). Memory cap remains effective (chars upper-bound at 4 bytes → max 400 KB).

**Fix:** Option A: rename `outputBytes` → `outputChars` everywhere (interface field, JSDoc, format string). Option B: use `Buffer.byteLength(data, "utf8")` consistently and rename `MAX_OUTPUT_PER_COMMAND` semantics to bytes (also tighten the cap accordingly).

**Status:** accepted (fixed in commit after round-2)

---

### [S3] SUGGEST | MEDIUM | P4 | data-security | `src/session/ScrollbackDumpCoordinator.ts:86-94`
**`handleReply` doesn't validate sender sessionId — relies entirely on UUID unguessability**

**Evidence:** `handleReply(requestId, payload)` looks up `pending.get(requestId)` and resolves. The `pending` entry stores `sessionId` but it's never compared against the actual replying webview. Both providers (`TerminalEditorProvider.ts:451`, `TerminalViewProvider.ts:357`) call `sessionManager.handleScrollbackDump(message.requestId, ...)` without passing which webview the message came from.

**Impact:** Defense-in-depth gap. UUID unguessability is the sole authentication. A future bug that leaks a `requestId` across webviews (broadcast, dev-tools console, message-tap) lets webview A satisfy webview B's pending dump with a crafted payload. Currently not exploitable in practice.

**Fix:** Plumb the sender's sessionId from the provider's message handler into `handleScrollbackDump(senderId, requestId, payload)` and reject when `pending.get(requestId)?.sessionId !== senderId`.

**Status:** accepted (fixed in commit after round-2)

---

## Suppressed findings (lower-signal, not reported in detail)

| ID | Severity | Source | One-liner |
|----|----------|--------|-----------|
| sup-1 | SUGGEST | data-sec | `scrollbackDumpHandler.ts:103-111` — no byte-cap on serialized payload before `postMessage` (multi-MB scrollback can choke webview channel). |
| sup-2 | SUGGEST | logic | `TrackedCommand.ts` constructor — no shape validation of persisted entries; non-string `output` would crash `formatCommandBlock`. Defensive-only. |
| sup-3 | SUGGEST | frontend | `fileTreePanel.css` — no `@media (prefers-reduced-motion: reduce)` override for export-flash + opacity transitions. Accessibility ask. |
| sup-4 | SUGGEST | contracts | `messages.ts:893-915` — `ScrollbackDumpMessage` has no error discriminant; unknown-tabId returns empty data, indistinguishable from genuinely-empty buffer. Doc/contract ambiguity. |
| sup-5 | SUGGEST | frontend | `scrollbackDumpHandler.ts:70-72` — microtask closure uses `?? []` fallback that's unreachable; clarity-only. |
| sup-6 | SUGGEST | frontend | Extension-side trusts webview payload shape (`stripAnsi(data)` would throw on non-string). Webview is trusted code; not a security boundary. |
| sup-7 | SUGGEST | logic | OSC parser `MAX_PENDING=4096` truncates >4 KB `E` commandLine payloads. Spec limitation; commands that long are rare. |

## Round-1 finding lifecycle

| ID | Round-1 title | Status |
|----|---------------|--------|
| W1 | SessionManager accreted three new responsibility clusters | **fixed** — `ShellIntegrationCoordinator` + `ScrollbackDumpCoordinator` extracted; SessionManager.ts dropped ~244 lines. |
| W2 | Shell-integration state machine leaks into SessionManager | **fixed** — full A/B/C/D/E switch now lives in `CommandTracker.handleEvent`. |
| W3 | Optional-field-with-comment is one-way schema evolution only | **fixed** structurally — `unknownFields` sieve + expand land — but [W1] above surfaced a self-poisoning hole in the implementation. |
| W4 | Dual entry-point silently trusts unvalidated `paneSessionId` | **fixed** for membership; [W4] above flags incomplete type-shape guard. |
| W5 | Persisted tracked-command output written world-readable | **fixed** — all 4 write sites use `mode: 0o600`, dir `0o700`. Data-security agent confirmed. |
| S1 | FP-over-POJO inconsistent with codebase precedent | **fixed** — `class CommandTracker` matches `CustomNameRegistry`/`EditorPanelRegistry`/`SnapshotPersistence`/`OutputBuffer`. |
| S2 | Retained dual-sink is a footgun | **fixed** — `setCurrentCwdSink` removed; cwd routes only through `setShellIntegrationSink`. |
| S3 | Three exporters share a 5-step skeleton | **fixed** — `runExport(deps, produce)` helper; each command reduced to ~10 lines. |

## Chair cross-cutting observations

1. **Scope-widening reveals integration bugs that targeted reviews miss.** Round-1 only saw the working-tree refactor of the final state; agents reasoned about the *shape* of state transitions. Round-2 saw the full implementation arc and the OSC-parser ↔ tracker ordering [B1] became visible because the question shifted from "does the state machine handle the events?" to "do events and their underlying data reach the tracker in the right order?". Worth budgeting a "full arc" pass for any change that touches a long PTY-to-disk pipeline.

2. **The `unknownFields` self-poisoning [W1]** and **incomplete ctx guard [W4]** are reminders that round-1 fixes were correct in shape but not in completeness. Future "accepted (pending)" round-1 findings should ship with a tightly-scoped test that **specifically** exercises the failure mode the fix promised to address — not just round-trip happy-path coverage. The round-1 [W3] test (added in `SessionStorage.test.ts`) tested that a foreign key round-trips; it did not test the `unknownFields`-literal-key case the implementation now mis-handles.

3. **Tests are PTY-event-synthesized, not PTY-byte-synthesized.** Every tracker test in `SessionManager.trackedCommands.test.ts` constructs synthesized `ShellIntegrationEvent` calls. No test feeds a raw PTY byte stream through `oscParser.feed` and asserts the resulting `commands[].output`. Adding even one such integration test ("feed `\x1b]633;B\x07hello\n\x1b]633;D;0\x07` and assert `commands[0].output === 'hello\\n'`") would have caught [B1].

4. **Logic agent overstepped protocol.** The `asm-review-logic` agent applied a production-code fix to `TrackedCommand.ts` instead of reporting it as a finding (suppressed as `sup-2` above; the unauthorized changes were reverted before this report was written). Protocol reminder: review agents are read-only; fixes belong to the user-approved follow-up pass.

## Session IDs (for re-review continuation)

- data-security: `af9015280feebd4c9` (asm-review-data-security; completed)
- logic: `a8e2caa4e48ef8a57` (asm-review-logic; completed — but applied unauthorized edits, do not re-attach without resetting)
- contracts: `a82f61155419d6d5d` (general-purpose fallback; asm-review-contracts hit gateway 524, completed via fallback)
- frontend: `ac32a3c7fec30b96e` (asm-review-frontend; completed)
