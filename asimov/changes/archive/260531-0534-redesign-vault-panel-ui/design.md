# Design: redesign-vault-panel-ui

## Decisions

### D1: Real agent icons = inline single-path SVGs themed via `currentColor`

Lift three real brand glyphs and inline them as static SVG strings in the webview, each normalized to `fill="currentColor"` so the badge's per-agent accent (the mockup's low-chroma oklch vars) colors the icon. A static map `agentId → { svg, accent }` drives rendering. SVGs are **only ever** inserted from this closed map — never built from session-derived data.

- Claude — `…/warp/app/assets/bundled/svg/claude.svg` (viewBox `0 0 24 24`, `#FF0000` → `currentColor`)
- Codex/OpenAI — `…/opencode/packages/ui/src/assets/icons/provider/openai.svg` (viewBox `0 0 40 40`, already `currentColor`)
- OpenCode — `…/warp/app/assets/bundled/svg/opencode.svg` (viewBox `0 0 24 24`, `#FF0000` → `currentColor`)

Rejected: codicons (not real brand marks — the thing being changed); `<img>` to a bundled asset (cannot recolor per accent via `currentColor`, adds an asset-copy step); remote URL (CSP / offline). Brand glyphs are used nominatively to identify each agent.

### D2: Grouping is a pure client-side transform over the loaded list

`groupEntries(entries, mode)` is a pure function (no DOM, unit-testable) returning ordered groups. Recent → one flat group by `modified` desc. Agent → group by `agent`, header = accent dot + `displayName` + count. Folder → group by `cwd`, collapsible headers, and the per-row cwd chip is omitted. No host round-trip — grouping reuses the already-loaded entries. Selected mode persists via the webview's `vscode.getState/setState` (same channel as the existing collapse / folder-only state).

### D3: Session detail is read on-demand; host resolves the session itself, holds no cache, never re-lists

A detail/context-menu request carries the **`entryId` only** (`<agent>:<sessionId>`). The host resolves the session's location from the `sessionId` alone, against the agent's own store — it does **not** trust any webview-supplied path/cwd, does **not** re-run `VaultService.list()`, and caches nothing (respecting the existing `vault-panel` "Refresh on open: host holds no index cache" requirement):

- **Claude** — glob the store root for the unique session file (`~/.claude/projects/*/<sessionId>.jsonl`). This is a metadata-only directory scan (no transcript content read) — far cheaper than `list()`, which reads the head of every jsonl. The resolved path is containment-checked under the store root before reading.
- **Codex** — look up the `threads` row by `sessionId` (index); locate the rollout jsonl by `sessionId` when present.
- **OpenCode** — query `session`/`message`/`part` by `sessionId`.

