## ADDED Requirements

### Requirement: Resume a session in a new visible terminal

The system SHALL resume a selected session by spawning the agent's native resume command — built from the registry template with the session's captured per-session flags (model, permission/approval mode, sandbox, reasoning effort, agent) re-injected — in a NEW AnyWhere Terminal session whose working directory is the session's recorded `cwd`. The new session SHALL be surfaced as a selectable tab in the active view (the host posts the same tab-created notification the normal new-tab flow uses). WHEN the agent executable cannot be launched, the system SHALL surface an error notice rather than leaving a silently-broken terminal.

### Requirement: Fork a session when supported

The system SHALL offer a fork action that runs the agent's fork command in a new terminal. For OpenCode, fork SHALL be available only when the detected `opencode --version` is ≥ 1.14.50; when fork is unsupported for an agent or version, the fork action SHALL be unavailable for that entry rather than failing at launch.

### Requirement: Preserve Claude auth/config on launch (best-effort)

WHEN launching a Claude resume or fork, the system SHALL ensure the auth-env allowlist values present in the extension-host environment reach the spawned process: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CONFIG_DIR`, plus any `CLAUDE_CONFIG_DIR` captured at index time. This is best-effort: when the extension host lacks the user's login-shell environment, the resumed session targets the same account only insofar as those vars were available — the system SHALL NOT claim success it cannot guarantee, and SHALL surface launch/auth failures via the error notice.

### Requirement: Injection-safe command construction

Session ids, cwd, model, and flag values interpolated into a launch command SHALL be validated or escaped such that a crafted value in a session file cannot inject additional shell commands.

#### Scenario: Hostile session id cannot inject commands

- **WHEN** a session entry's id or a captured flag value contains shell metacharacters (e.g. `; rm -rf ~`)
- **THEN** the launch either rejects the value or passes it as a single inert argument, and no extra command is executed
