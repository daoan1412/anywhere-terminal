# agent-vault-registry Specification
## Requirements

### Requirement: Data-driven agent definitions

The system SHALL represent each supported AI CLI agent as a data record (not inline logic) carrying at least: `id`, `displayName`, a `detect` rule (executable basename + optional argv needles), a `sessionStore` descriptor (path template + format `jsonl | sqlite`), a `sessionIdSource`, a `resumeCommand` template, an optional `forkCommand` template with optional `forkMinVersion`, a `cwdPolicy`, and an optional `authEnvAllowlist`.

The system MUST ship records for `claude`, `codex`, and `opencode`. Adding a new agent's **launch** (resume/fork) MUST require only a registry record — no launcher control-flow edits. Adding a new agent's **history reading** MAY additionally require a small per-agent reader, because path layout and file schema differ per agent even within a shared `format`; the shared `format` substrate (`readSqlite`, jsonl streaming, defensive skip-and-count) MUST be reusable so the per-agent reader stays small.

#### Scenario: New agent's launch needs only a record

- **WHEN** a maintainer adds a registry record (with resume/fork templates) for a new agent
- **THEN** resume and fork for that agent work without any change to launcher code

### Requirement: Resume and fork command templates

The system SHALL store resume/fork command shapes as templates with the substitution tokens `{{sessionId}}`, `{{sessionPath}}`, and `{{executable}}`, plus optional per-flag fragments substituted only when the corresponding captured value is present.

The registry records MUST encode these exact command shapes (from `docs/research/20260528-cmux-vault-mechanism.md`):
- Claude resume: `claude --resume {{sessionId}} [--model <m>] [--permission-mode <p>]`; fork: `claude --resume {{sessionId}} --fork-session`.
- Codex resume: `codex resume {{sessionId}} [-m <m>] [-a <approval>] [-s <sandbox>] [-c model_reasoning_effort=<e>]`; fork: `codex fork {{sessionId}}`.
- OpenCode resume: `opencode --session {{sessionId}} [-m <model>] [--agent <agent>]`; fork: `opencode --session {{sessionId}} --fork` gated on `forkMinVersion` 1.14.50.

