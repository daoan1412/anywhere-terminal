---
topic: agent-live-session-detection
created-by: Independent fact-check research for a VS Code extension deciding whether OpenCode/Codex CLI sessions are currently live in a terminal
date: 2026-07-07
libraries: [anomalyco/opencode, openai/codex]
used-by: []
---

# Research: agent-live-session-detection

## Answers

1. **OpenCode default TUI does not start a listening HTTP server. CONFIRMED.**
   The default `opencode` TUI path uses an internal worker transport and the fake base URL `http://opencode.internal`; the local run mode comment explicitly says no external HTTP server is needed. Sources: [tui.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/tui.ts), [run/runtime.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run/runtime.ts), [run.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts).

2. **No per-session PID→session mapping file surfaced in current OpenCode upstream. CONFIRMED (repo-wide scan).**
   I found session state stored in SQLite `SessionTable` code, not in a per-session pidfile. The only PID-bearing on-disk file I found is the daemon registration JSON in the CLI daemon service (`{id, version, url, pid}`), which is for the daemon itself, not a session mapping. Sources: [session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts), [daemon.ts](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/services/daemon.ts).

3. **OpenCode `/session/status` exposes live runtime status, not all stored sessions. CONFIRMED.**
   The handler returns `Object.fromEntries(yield* statusSvc.list())`; the status service is an in-memory `Map<SessionID, Info>`. Idle entries are deleted from the map, while the explicit status union includes `idle`, `retry`, and `busy`. So this endpoint is about execution state (busy/retry) rather than “open in terminal.” Sources: [handlers/session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts), [session/status.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts), [session-status-event.ts](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts).

4. **OpenCode session timestamps are persisted metadata timestamps, not a heartbeat. CONFIRMED.**
   Session records carry `time_created`, `time_updated`, `time_compacting`, and `time_archived`. The DB schema defines `time_updated` as an auto-updating timestamp field, and the session list code uses it for sorting/filtering. I found no code path tying `time_updated` to mere “open” state; the live status is tracked separately in the in-memory status map. Sources: [session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts), [schema.sql.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/database/schema.sql.ts), [projector.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/projector.ts).

