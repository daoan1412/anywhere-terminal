---
topic: vault-session-formats
created-by: research for enhance-vault-sessions session extraction
date: 2026-07-07
libraries: [codex, claude-code, opencode, vscode]
used-by: [enhance-vault-sessions]
---

# Research: vault-session-formats

## Answers

- Where do session files live, what format do they use, and how does a session map to files?
  - Codex
    - Canonical session artifacts are append-only JSONL rollouts under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl`.
    - One rollout file corresponds to one session thread; the rollout begins with a `session_meta` line and then appends `RolloutItem` lines.
    - Related append-only sidecars exist for `~/.codex/session_index.jsonl` and `~/.codex/history.jsonl`.
    - SQLite state mirrors exist separately (`logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `state_5.sqlite`); they are runtime/state stores, not the primary transcript.
  - Claude Code
    - Canonical transcripts are append-only JSONL files in `~/.claude/projects/<project-slug>/<sessionId>.jsonl`.
    - Per-project `sessions-index.json` is a lightweight session list; `~/.claude/history.jsonl` is global prompt history; `~/.claude/sessions/<pid>.json` tracks live process/session registry state.
    - Sidechain/subagent entries are routed to separate transcript files via `getAgentTranscriptPath(agentId)`.
  - OpenCode
    - Canonical session storage is SQLite, not JSONL. The observed DB was `~/.local/share/opencode/opencode.db` with WAL enabled.
    - Session rows live in `session`; per-message rows in `message`; per-part rows in `part`.
    - Prompt recall is a separate JSONL file at `~/.local/state/opencode/prompt-history.jsonl`.
    - `~/.local/share/opencode/log/opencode.log` is operational logging, not the session format.

- Do message/turn records carry model IDs and token/context usage, and what are the exact field paths?
  - Codex
    - Model data is present in the turn-context model field (`TurnContextItem.model`), but the raw JSONL sample did not pin the exact serialized key name beyond the turn-context payload.
    - Context/token usage is explicit in rollout events:
      - `payload.type == "task_started"` → `payload.model_context_window`
      - `payload.type == "token_count"` → `payload.info.total_token_usage.input_tokens`
      - `payload.info.total_token_usage.cached_input_tokens`
      - `payload.info.total_token_usage.output_tokens`
      - `payload.info.total_token_usage.reasoning_output_tokens`
      - `payload.info.total_token_usage.total_tokens`
      - `payload.info.last_token_usage.input_tokens`
      - `payload.info.last_token_usage.cached_input_tokens`
      - `payload.info.last_token_usage.output_tokens`
      - `payload.info.last_token_usage.reasoning_output_tokens`
      - `payload.info.last_token_usage.total_tokens`
      - `payload.info.model_context_window`
    - Session metadata also carries `payload.context_window` in `session_meta`.
  - Claude Code
    - Assistant transcript entries carry model ID at `message.model`.
    - Token usage is recorded at:
      - `message.usage.input_tokens`
      - `message.usage.cache_creation_input_tokens`
      - `message.usage.cache_read_input_tokens`
      - `message.usage.output_tokens`
      - `message.usage.service_tier`
      - `message.usage.cache_creation.ephemeral_5m_input_tokens`
      - `message.usage.cache_creation.ephemeral_1h_input_tokens`
      - `message.usage.iterations[]`
    - No separate context-window field was found in the transcript records inspected.
  - OpenCode
    - Per-session model is available both in the `session` row (`model` JSON string) and in each message payload as `data.modelID` / `data.providerID`.
    - Token usage paths in `message.data` are:
      - `data.tokens.total`
      - `data.tokens.input`
      - `data.tokens.output`
      - `data.tokens.reasoning`
      - `data.tokens.cache.read`
      - `data.tokens.cache.write`
    - Session-level rollups are mirrored in table columns:
      - `session.tokens_input`
      - `session.tokens_output`
      - `session.tokens_reasoning`
      - `session.tokens_cache_read`
      - `session.tokens_cache_write`
      - `session.cost`
    - No dedicated context-window column was seen in the inspected rows.

