## ADDED Requirements

### Requirement: Parse OSC 633 command-boundary markers

The system SHALL extend the existing OSC 633 parser to recognise sequences `A` (prompt start), `B` (command-input end / output start), `C` (pre-execution), `D` (command finished, with optional decimal exit-code argument), and `E` (explicit command line, with optional nonce). The existing `P;Cwd=` handling SHALL continue to function unchanged.

#### Scenario: Exit code captured from D marker

- **WHEN** the PTY data stream contains the sequence `ESC ] 633 ; D ; 0 ST`
- **THEN** the tracker MUST close the currently-open command with `exitCode = 0`. If the `D` argument is absent, `exitCode` is `null`.

#### Scenario: Nonce-protected E marker

- **WHEN** the parser receives `ESC ] 633 ; E ; <command> ; <nonce> ST`
- **THEN** the tracker MUST accept the command text only if `<nonce>` matches the per-session nonce issued at PTY spawn (see `terminal-session-export` D3 reference). Mismatched nonces MUST cause the command-line field to remain empty rather than be populated from untrusted output.

### Requirement: Per-session command list with bounded memory

The system SHALL maintain, per `TerminalSession`, an ordered list of executed commands. Each entry SHALL carry `id` (UUID), `commandLine` (string, may be empty), `output` (string, ANSI preserved), `exitCode` (number | null), `cwd` (string | null), `startedAt` (ms epoch), `endedAt` (ms epoch | null), `outputBytes` (number — true byte count even when `output` is truncated), and `outputTruncated` (boolean).

#### Scenario: Per-command output cap (checked at append time)

- **WHEN** appending bytes to a single open command's `output` would cause `output.length` to exceed 100 KB
- **THEN** the tracker MUST discard those bytes and ALL subsequent appends for the same command, MUST continue incrementing `outputBytes` by the full byte count of every discarded chunk, and MUST set `outputTruncated = true` when the command closes via `D`. The cap MUST be enforced inside the append path so that a never-closing command (e.g. `cat /dev/urandom`) cannot grow `_inFlightCommand.output` past 100 KB.

#### Scenario: Per-session eviction

- **WHEN** the per-session list reaches 200 entries OR the aggregate of all `output` strings in the list reaches 1 MB, whichever first
- **THEN** the oldest entries MUST be removed FIFO until both invariants hold.

### Requirement: Inject shell-integration scripts at PTY spawn

The system SHALL auto-inject VS Code's shell-integration scripts when spawning a PTY whose shell binary is recognised as bash, zsh, fish, or pwsh. Injection SHALL set environment variables and / or shell launch arguments such that the user's normal rc / profile files continue to load. The exact injection mechanism per shell is defined in `design.md` D3.

#### Scenario: Unrecognised shell

- **WHEN** the spawn binary is not in the recognised list (e.g. `cmd.exe`, `nushell`, custom binary)
- **THEN** the system MUST spawn the PTY without injection, MUST NOT emit a parser error, and per-command export commands MUST surface the "shell integration not active" UX defined in `terminal-session-export`.

### Requirement: Public read API for tracked commands

The system SHALL expose, on `SessionManager`, two methods: `getTrackedCommands(sessionId: string): TrackedCommand[]` returning the list ordered oldest-first, and `getLastCompletedCommand(sessionId: string): TrackedCommand | null` returning the most-recently-closed command (closed = `endedAt` non-null) or `null` if none exists.

#### Scenario: In-flight command not returned by getLastCompletedCommand

- **WHEN** a command has been opened (markers A/B/C seen) but not yet closed (D not seen)
- **THEN** `getLastCompletedCommand` MUST skip it and return the previous completed command (or `null`).