The host derives `cwd` for "Open Working Directory" from the resolved record, not from the webview. Rejected: re-list per click (the oracle correctly noted Claude has no row cap, so a full `list()` rescans every project's jsonl head — too costly per click); a retained host index cache (would violate the "no index cache" spec).

### D4: Per-agent detail readers extend the existing readers over a shared substrate

Add `readDetail(entry): Promise<VaultSessionDetail>` to each reader, sharing bounded/defensive helpers in a new `src/vault/readers/detail.ts`. Per agent (per research `docs/research/20260529-agent-session-transcript-schemas.md`):

- **Claude** — stream the session `jsonl`; classify mixed-event records (`user` / `assistant`, `content[]` items `text` / `tool_use` / `tool_result`). Reuse the existing streaming + skip-malformed loop (`claudeReader.ts:62-138`).
- **OpenCode** — reconstruct from `session` + `message` + `part` tables; `part.type === "tool"` and `part.type === "subtask"` are first-class (`opencode/.../message-v2.ts:508-922`). Richest, exact data.
- **Codex** — the `threads` table is an **index, not a transcript**. When a per-session rollout `jsonl` exists (located by the session uuid embedded in the rollout filename, `~/.codex/sessions/**/rollout-*-<sessionId>.jsonl`), parse it with a **dedicated Codex classifier** — `classifyCodexRolloutEvents` — and otherwise return a **partial** detail (`firstPrompt` = `first_user_message` from the `threads` index, `recentActivity`/`latestMessage` omitted) with `partial: true` + a `limitedReason`. The preview renders a small "limited detail" notice for partial results, so a Codex session never silently looks broken.
  - **Build-time discovery (2026-05-29):** the Codex rollout JSONL is **NOT** Claude-shaped (the research had flagged this schema as unverified). Real records are `{timestamp, type, payload}` where `type` ∈ `session_meta`/`event_msg`/`response_item`/`turn_context`. The prompt is `event_msg`/`user_message` `.message`; assistant text is `event_msg`/`agent_message` `.message`; tool calls are `response_item`/`function_call` (`name` + JSON-string `arguments`), `custom_tool_call` (e.g. `apply_patch`, `.input`), and `web_search_call` (`action.query`); token totals are `event_msg`/`token_count` `info.total_token_usage.total_tokens` (take the last, cumulative). So a dedicated classifier (in `codexReader.ts`, reusing the shared `truncate`/`boundActivity` substrate) replaces the planned reuse of the Claude classifier — same `VaultSessionDetail` output, so D5/D6 bounds still hold.

Rejected: one monolithic parser — the three formats (mixed jsonl / normalized SQLite tables / index+rollout) diverge too far.

### D5: Detail is bounded, defensive, and reads first/latest independently of the tail

`recentActivity` capped to the **12** most-recent steps; `firstPrompt` and `latestMessage.text` truncated to **~600 chars**; malformed records skipped-and-counted, never fatal. **`firstPrompt` and `latestMessage` are captured independently of the bounded recent-activity window** — a session with >12 steps must still surface its first prompt. Bounds live in the shared substrate so all three readers enforce them identically. Synthetic / compaction / summary / `last-prompt` / sidechain (subagent-thread) records are **excluded** from `firstPrompt` and `latestMessage` selection (per the research gotchas) so the preview reflects the main conversation.

  - **User revision (2026-05-29):** the bounded 3-section preview (first prompt + 12-step activity + latest message) showed too little — users want to read the whole conversation. Added a full chronological **`timeline`** (`VaultTimelineItem[]`: user/assistant messages interleaved with tool/subagent steps) to `VaultSessionDetail`, built by all three classifiers, and the preview now renders the full scrollable timeline. Still **bounded**: per-message text capped at `MAX_MESSAGE_TEXT` (2000), the timeline at `MAX_TIMELINE_ITEMS` (400, most-recent-kept, `truncated` flag → "resume to see all" notice). `firstPrompt`/`recentActivity`/`latestMessage` remain on the contract as the bounded summary (still produced + tested) but are no longer the preview's primary content. Also: caveat/`isMeta`/bare-slash-command Claude records are dropped from titles + prompts (see [[claude title cleaning]]).

  - **Claude title source (2026-05-29):** the list/preview title now prefers Claude's own UI title — the **latest** `{type:"ai-title", aiTitle}` record — over the first user prompt. These records are regenerated and re-appended near EOF as the session evolves (the freshest wins), and they sit scattered across files that reach tens of MB, so the forward metadata scan (which breaks early once cwd/model/first-prompt are found) never reaches them. `readLatestAiTitle` does a **bounded tail read** (last 64KB) and takes the last `aiTitle` there — O(1) regardless of file size. Falls back to the first-prompt title when a session has no `ai-title` (e.g. very short sessions). Other agents are unaffected (OpenCode already prefers its stored title; Codex uses its thread title).

  - **OpenCode subagents fold into the parent (2026-05-29):** OpenCode stores every subagent AND workflow sub-session as its own `session` row with `parent_id` set — in the user's real store that was **1821 of 2396 rows (76%)**, multi-tier (771 grandchildren). They were flooding the list as standalone sessions. **`parent_id` is the only reliable hierarchy** (the `agent` column is set on just 4 children; `subtask` parts do not correspond to children). So: (1) the **list** SQL excludes children (`WHERE s.parent_id IS NULL OR s.parent_id = ''`) → only top-level conversations (all 575 have their own messages); (2) **detail** embeds each direct child as a new `VaultTimelineItem` kind **`subagentSession`** — a lazy stub (title + first message) merged into the parent timeline at the child's `time_created`. The preview renders it as a **collapsed block**; expanding **lazily** fetches the child's transcript over the existing `requestVaultSessionDetail` flow (`getDetail` resolves children by id; the list filter doesn't block it) and renders it nested (AI indented). A nested child's own `subagentSession` stubs make deeper tiers expandable on demand — **multi-tier with no server recursion**. The stub carries a resolvable **`entryId`** (`opencode:<childId>`); Codex unaffected.

  - **Claude subagents fold in too (2026-05-29) — newer on-disk layout:** newer Claude Code stores subagents NOT as in-file `isSidechain` records (the old `Task` model my first scan assumed — the user's main store has 0 of those) but as separate transcripts under `projects/<cwd>/<sessionId>/subagents/agent-<id>.jsonl` + a clean `agent-<id>.meta.json` (`{agentType, description}`); the spawning tool is **`Agent`** (not `Task`). These live in a subdir so the list is already clean (one flat `<sessionId>.jsonl` per row). For nesting: `readClaudeDetail` (a) discovers the parent's subagents (`listClaudeSubagentStubs` reads each meta + the file's first user record) and passes them as `childStubs` to the shared classifier, which **matches a stub to its `Agent`/`Task` call by `description`** and emits a `subagentSession` at that point (else a plain subagent step; unmatched stubs are appended); (b) resolves a lazy child fetch via a composite id **`claude:<parentId>:subagent:<stem>`** — `getDetail` splits on the first colon, `readClaudeDetail` detects `:subagent:`, containment-checks `<parentId>/subagents/<stem>.jsonl`, and classifies it with **`includeSidechain: true`** (the subagent file is entirely `isSidechain` — that IS its conversation). Same collapsed-block / lazy-expand UX as OpenCode via the unified `entryId`. Codex unaffected.

### D6: Tool / subagent labeling — calls only, not results

`recentActivity` records tool **calls** (`tool_use` / OpenCode `part.type==="tool"`) and **subagent invocations** (Claude `Task` tool_use; OpenCode `subtask` part) — it does **not** add `tool_result` records as their own steps (counting results would double-count tools and risk leaking large outputs). A `tool_result` is consulted only to optionally attach a cheap outcome (e.g. a diff stat) to its originating call. Step shapes:
- `{ kind: "tool", tool, detail?, diff? }` — label = tool name + concise primary arg: `Read`/`Edit`/`Write` → file path; `Bash` → command (truncated); `Grep` → pattern; generic fallback → first string field of the input. `diff` (`{ added, removed }`) only when cheap (OpenCode edit part metadata, or newline delta of Claude `Edit` old/new strings).
- `{ kind: "subagent", name, prompt? }` — `name` = `subagent_type`/`agent`, `prompt` = `prompt`/`description`.

### D7: Token count is best-effort, optional

`stats.tokenCount` — OpenCode: exact, sum the assistant `tokens` object (`input + output + reasoning + cache.read + cache.write`). Claude: approximate cumulative sum of assistant `message.usage`. Codex: from rollout usage when present, else omitted. The field is optional; the preview shows it only when present.

### D8: Fork is removed from the UI, retained in code

Drop the fork button and the `vaultFork` send from row rendering. Keep `.vault-action--fork { display: none }` as a CSS hook so any stray query doesn't break, and keep the registry `forkCommand` + `VaultLauncher` fork path in code (referenced by no UI). The `vault-panel` spec's row requirement is updated to "no fork action".

### D9: Context-menu actions are entryId-based; host derives every path

All context-menu messages carry **`entryId` only**; the host re-resolves the entry and derives any path/cwd/command itself. The webview never sends a file path to act on.

**Resolution path (build-time refinement, 2026-05-29):** context-menu actions are *rare* user actions (right-click → click) and several need the entry's captured **flags** (Copy Resume Command) and `cwd`/`sessionPath`, which the hot-path detail read (`getDetail`, D3) does not carry. So the host resolves the entry for these actions via `VaultService.list()` + find — the SAME mechanism `VaultLauncher.resolve` already uses for resume — which keeps everything host-derived (the security property the oracle required) without adding a parallel single-session metadata-parse surface to every reader. The "no re-list" rule of D3 remains in force only for the high-frequency per-row-activation **detail** read; it does not apply to these rare context-menu actions.

- **Resume in New Tab** → existing `vaultResume`.
- **Open** → `vaultOpenSessionFile { entryId }` → host resolves path → `vscode.window.showTextDocument`.
- **Reveal in Finder** → `vaultRevealInOS { entryId }` → host resolves path → `revealFileInOS`.
- **Open Working Directory** → `vaultOpenWorkingDir { entryId }` → host resolves cwd from the record → reveal/open folder.
- **Copy Resume Command** → `vaultCopyResumeCommand { entryId }` → host builds the string via `LaunchBuilder` and writes `vscode.env.clipboard.writeText`.
- **Copy File Path** → `vaultCopyFilePath { entryId }` → host resolves path and copies it via `vscode.env.clipboard` (host-side — avoids webview `navigator.clipboard` permission gaps).

`VaultSessionEntry.sessionPath?` remains on the list entry purely as a **UI hint**: its presence tells the webview whether to render the file-targeting items (Open / Reveal / Copy File Path). It is never used as the action's path input — the host re-derives that from `sessionId`. File-backed: Claude (always), Codex (when a rollout jsonl exists); DB-backed: OpenCode (`sessionPath` undefined → file items hidden).

### D10: Layout, interaction & preview anchoring follow the mockup

Single-line CSS-grid row (`22px | minmax(0,1fr) | auto | auto`); icon-only Resume revealed on hover/focus over a gradient fade. The preview is an absolutely-positioned floating card inside `.vault-panel` (not a split sibling), toggled by `.is-open`, **anchored near the activated row** (JS sets top/left, clamped within the panel), closed on Esc / click-outside; at most one open. The container-query narrow-mode rules (hide cwd chip, center the card) are ported verbatim. Existing list keyboard behavior is preserved; **no new keyboard navigation is added** in this change (out of scope). Lift the `LIFT … INTO THE EXTENSION` block of `docs/research/vault.html` into `vaultPanel.css`.

**Build-time adaptations (2026-05-29):**
- **No codicon font is bundled in the webview** (the existing FileTreePanel uses inline SVGs, not the codicon font). So every `<i class="codicon …">` in the mockup is substituted with a small inline SVG (`stroke`/`fill="currentColor"`), matching the FileTreePanel pattern. The agent badges already use the real brand SVGs from the `agentIcons` map (D1).
- **Collapse composition is preserved** (proposal "out of scope": keep the collapsible-above-file-tree composition). The mockup's `.vault-header` (title-row + search) is NOT lifted verbatim — the existing `.vault-header` stays the collapse toggle (chevron + title + count), and the mockup's toolbar/body styling is lifted below it. Collapse hides `.vault-toolbar`/`.vault-status`/`.vault-body`.
- **Search is an inline header toggle (2026-05-29 user revision):** the always-visible search strip was removed. A search button in the header (right edge, `stopPropagation` so it never collapses the panel) swaps the title row (`.vault-header__main`) for an inline input (`.vault-header__search`) — file-tree header parity. `enterSearch` auto-expands a collapsed panel + focuses the input; the button becomes a close affordance; Esc or re-click exits and clears the query. Search remains entirely client-side (filters `this.query` in `renderList`, no IPC) — no platform/Windows surface.

### D11: Launch resolves a SINGLE entry by id, never the aggregate list (2026-05-29 follow-up)

Resume/fork must not block on scanning every agent store. `VaultLauncher.resolve` calls a new `VaultService.getEntry(entryId)` that resolves ONE entry from only the relevant agent's store via a point/locate-by-id lookup — mirroring `getDetail` (D3: resolve-by-id, no full list, no cache). Per-agent single-entry readers (`readClaudeEntry`/`readCodexEntry`/`readOpenCodeEntry`) reuse each reader's existing locate-by-id logic and share the list path's entry-mapper (no duplication): OpenCode is a `WHERE s.id = ?` point lookup (no `parent_id` filter, so a child session is still resumable); Claude reuses the containment-checked `resolveClaudeSessionPath`; Codex is a `threads` point lookup with the by-filename rollout fallback. **Why:** the prior `resolve()` ran the full `list()` — three store scans (incl. the multi-GB `opencode.db`) plus an `opencode --version` probe — on every Resume click, making launch take seconds. `getEntry` resolves `canFork` the same way `list()` does, but spawns the opencode probe only for an opencode entry.

### D12: Folder-scope filter uses the HOST's per-pane cwd, resolved reactively (2026-05-29 follow-up)

"This folder only" scopes to the focused terminal pane's REAL cwd, resolved HOST-side (`SessionManager`: live `getLiveCwd` lsof/`/proc` → shell-integration `getCurrentCwd` → spawn `getInitialCwd`) over a new `requestVaultContextCwd`/`vaultContextCwd` IPC round-trip, NOT the webview's OSC-7-only `instance.cwd`. **Why:** OSC 7 requires shell integration; without it every pane resolved to the same workspace root, so pane-switch and `cd` produced no change (the filter was a silent no-op). The webview re-requests the cwd on: pane/focus change (re-scope on pane switch), vault open, and — debounced ~400 ms — the active pane's terminal output (catches a bare `cd` without shell integration). The reply echoes `sessionId` so a reply for a no-longer-active pane is dropped. Resolution order keeps the value authoritative even when only the spawn cwd is known; the webview falls back to OSC 7 then the workspace root only when the host returns null (e.g. Windows). The cwd is used solely for a string-prefix filter (`isWithin`), never for file access — the host still never trusts a webview-supplied path (resolves by `sessionId` from its own SessionManager).

### D13: SQLite snapshot via copy-on-write CLONE (not an in-place read) (2026-05-29 follow-up)

`readSqlite` still snapshots the store before querying — but the snapshot is a copy-on-write **clone** (`cp -c` on macOS/APFS, `cp --reflink=auto` on Linux), falling back to a byte copy when the filesystem doesn't support reflink. **Why a clone, not a byte copy:** the original byte-copied the whole store (+ `-wal`/`-shm`) on every query; OpenCode's `opencode.db` is **1.4 GB** → ~1.2 s per copy, and `readOpenCodeDetail` issues **3** queries (messages/parts/children) → ~3.6 s per preview open; list and (post-D11) resume each paid ~1.2 s. A clone of the same 1.4 GB store measured **~31 ms** (≈40×), with identical snapshot semantics (an independent file view). **Why NOT read the live store in place:** an earlier attempt to query the live DB with `sqlite3 -readonly` was correct in a quiescent shell (~5 ms) but, against a *live* WAL store in the extension host, a read-only open can silently return an EMPTY result rather than erroring — indistinguishable from a genuinely-empty session — so it surfaced **"not found" for real OpenCode sessions**. Because an empty result can't be distinguished from "couldn't read the WAL", there's no safe fallback trigger; the in-place read was reverted. The clone keeps the proven copy-snapshot read (queries the snapshot read-only, replays `-wal`) while removing the byte-copy cost. The `node:sqlite` engine (Windows, no CLI) is unchanged (queries the snapshot). This is the shared root cause behind "resume is slow" and "opening a session is slow"; D11 removed resume's aggregate scan, D13 makes the per-query snapshot near-free.

### D14: Prefer the `node:sqlite` engine over the `sqlite3 -json` CLI (2026-05-30 follow-up)

The SQLite read PREFERS the in-process `node:sqlite` built-in; the `sqlite3` CLI is the fallback when `node:sqlite` is unavailable (older runtimes). **Why:** the `sqlite3` CLI's `-json` output formatter is pathologically slow — measured **~33 s of CPU** to serialize one OpenCode session's `message` rows (~1.5 MB, with large embedded `summary.diffs` blobs), vs **~0.006 s** for the same query without `-json` and **~16–23 ms** via `node:sqlite`. The 33 s blew past `QUERY_TIMEOUT_MS` (5 s) → the messages query returned `query-error` → `readOpenCodeDetail` returned null → **"Session not found" for any large session** (e.g. `ses_3291…`, 364 messages). It was not the copy, the index (the plan uses `message_session_time_created_id_idx`), or the `-shm` — purely the CLI formatter. `node:sqlite` returns native row values (no `-json`), is already present in the VS Code Electron host, and still queries the clone snapshot (D13). Combined: a previously-unopenable session now loads in <1 s.

## Interfaces

```ts
// src/vault/types.ts — additions
export interface VaultSessionEntry {
  // …existing: id, agent, sessionId, title, cwd, modified, flags, canFork…
  sessionPath?: string; // UI hint only (file-backed vs DB-backed); NOT a trusted action input
}

export type VaultActivityStep =
  | { kind: "tool"; tool: string; detail?: string; diff?: { added: number; removed: number } }
  | { kind: "subagent"; name: string; prompt?: string };

export interface VaultSessionDetail {
  entryId: string;
  firstPrompt?: string;                 // ≤ ~600 chars, captured independent of the tail
  recentActivity: VaultActivityStep[];  // most-recent last, ≤ 12, calls + subagents only
  latestMessage?: { role: "user" | "assistant"; text: string; timestamp: number };
  stats: { messageCount: number; toolCount: number; subagentCount: number; tokenCount?: number };
  partial?: boolean;                    // true when built from an index, not a transcript (Codex)
  limitedReason?: string;               // short reason shown in the preview when partial
}

// VaultService.list() result — extended so the notice "Details" has a contract
export interface VaultListResult {
  entries: VaultSessionEntry[];
  unreadable: { count: number; reasons: string[] }; // deduped short per-source skip reasons
}
```

```ts
// src/types/messages.ts — additions (all webview→host requests carry entryId ONLY)
interface RequestVaultSessionDetailMessage { type: "requestVaultSessionDetail"; entryId: string }
interface VaultRevealInOSMessage          { type: "vaultRevealInOS"; entryId: string }
interface VaultOpenSessionFileMessage     { type: "vaultOpenSessionFile"; entryId: string }
interface VaultOpenWorkingDirMessage      { type: "vaultOpenWorkingDir"; entryId: string }
interface VaultCopyResumeCommandMessage   { type: "vaultCopyResumeCommand"; entryId: string }
interface VaultCopyFilePathMessage        { type: "vaultCopyFilePath"; entryId: string }
// host → webview
interface VaultSessionDetailResponseMessage {
  type: "vaultSessionDetailResponse"; entryId: string; detail?: VaultSessionDetail; error?: string
}
```

## Architecture — on-demand detail flow

```
row click/Enter/Space
  → webview: set activePreviewEntryId = id; open preview (loading); post requestVaultSessionDetail{entryId}
    → host TerminalViewProvider.handleRequestVaultSessionDetail
      → VaultService.getDetail(entryId):
          resolve session by sessionId in the agent store (glob/jsonl for claude+codex-rollout; DB for opencode/codex-index)
          → reader.readDetail(resolvedLocation)
      → post vaultSessionDetailResponse{entryId, detail|error}
  → webview: IF entryId === activePreviewEntryId render sections (omit empty; show "limited" notice if partial)
             ELSE ignore (stale)
```

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| Claude detail reader | mixed-event jsonl, malformed lines, large files | reuse existing stream+skip loop (`claudeReader.ts:62-138`); capture first/latest independent of the 12-step tail (D5); unit-test classify helper with jsonl fixture incl. summary/sidechain records |
| Codex detail | `threads` is index-only; rollout jsonl schema unconfirmed | parse rollout jsonl when present (shared classifier), else `partial` detail from index with a "limited" notice (D4); unit-test both paths |
| OpenCode detail | compacted/synthetic parts; multi-table join | follow `message-v2` part types from research doc; exclude synthetic/compaction from first/latest; unit-test pure row→step mapper with fixture rows |
| Token count | not uniformly available | optional field — exact OpenCode, approx Claude, omit Codex when absent (D7) |
| Session resolution | per-click cost / path trust | resolve by unique `sessionId` (metadata-only glob / DB lookup), containment-checked under store root; no re-list, no cache, no webview path/cwd trust (D3/D9) |
| Stale preview render | slow response for row A lands after opening row B | webview ignores responses where `entryId !== activePreviewEntryId` (Architecture); unit-test |
| Clipboard in webview | `navigator.clipboard` permission gaps | both Copy actions are host-side via `vscode.env.clipboard` (D9) |
| Inline SVG | CSP / theming / injection | static local SVG strings from the closed icon map only, never from session data; `fill=currentColor` (D1) |
| Safe rendering | transcript text injecting markup | render via `textContent` only; wrapper tokens shown literally (spec: Safe preview rendering) |
| Unreadable "Details" | SHALL with no contract | `unreadable.reasons[]` added to `VaultListResult`; the notice's Details affordance reveals them (D-spec) |