- Do session records carry cwd, workspace, or git branch info?
  - Codex
    - Yes. `session_meta` includes `payload.cwd`.
    - `session_meta` / rollout metadata also carry `workspace_roots` and top-level `git` metadata in `SessionMetaLine.git`.
    - Lineage fields such as `parent_thread_id`, `forked_from_id`, and `session_id` help reconstruct session ancestry.
  - Claude Code
    - Yes. Transcript entries carry `cwd` and `gitBranch` at the top level.
    - Live/worktree state is stored in `worktree-state` entries with `originalCwd`, `worktreePath`, `worktreeName`, `worktreeBranch`, `originalBranch`, `originalHeadCommit`, and `sessionId`.
    - `sessions-index.json` includes `gitBranch`, `projectPath`, `fullPath`, `isSidechain`, and created/modified metadata.
  - OpenCode
    - Yes for workspace/root context, not as a first-class branch field.
    - `session` rows store `directory`, `workspace_id`, `path`, and `agent`.
    - Per-message payloads store `data.path.cwd` and `data.path.root`.
    - No explicit branch column was found in the inspected schema; branch must be derived from the underlying repo/worktree if needed.

- Is there a mutable title/name, or does rename need a sidecar file?
  - Codex
    - Rename is append-only through `session_index.jsonl`; `append_thread_name(...)` appends `SessionIndexEntry { id, thread_name, updated_at }`.
    - The rollout transcript itself is not rewritten in place; newest appended name wins.
  - Claude Code
    - Yes, via append-only metadata entries.
    - User rename uses `custom-title` records (`customTitle`) and AI rename uses separate `ai-title` records (`aiTitle`).
    - `reAppendSessionMetadata()` refreshes the cached title from the tail and re-appends it so the latest title survives compaction and future growth.
    - There is also a mutable process-registry `name` field in `~/.claude/sessions/<pid>.json`.
  - OpenCode
    - Yes, directly in the DB.
    - `session.title` is a mutable column and `Session.setTitle({ sessionID, title })` updates it in place.
    - No sidecar file is required for rename semantics.

- How is active growth / new appended messages detected for live-follow?
  - Codex
    - Watch the rollout JSONL file for size/mtime changes and tail from the last byte offset.
    - `session_index.jsonl` is also append-only and can be tailed for name/title updates.
    - Growth is signaled by appended lines; the file itself is the source of truth.
  - Claude Code
    - Tail the transcript JSONL file incrementally; the code itself uses bounded head/tail scans rather than full-file reads.
    - The 64 KB tail window is intentionally refreshed for mutable metadata (`custom-title`, `tag`, etc.), so live-follow should preserve byte offsets and only rescan newly appended bytes.
    - For active-session discovery, watch `~/.claude/sessions/<pid>.json` and `sessions-index.json` as lighter-weight refresh signals.
  - OpenCode
    - Do not tail the DB file as if it were JSONL.
    - Watch `opencode.db` mtime/WAL activity, then query rows with `time_updated > last_seen` or `id > last_seen`.
    - If the app exposes an event stream or polling API, prefer that over raw file watching.

- What should a VS Code extension use for session-list watching and efficient tailing?
  - Use `workspace.createFileSystemWatcher(...)` with a `RelativePattern` for the session directory or list file.
  - Recursive watchers can be limited by `files.watcherExclude`, so the pattern should stay focused on the specific session artifacts.
  - For append-only JSONL, keep a byte offset per file and read only newly appended bytes on `onDidChange`.
  - For large transcripts, use bounded head/tail reads instead of full-file reloads; that is the same approach Claude Code uses internally.
  - For SQLite-backed stores, watch the DB file plus query deltas (`time_updated`, `created_at`, `rowid`/`id`) rather than trying to tail the DB.

