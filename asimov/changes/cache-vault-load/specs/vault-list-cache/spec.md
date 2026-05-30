## ADDED Requirements

### Requirement: Instant cached list on open

On a session-list request, WHEN a valid persisted cache exists, the host SHALL respond immediately with the
cached list (flagged `fromCache: true`) without first scanning any agent store, then perform a refresh and
send the reconciled list (flagged `fromCache: false`). WHEN no valid cache exists, the host SHALL perform a
full read and send a single response.

#### Scenario: Cache hit serves before scan

- **WHEN** the vault is opened and a valid cache exists
- **THEN** a `vaultSessionsResponse` carrying the cached entries (`fromCache: true`) is sent before any
  agent store is read, and a second `vaultSessionsResponse` (`fromCache: false`) follows after the refresh

### Requirement: Incremental refresh of changed sources only

A refresh SHALL re-read only sources whose backing files changed since the cache was written, detected by
`(mtimeMs, size)`: per **session file** for Claude (unchanged files reuse their cached entry, skipping the
metadata + AI-title tail read), and per **store file** (`.sqlite`/`.db` plus its `-wal` sidecar) for Codex
and OpenCode (an unchanged store reuses its cached entries, skipping the snapshot clone and query). Sources
that changed SHALL be re-read in full for that source.

### Requirement: Deletion and edit reconciliation

A refresh SHALL drop cached entries whose backing session file no longer exists (Claude) or which the store
no longer returns (Codex/OpenCode), and SHALL replace the cached entry for any source whose `(mtimeMs, size)`
changed. The refreshed, merged list SHALL remain sorted by `modified` descending with fork support resolved,
identical in shape to a full read.

### Requirement: Persisted cache location, format, and recovery

The cache SHALL persist to `<globalStorageUri>/vault-cache/list.json` as a versioned JSON document
(`version: 1`) written atomically (temp file + rename) with file mode `0o600` and directory mode `0o700`.
WHEN the cache file is missing, unreadable, fails to parse, or carries an unrecognized `version`, the host
SHALL treat it as absent and perform a full rebuild — never crash and never serve a partial/garbled list.

#### Scenario: Unsupported cache version is discarded

- **WHEN** the cache file exists but its `version` is not recognized by the running build
- **THEN** the cache is treated as absent and a full read rebuilds it; no entry from the old file is served

### Requirement: No re-render when nothing changed

WHEN a refreshed list is equivalent to the list currently displayed — same entries, in the same order, with
identical values for every field the row, the folder filter, and the row actions read (`id`, `agent`,
`title`, `cwd`, `modified`, `canFork`, `sessionPath`, `flags`) — the webview SHALL NOT re-render the list, so
an open preview, scroll position, and selection are undisturbed. WHEN the refreshed list differs in any such
field, the webview SHALL update to it. The webview SHALL keep its in-memory entry list current on every
response (even when the DOM is left untouched) so client-side search/filter never operate on stale data.

### Requirement: Cache is local-only and bounded

The cache SHALL contain only the bounded list metadata already sent over IPC (the per-entry fields of a
`VaultSessionEntry` — including the ≤120-char title preview and the absolute `cwd`/`sessionPath`/
`flags.configDir`) plus per-source `(mtimeMs, size)` freshness stamps. It SHALL NOT contain message bodies
beyond the bounded title, and SHALL NOT be transmitted off the machine. The owner-only (`0o600`) file mode
is the at-rest mitigation; the cache is therefore readable by other processes running as the same OS user
and MAY be copied by a user-configured system/cloud backup — this exposure is the same class already
accepted for persisted terminal snapshots.
