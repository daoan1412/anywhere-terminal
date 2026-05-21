## ADDED Requirements

### Requirement: OSC 7 cwd detection

The system SHALL passively parse OSC 7 escape sequences emitted by the shell on the terminal's PTY data stream and update the session's recorded current working directory. Accepted byte forms:

- `ESC ] 7 ; <payload> BEL` where `BEL = 0x07`
- `ESC ] 7 ; <payload> ST` where `ST = ESC \` (i.e. `0x1B 0x5C`)

The `<payload>` MUST be parsed as a `file://` URL. The path component MUST be URL-decoded (percent-encoded bytes resolved). The hostname is ignored (any value accepted — SSH/remote contexts use non-local hostnames legitimately).

### Requirement: OSC 633 cwd detection

The system SHALL also parse VS Code's proprietary OSC 633 `Cwd` reports of the form:

- `ESC ] 633 ; P ; Cwd = <path> ST`

The `<path>` is taken literally (not URL-decoded — OSC 633 emits raw paths). Same chunk-boundary handling as OSC 7. This enables cwd tracking when the user has VS Code's shell-integration script active in their rc.

### Requirement: Chunk-boundary handling

The parser MUST maintain a pending buffer across `node-pty` `onData` callbacks so that an escape sequence split across two chunks is detected correctly. The pending buffer MUST be capped at 4096 bytes; on overflow the open OSC is discarded and scanning resumes at the next `ESC ] 7 ;` or `ESC ] 633 ;` boundary.

### Requirement: Pass-through guarantee

The OSC listener MUST be an OBSERVER. The original `data` payload from node-pty MUST be forwarded to the existing `PtySession.onData` user callback unchanged in content, length, and timing. The OSC listener MUST NOT swallow, mutate, or reorder any bytes.

### Requirement: Sanitization before storage

Before storing a parsed cwd, the system SHALL:

1. URL-decode (OSC 7 only).
2. Normalize via `path.resolve(<decoded>)`.
3. Reject the update if the result is not an absolute path.
4. Reject the update if the result contains a null byte (`0x00`).

Rejected payloads MUST be silently ignored (no error surfaced; pending buffer is consumed and parsing continues).

### Requirement: Live cwd query via process table

The system SHALL provide a `SessionManager.getLiveCwd(sessionId): Promise<string | undefined>` method that asynchronously queries the OS process table for the PTY child process's current working directory:

- **Linux**: read the symbolic link `/proc/<pid>/cwd` via `fs.promises.readlink`.
- **macOS**: invoke `lsof -a -p <pid> -d cwd -Fn` and parse the first output line beginning with `n` (the path), stripping the leading `n`.
- **Windows / other**: return `undefined` (unsupported in v1).

The method MUST return `undefined` when:
- The session is unknown.
- The PTY has no pid (not yet spawned, or already exited).
- The OS query fails (process gone, permission denied, `lsof` missing, malformed output).
- The platform is unsupported.

Operational constraints:
- **Lazy**: the query MUST only be invoked on demand (e.g., during `openFile` resolution). No background polling or periodic refresh.
- **Bounded latency**: the macOS `lsof` shell-out MUST have a 500ms timeout enforced by `child_process.execFile`'s `timeout` option to prevent unbounded click latency.
- **Silent failure**: errors MUST NOT throw; they MUST be coerced to `undefined` so the resolver can fall through to the next step.

Returned values MUST be sanitized before use:

- Reject the result if it is empty, not a string, or not an absolute path (POSIX `/…` or Windows `<letter>:[\\/]…`). Defensive — `lsof` can occasionally interleave warnings on stdout that begin with `n` despite the `-Fn` mode.
- Reject the result if it ends in ` (deleted)`. Linux `/proc/<pid>/cwd` returns `<path> (deleted)` when the directory has been removed under the process; the path is no longer valid.
- Reject the result if it contains any control byte (`\x00`–`\x1f` or `\x7f`).

Rejected results MUST be silently coerced to `undefined`.

### Requirement: SessionManager cwd surface

The system SHALL extend `SessionManager` with:

- A `currentCwd?: string` field on each `TerminalSession` record (alongside the existing `initialCwd`).
- A public `setCurrentCwd(sessionId: string, cwd: string): void` method that updates the field for the named session. Calls for unknown ids are silently no-op.
- A public `getCurrentCwd(sessionId: string): string | undefined` method returning the recorded value (or `undefined` when unset or session unknown).