## Recommended Approach

- Model the extractor as three adapters:
  - JSONL append-only adapter for Codex and Claude Code.
  - SQLite delta adapter for OpenCode.
  - Shared session-list watcher that triggers incremental refreshes, not full reloads.
- Normalize the metadata into one internal record shape:
  - `sessionId`, `title`, `cwd`, `workspaceRoot`, `gitBranch`, `modelId`, `providerId`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, `contextWindow`, `updatedAt`.
- For rename detection:
  - prefer `custom-title` over `ai-title` for Claude Code,
  - prefer session index entries for Codex,
  - use `session.title` for OpenCode.
- For live-follow:
  - JSONL files should be tailed by byte offset,
  - SQLite should be polled by `time_updated` / WAL-aware delta queries.

## Usage Examples

- Codex sample file inspected: `~/.codex/sessions/2026/03/13/rollout-2026-03-13T16-16-22-019ce67b-8d92-7311-bec4-781d5bd8455c.jsonl`
  - `session_meta.payload.cwd`
  - `task_started.payload.model_context_window`
  - `token_count.payload.info.total_token_usage.*`
- Claude Code sample file inspected: `~/.claude/projects/-Users-huybuidac--local-share-claude/0b32c487-c898-4bcb-a9ef-0e3301ca0ada.jsonl`
  - `assistant.message.model = "claude-haiku-4-5-20251001"`
  - `assistant.message.usage.input_tokens`
  - `assistant.message.usage.cache_read_input_tokens`
  - `assistant.message.usage.output_tokens`
  - `assistant.message.usage.cache_creation.ephemeral_5m_input_tokens`
  - `assistant.message.usage.cache_creation.ephemeral_1h_input_tokens`
- Claude Code session index sample inspected: `~/.claude/projects/-Users-huybuidac-Projects-ai-oss-git-mcp/sessions-index.json`
  - `sessionId`, `fullPath`, `fileMtime`, `firstPrompt`, `messageCount`, `created`, `modified`, `gitBranch`
- OpenCode sample DB inspected: `~/.local/share/opencode/opencode.db`
  - `session.title`
  - `session.directory`
  - `session.model`
  - `message.data.modelID`
  - `message.data.tokens.total`
  - `message.data.path.cwd`
  - `message.data.path.root`
- OpenCode prompt history sample inspected: `~/.local/state/opencode/prompt-history.jsonl`
  - `input`, `parts`, `mode`

## Gotchas & Constraints

- Codex model/session metadata is split across files; do not assume the rollout file alone contains the human-readable session name.
- Claude Code uses append-only metadata entries for titles; a stale cached title can be resurrected unless the tail refresh/re-append behavior is respected.
- OpenCode is SQLite-first; JSONL tailing logic does not apply to the canonical store.
- The installed Claude bundle under `~/.local/share/claude` did not expose readable JS sources in the visible tree, so Claude Code conclusions come from the OSS source plus live session files rather than the bundled app code.
- A dedicated context-window field was not confirmed in Claude Code or OpenCode session records; Codex is the only one that surfaced an explicit context-window field in the inspected data.

## Gaps

- Codex model support is confirmed at the Rust type level (`TurnContextItem.model`), but the raw JSONL sample did not pin the exact serialized key name for the model field in a turn record.
- The exact on-disk naming template for Claude Code sidechain transcripts was not pinned in the live examples; separate sidechain files are confirmed, but not every path variant.
- No canonical session artifacts were found under `~/.config/opencode`; the canonical OpenCode session store was the SQLite DB in `~/.local/share/opencode`.
- No first-class context-window field was found in Claude Code or OpenCode transcripts/rows.

## Confidence

High — findings are backed by official OSS source, plus live on-disk session files from all three tools and VS Code extension API docs. The only notable uncertainty is the exact serialized Codex turn-model key name, which is confirmed in code but not pinned by a raw JSONL sample.
