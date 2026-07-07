# Discovery: write-vault-rename-to-store

Native rename that writes the real session title into the agent's own store for the two SQLite agents (OpenCode, Codex), while Claude keeps the existing sidecar overlay. Extends the overlay-only rename shipped in `enhance-vault-sessions` (D1 there deliberately deferred native writes; this change is that opt-in, scoped to the two SQLite agents).

## Workstreams

| Workstream | Delegate | Status | Output |
|---|---|---|---|
| Architecture Snapshot + internal rename flow | asm-finder | ✓ done | code map (§ Findings 1,5) |
| External: SQLite write mechanism + title lifecycle | asm-librarian (reads real source at /Users/huybuidac/Projects/ai-oss) | ✓ key findings in; research doc → `docs/research/20260707-vault-native-rename.md` | § Findings 1-4 |
| Memory Recall | `asm memory search` | ✓ done | prior read-only posture; fire-and-forget Memento pattern |
| Constraint Check (engines, sqlite deps) | Direct Read | ✓ done | § Findings 1 |

## Key findings

### 1. SQLite mechanism = `node:sqlite` `DatabaseSync` (write-capable); the READ path copies to a temp file, so a WRITE needs a new live-DB path
- `package.json` `engines.vscode: ^1.105.0` → VS Code extension host is Node **22.15.1+** (host bumped to Node 22 in v1.101). `node:sqlite` (`DatabaseSync`) is available and **write-capable** (`.prepare(...).run(...)` with bound params); no `sqlite`/`better-sqlite3` dependency exists or is needed.
- `src/vault/sqlite.ts`: the reader **copies the DB to a temp dir** (`fs.copyFile` :94, `mkdtemp("at-vault-")` :112) and queries the **copy** via `new DatabaseSync(dbCopy)` (:175), with a `sqlite3 -readonly -json` **CLI fallback** (:207-210) and an importability probe (:157). Engine choice: prefer in-process `node:sqlite`, else CLI, else graceful-empty (`no-sqlite3`).
- **Consequence:** the write path CANNOT reuse the read path (a temp copy write is thrown away). It must open the **live** `.db` read-write and issue a parameterized `UPDATE`, with a `PRAGMA busy_timeout` to survive the agent's WAL lock. If `node:sqlite` is unavailable, the CLI's parameter binding (`.parameter`) is clunky/unsafe → **write is node:sqlite-only**; when unavailable, no-op + surface (do not shell-inject a user string).

### 2. Codex — `threads.title` is writable and a DB write STICKS
- Store: `~/.codex/state_5.sqlite`, table `threads`, PK `id`, column `title` (confirmed by `agent-session-index` spec + finder at codexReader.ts:44-56).
- Real source `/Users/huybuidac/Projects/ai-oss/codex/codex-rs/state/src/model/thread_metadata.rs`: `prefer_existing_explicit_title(existing)` — when Codex reconciles metadata from the rollout JSONL, it **preserves an existing explicit title** (non-empty AND `!= first_user_message`). Auto-derived title = the first user message; an explicit rename differs from it, so it is retained. `read_thread` reads title from the SQLite metadata.
- **Conclusion:** a direct `UPDATE threads SET title=? WHERE id=?` **persists** and is not clobbered on later activity/resume, provided the new name differs from the first prompt (always true for a real rename).

### 3. OpenCode — `session.title` is writable and a DB write STICKS
- Store: `~/.local/share/opencode/opencode.db` (XDG-aware, resolveOpencodePaths), table `session`, PK `id`, column `title` (opencodeReader.ts:53-63).
- Real source: `ensureTitle` is invoked only once at `step===1` and only when the title is still the **default/placeholder** (`isDefaultTitle`) — an explicit title is never auto-regenerated. `Session.setTitle` is OpenCode's own DB writer (route `/session/:id`), emitting a patch event. DB opened WAL with `PRAGMA busy_timeout=5000` (`src/storage/db.ts`).
- **Conclusion:** `UPDATE session SET title=? WHERE id=?` persists; mirror OpenCode's own `busy_timeout=5000`.