5. **Codex does not write a per-session pidfile/lockfile mapping process→thread/session UUID. CONFIRMED.**
   The upstream files I found are daemon-level only: `app-server.pid`, `app-server-updater.pid`, and `daemon.lock`. Those belong to the optional app-server daemon lifecycle, not to individual sessions/threads. Sources: [app-server-daemon/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/lib.rs), [pid_tests.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/backend/pid_tests.rs), [doctor/background.rs](https://github.com/openai/codex/blob/main/codex-rs/cli/src/doctor/background.rs).

6. **Codex rollout JSONL is append-based, not guarded by a per-session advisory lock. REFUTED for advisory-lock semantics; CONFIRMED for mtime-updated freshness.**
   The rollout/listing code documents `updated_at` as file mtime, and the write paths append to the rollout file then explicitly set the modified time after writing. I did not find a per-session file lock around rollout appends. There is a separate `.tmp/rollout-compression.lock`, but that is for the compression worker’s throttling, not for session append synchronization. Sources: [list.rs](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs), [tests.rs](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/tests.rs), [tui/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/lib.rs), [compression_tests.rs](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/compression_tests.rs).

7. **Codex has a live thread API (`thread/loaded/list`) and it is reachable through the app-server transport, not only an opt-in socket. CONFIRMED.**
   The app-server docs describe a standalone server with pluggable transports; stdio is the default, and the Unix socket is for local control-plane clients. `thread/loaded/list` is the JSON-RPC method for listing thread IDs currently loaded in memory. That means a plain Codex client using the default app-server transport can reach it; it is not socket-only. Sources: [app-server/README.md](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [ClientRequest.ts](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts), [thread_loaded_list tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/test_app_server.rs), [PR #11786](https://github.com/openai/codex/pull/11786).

8. **Codex thread/session timestamps include `created_at`, `updated_at`, `recency_at`, and `archived_at`; `updated_at` is file-mtime-backed and `recency_at` is a separate ordering signal. CONFIRMED.**
   The rollout list docs say `created_at` comes from the filename timestamp, `updated_at` comes from file mtime, and `recency_at` is used for product recency ordering. A local store test shows live thread output advances `updated_at` but not `recency_at`, which is the clearest evidence that `updated_at` is a freshness/mutation field while `recency_at` is more selective. Sources: [list.rs](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs), [thread-store/src/local/mod.rs](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/mod.rs), [thread_metadata.rs](https://github.com/openai/codex/blob/main/codex-rs/state/src/model/thread_metadata.rs), [threads.rs](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/threads.rs).

## Current upstream versions

- **OpenCode:** `v1.17.14` published 2026-07-06. Source: [release](https://github.com/anomalyco/opencode/releases/tag/v1.17.14)
- **Codex:** `rust-v0.142.5` / `0.142.5` published 2026-07-01. Source: [release](https://github.com/openai/codex/releases/tag/rust-v0.142.5)

## Cross-cutting verdict

A freshness / “recently updated” heuristic is **usable only as a coarse proxy**, not as a reliable live-session detector.

- **False negatives:** idle-but-open sessions can stop updating their timestamps.
- **False positives:** a just-closed session can still look “fresh” for a while.
- **OpenCode:** the stronger live signal is `/session/status`, which reflects the in-memory execution map and removes idle entries.
- **Codex:** the stronger live signals are app-server status APIs and `thread/loaded/list`; `updated_at` is already used for ordering/resume flows, but that is a freshness heuristic, not a liveness guarantee.
- **Clock / timestamp caveats:** OpenCode stores epoch-millis timestamps, while Codex normalizes rollout times to RFC3339/mtime; both still depend on host clock behavior and filesystem metadata behavior.

## Recommended Approach

- Prefer explicit live-status APIs when they exist.
- For OpenCode, query `/session/status` first and treat missing entries as idle/not-running.
- For Codex, prefer app-server live-thread/status APIs; use `updated_at` or file mtime only as a fallback or picker heuristic.
- If a heuristic is unavoidable, combine “recently updated” with an explicit non-idle/live-state signal and a short grace window.

## Gotchas & Constraints

- `updated_at` is **not** a heartbeat in either project.
- OpenCode’s status map is in-memory; idle sessions are deleted from it.
- Codex `updated_at` comes from file mtime, which can be influenced by explicit timestamp writes, filesystem granularity, and clock skew.
- The absence of a per-session pidfile is a repository scan result, not a formal API guarantee; upstream could add one later.
- I did not find the exact legacy OpenCode issue number `#3169`; the current matching request is [#32288](https://github.com/anomalyco/opencode/issues/32288).

## Precedent

- OpenCode has a current feature request for richer `/session/status` state in [issue #32288](https://github.com/anomalyco/opencode/issues/32288).
- Codex already exposes live thread status and loaded-thread APIs via [PR #11786](https://github.com/openai/codex/pull/11786) and the app-server protocol.
- Codex’s `resume` / thread listing paths already use `updated_at` as a freshness proxy, which is useful for ordering but not for proving a session is live. Source: [issue #19517](https://github.com/openai/codex/issues/19517).

## Gaps

- I did not inspect every Codex terminal entrypoint exhaustively; the current app-server docs show stdio as the default transport and a socket as optional.
- I did not find a dedicated third-party “live sessions” indicator pattern beyond the built-in OpenCode/Codex APIs and picker heuristics.

## Sources

- [OpenCode TUI internal worker path](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/tui.ts)
- [OpenCode local run/runtime path](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run/runtime.ts)
- [OpenCode run command path](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)
- [OpenCode session status service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)
- [OpenCode session status event schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts)
- [OpenCode session record shape](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts)
- [OpenCode DB timestamp schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/database/schema.sql.ts)
- [OpenCode daemon registration service](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/services/daemon.ts)
- [OpenCode latest release](https://github.com/anomalyco/opencode/releases/tag/v1.17.14)
- [OpenCode session state feature request](https://github.com/anomalyco/opencode/issues/32288)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex app-server protocol client request schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts)
- [Codex app-server thread loaded-list test helper](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/test_app_server.rs)
- [Codex app-server daemon PID files](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/lib.rs)
- [Codex app-server daemon pid tests](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/backend/pid_tests.rs)
- [Codex rollout list semantics](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs)
- [Codex rollout write tests](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/tests.rs)
- [Codex TUI rollout writer](https://github.com/openai/codex/blob/main/codex-rs/tui/src/lib.rs)
- [Codex rollout compression tests](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/compression_tests.rs)
- [Codex live updated_at test](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/mod.rs)
- [Codex thread metadata model](https://github.com/openai/codex/blob/main/codex-rs/state/src/model/thread_metadata.rs)
- [Codex thread runtime state](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/threads.rs)
- [Codex PR #11786](https://github.com/openai/codex/pull/11786)
- [Codex resume freshness issue](https://github.com/openai/codex/issues/19517)
- [Codex latest release](https://github.com/openai/codex/releases/tag/rust-v0.142.5)

Persisted report: /Users/huybuidac/Projects/ai-oss/anywhere-terminal/docs/research/20260707-agent-live-session-detection.md