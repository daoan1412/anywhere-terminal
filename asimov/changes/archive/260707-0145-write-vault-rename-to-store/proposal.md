# Proposal: write-vault-rename-to-store

## Why
Vault rename today is an overlay-only sidecar (VaultCustomNameRegistry) — the agent's own session list still shows the old auto-title, so a rename doesn't follow the user back into the CLI. For the two agents that store a real, user-editable title (OpenCode `session.title`, Codex `threads.title`), write the new name into the agent's own store so the rename is authoritative everywhere.

## Appetite
S (≤1d)

## Scope

### In scope
- A WAL-safe SQLite **write** helper (`writeSqlite`) that opens the **live** store read-write, parameterized, with `busy_timeout`.
- Native title write for OpenCode (`UPDATE session SET title=? WHERE id=?`) and Codex (`UPDATE threads SET title=? WHERE id=?`).
- Route `handleVaultRenameSession` by agent: opencode/codex → native write; claude/unknown → existing overlay.
- Precedence: native success clears the overlay for that entry + forces a refresh; native failure falls back to the overlay so the user still sees their name.

### Out of scope
- Claude native rename (no writable title field — derived from summary/first-prompt) → stays overlay.
- Reverting a previously native-written title on clear (store can't recover the original auto-title) — clear removes the overlay only.
- Any change to the read path, cache shape, IPC message shape, or webview.
- Adding a native SQLite dependency (`better-sqlite3` etc.) — uses the built-in `node:sqlite`.

## Capabilities

1. **vault-session-rename** (MODIFIED) — rename may now write the real title into the OpenCode/Codex SQLite store; Claude keeps the no-write overlay; precedence + safety rules for the native path.

## UI Impact & E2E

- **User-visible UI behavior affected?** NO — the vault row/preview already reflect the new name via the existing overlay/refresh; this change only makes the name additionally authoritative inside the agent's own store. No new UI surface.
- **E2E required?** NOT REQUIRED
- **Justification**: The observable webview behavior (row shows new name after rename) is unchanged and already covered. The new behavior is a filesystem/DB side effect, best verified by unit tests including a real round-trip write against a temp SQLite file.

## Risk Level
MEDIUM — first write into an agent-owned store (reverses the read-only posture); mitigated by parameterized writes, `busy_timeout`, node:sqlite-only with overlay fallback, and confirmation from real source that both agents preserve explicit user-set titles.