### 4. Claude — no user-facing title field
- Claude title is derived (summary record ?? first-prompt) from the append-only JSONL (claudeReader.ts:289-294). There is no writable "name". Writing would require appending a synthetic `summary` record to the agent's session file → rejected. **Claude keeps the overlay** (VaultCustomNameRegistry).

### 5. Rename handler branch point (extend, don't replace)
- IPC `VaultRenameSessionMessage {type,entryId,name}` (messages.ts:444-448) — unchanged.
- `TerminalViewProvider.handleVaultRenameSession` (:500-519): today it calls `vaultService.setCustomName` then re-posts the overlaid list. **Branch by agent** (parse `entryId` `<agent>:<sessionId>`): `opencode`/`codex` → native write + refresh; `claude` (+ any unknown) → existing overlay.
- `VaultService.setCustomName`/`overlayCustomNames` (:141-163) + `VaultCustomNameRegistry` (:47-55) stay for Claude. Native write belongs in a new store-writer module (parallels sqlite.ts read helpers).
- Precedence: after a successful native write, the agent's own `title` becomes the source of truth; the overlay must NOT also be set for that entry (else two names). On write failure → fall back to overlay so the user still sees their name.

## Gap analysis
- No existing SQLite **write** helper — sqlite.ts is read-only (temp-copy). New `writeSqlite`-style helper needed (live DB, busy_timeout, bound params, node:sqlite-only, graceful no-op when unavailable).
- No agent-store write anywhere in the codebase today → this is the first; must not regress the read-only guarantee for Claude.
- `isGlobSafeId` guards `sessionId`; the **name** is user input → must be a **bound parameter** (never string-concatenated) in the UPDATE.

## Options

| # | Decision | Option A (chosen) | Option B | Why A |
|---|---|---|---|---|
| O1 | Write mechanism | `node:sqlite` `DatabaseSync` on the **live** DB, read-write + `PRAGMA busy_timeout`; no-op + surface if module absent | Add a `sqlite3` CLI write fallback | CLI param-binding is clunky/injection-prone; node:sqlite is guaranteed on host Node 22 (engines ^1.105); a no-op fallback keeps the read-only guarantee intact |
| O2 | Claude | Keep overlay | Append synthetic summary to JSONL | No title field; appending to an agent's append-only session file is fragile + risky |
| O3 | Overlay vs native precedence | Native write clears/skips the overlay for that entry; overlay only as **failure fallback** | Always keep overlay too | Avoid double source of truth; agent title is now authoritative and visible in the CLI |
| O4 | busy_timeout | 5000ms (match OpenCode) | 0 / retry loop | Mirrors OpenCode's own setting; simple, survives transient WAL lock |

## Risks
- **Writing a running agent's DB (WAL).** Mitigation: open read-write with `busy_timeout=5000`, single short `UPDATE` in autocommit (no long transaction), wrap in try/catch → on failure fall back to overlay + surface. Never hold the DB open.
- **`node:sqlite` absent** (older host / alt runtime). Mitigation: probe (reuse sqlite.ts probe); if absent, skip native write, set overlay instead, log once.
- **SQL injection via name.** Mitigation: bound parameter only; `sessionId` already `isGlobSafeId`-guarded.
- **Codex dual source (DB + rollout).** Mitigation: verified explicit title is preserved on reconcile (Finding 2) — DB-only UPDATE is sufficient.
- **Write succeeds but list still shows old title** (cache). Mitigation: after write, bust/refresh the vault cache for that store and re-post the list (reuse existing refresh + `_vaultRefreshSeq`).

## Open questions (resolved for fastlane)
- Q: busy_timeout value → **5000ms** (O4).
- Q: what if node:sqlite missing → **overlay fallback + one log line** (O1).
- Q: clear overlay on native success → **yes** (O3); also clear any prior overlay for that entry so a previously-overlaid session switches to the native title.
