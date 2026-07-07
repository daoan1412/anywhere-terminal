---
topic: vault-native-rename
created-by: discovery for native rename writes into OpenCode/Codex stores
date: 2026-07-07
libraries: [node:sqlite, sqlite3, opencode, codex]
used-by: [write-vault-rename-to-store]
---

# Research: vault-native-rename

## Answers
- **1) SQLite write mechanism**
  - The current vault helper already prefers `import { DatabaseSync } from "node:sqlite"` and only falls back to `sqlite3` CLI for reads (`src/vault/sqlite.ts:6-12, 168-178, 247-303`). `node:sqlite` is write-capable: `StatementSync.run()` supports bound params and DML (`INSERT/UPDATE/DELETE`), and `new DatabaseSync(path)` opens read-write by default (`open:true`, `readOnly:false`). Use bound parameters; they protect against SQL injection. [Node docs](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)
  - Runtime gate: `node:sqlite` was added in Node 22.5.0, and it is no longer behind `--experimental-sqlite` from 22.13.0 onward. VS Code’s extension host moved to Node 22.15.1 in 1.101, and this extension requires VS Code `^1.105.0` (`package.json:40-42`; [VS Code 1.101 release notes](https://code.visualstudio.com/updates/v1_101)).
  - For WAL lock tolerance, set `timeout`/busy timeout to about 5s (`new DatabaseSync(dbPath, { timeout: 5000 })` or `PRAGMA busy_timeout = 5000`). OpenCode and Codex both use WAL + 5s busy timeouts in their own SQLite setups (`opencode/src/storage/db.ts:90-95`; `codex/codex-rs/state/src/runtime.rs:362-369`).
  - If you ever need the sqlite3 CLI fallback for writes, use `.parameter`/`.param` bindings for values only; the shell supports DML, but it is shell-specific and quoting-sensitive. [SQLite CLI docs](https://www.sqlite.org/cli.html)

- **2) OpenCode `session.title` lifecycle**
  - Schema: `session.title text not null` (`opencode/packages/opencode/migration/20260127222353_familiar_lady_ursula/migration.sql:41-48`).
  - Persistent title writes I found are `Session.setTitle({ sessionID, title })` plus the manual session-update route (`opencode/packages/opencode/src/session/index.ts:551-553`; `opencode/packages/opencode/src/server/routes/session.ts:284-286`).
  - Auto-title generation is one-shot: `ensureTitle()` returns unless `Session.isDefaultTitle(input.session.title)` is true, then runs only on `step === 1` after the first real user message. I found no later regeneration path that overwrites a non-default title (`opencode/packages/opencode/src/session/prompt.ts:1982-2053`).
  - Conclusion: a native write into `session.title` should stick; routine later activity should not clobber it.

- **3) Codex `threads.title` lifecycle**
  - Schema: `threads.title text not null` (`codex/codex-rs/state/migrations/0001_threads.sql:1-19`).
  - The DB write is straightforward and bound-parameterized: `UPDATE threads SET title = ? WHERE id = ?` (`codex/codex-rs/state/src/runtime/threads.rs:635-645`).
  - Live metadata sync derives a title only while `title_seen` is false, from the first user message heuristic (`codex/codex-rs/thread-store/src/thread_metadata_sync.rs:35-46, 251-268`; also `codex/codex-rs/state/src/extract.rs:98-109`). So the heuristic does not keep regenerating on later activity.
  - Reconciliation/backfill preserves explicit titles: `prefer_existing_explicit_title()` keeps an existing non-first-message title when rollout-derived metadata would otherwise overwrite it, and both `rollout/src/metadata.rs` and `rollout/src/state_db.rs` call it before upsert (`codex/codex-rs/state/src/model/thread_metadata.rs:275-287`; `codex/codex-rs/rollout/src/metadata.rs:268-271`; `codex/codex-rs/rollout/src/state_db.rs:529-534`).
  - Important edge: Codex treats a title equal to `first_user_message` as non-explicit (`distinct_thread_metadata_title()` returns `None`), so a “rename” that exactly matches the first prompt can be ignored on read/fallback. Codex also keeps an append-only `session_index.jsonl` name index, and explicit rename paths update both SQLite and that index (`codex/codex-rs/thread-store/src/local/read_thread.rs:313-325`; `codex/codex-rs/rollout/src/session_index.rs:31-70, 107-121`; `codex/codex-rs/thread-store/src/local/update_thread_metadata.rs:600-624`).
  - Conclusion: a DB-only update should stick for a true explicit title, but for Codex you should mirror the rename into the name index; avoid titles that exactly equal the first user message if you want them treated as explicit.

- **4) General safety**
  - Both targets are WAL-backed and use 5s busy timeouts (`opencode/src/storage/db.ts:90-95`; `codex/codex-rs/state/src/runtime.rs:362-369`), so a short parameterized rename is acceptable even while the agent is live.
  - Use a single short transaction / statement, parameterize everything, and retry `database is locked` with backoff. There is no reliable “currently active session” bit in the DB itself, so “write only when idle” is a nice-to-have, not a prerequisite.

## Recommended Approach
- Use `node:sqlite` first (`DatabaseSync`) for the native rename writer.
- Write titles with bound parameters and a ~5s busy timeout.
- For Codex, update both `threads.title` and `session_index.jsonl`; for OpenCode, update only the SQLite row.

## Confidence
- **High** on SQLite capability, Node gating, and the OpenCode/Codex write paths.
- **Medium-high** on “won’t be clobbered” because the preserving logic is explicit, but I did not trace every future release path or legacy consumer.

## Gaps
- I did not validate behavior against a running binary; this is source-based.
- I did not inspect every legacy Codex consumer of `session_index.jsonl`, so DB-only rename risk is lowest when you mirror the index.

Sources:
- [Node.js SQLite docs](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)
- [VS Code 1.101 release notes](https://code.visualstudio.com/updates/v1_101)
- [SQLite CLI docs](https://www.sqlite.org/cli.html)

Persisted file: /Users/huybuidac/Projects/ai-oss/anywhere-terminal/docs/research/20260707-vault-native-rename.md
