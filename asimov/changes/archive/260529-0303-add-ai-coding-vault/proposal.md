# Proposal: add-ai-coding-vault

## Why
Developers run AI coding CLIs (Claude Code, OpenCode, Codex) inside the terminal and lose track of past sessions; resuming one means remembering its id and flags. AnyWhere Terminal already sits on the PTY/process layer, so it can become an *orchestrator* of the user's existing CLI agents — a searchable "vault" of past sessions, each resumable/forkable in one click — with **no AI model, no API key, no `vscode.lm`**. Modeled on cmux's "Vault."

## Appetite
**L (≤2w)** — 3 agents (2 SQLite-backed + 1 JSONL), a webview panel, IPC wiring, and resume/fork launch. The readers are the *predictable* part; the likely overrun (per oracle review) is the `createSession` launch-mode extension + tab-visibility wiring + SQLite failure-mode fixtures + error states. To stay within L, **OpenCode and/or fork support are the slip candidates** (Claude+Codex browse+resume is the irreducible core); treat as **L+** if both must land.

## Scope

### In scope
- A **data-driven agent registry** (records for `claude`, `codex`, `opencode`) so further agents are a config/reader add, not a rewrite.
- **On-disk session readers** that build a metadata-only list: Claude (`~/.claude/projects/<enc-cwd>/*.jsonl`), Codex (`~/.codex/state_5.sqlite` → `threads`, JSONL fallback), OpenCode (`~/.local/share/opencode/opencode.db` → `session`).
- A **searchable webview panel** (modeled on the file-tree panel) listing sessions, with resume + fork actions and a command to open it.
- **Resume/fork** by spawning the agent's native CLI in a fresh AT terminal, preserving Claude auth/config env.

### Out of scope
- Live "which pane is running which agent right now" detection (A1) and the "needs attention" notification ring (A3) — separable features, deferred.
- Transcript / conversation rendering (A6) — privacy + scope. Metadata only.
- Any AI model integration (NL→command, autosuggest, etc. — Theme B).
- **Registry-ready follow-up agents** (readers exist in cmux to port later): Grok, Pi, RovoDev, Hermes, Antigravity. **Detect-only agents** (no history reader anywhere — would need inventing): Amp, Cursor, Gemini, Copilot, CodeBuddy, Factory, Qoder.
- Cross-platform paths — macOS-only assumptions match AT today; degrade cleanly elsewhere.

## Capabilities

1. **agent-vault-registry** — data-driven agent definitions (detect, session-store, resume/fork templates) that the readers and launcher consume; new agents add a record (+ a reader only if a new file format).
2. **agent-session-index** — per-agent readers + aggregation into one recency-sorted, metadata-only session list, with defensive parsing and a WAL-safe SQLite read.
3. **vault-session-launch** — synthesize and run an agent's native resume/fork command in a new AT terminal, with auth-env preservation and injection-safe interpolation.
4. **vault-panel** — a searchable webview panel listing sessions with resume/fork actions, plus the open/reveal command and empty/error states.

## UI Impact & E2E
- **User-visible UI behavior affected?** YES — a new searchable vault panel + a command, plus spawning resume terminals.
- **E2E required?** NOT REQUIRED.
- **Justification**: `asimov/project.md` § Commands lists **E2E: N/A** (no E2E harness). Reader/synthesis logic is covered by Vitest unit tests against fixtures; the panel + resume flow is verified manually (it depends on real agent CLIs + on-disk files).

## Risk Level
**MEDIUM** — reads undocumented, version-fragile 3rd-party session formats and synthesizes shell commands that launch external CLIs; mitigated by registry-isolated readers, defensive parsing, metadata-only/no-egress privacy posture, and injection-safe interpolation.
