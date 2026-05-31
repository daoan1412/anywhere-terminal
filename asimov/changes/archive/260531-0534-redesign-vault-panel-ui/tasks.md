# Tasks: redesign-vault-panel-ui

<!-- Verify enum: unit <path> | integration <path> | e2e <path> | manual <check> | none — <reason> -->
<!-- Project § Commands: check-types `pnpm run check-types` · lint `pnpm run lint` · test `pnpm run test:unit` (Vitest) · E2E N/A -->

## 1. Foundations — types & icon assets

- [x] 1_1 Add detail/IPC types, `sessionPath`, and unreadable reasons
  - **Deps**: none
  - **Refs**: design.md D3, D4, D9; Interfaces section; specs/vault-session-preview/spec.md#requirement-session-detail-ipc; specs/vault-panel/spec.md#requirement-empty-and-partial-failure-states
  - **Scope**: `src/vault/types.ts`, `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: `VaultSessionEntry` gains optional `sessionPath`; `VaultActivityStep` + `VaultSessionDetail` (incl. `partial?` + `limitedReason?`) are exported; `VaultListResult.unreadable` becomes `{ count, reasons: string[] }`; the new message interfaces (`requestVaultSessionDetail`, `vaultSessionDetailResponse`, `vaultRevealInOS`, `vaultOpenSessionFile`, `vaultOpenWorkingDir`, `vaultCopyResumeCommand`, `vaultCopyFilePath`) — all webview→host requests carrying `entryId` only — are added to the message union.
    - Verify: none — type definitions, covered by `pnpm run check-types`
  - **Plan**:
    1. Add the types/fields exactly as in design.md Interfaces (`unreadable.reasons`, `partial`/`limitedReason`, `sessionPath`).
    2. Add the new message interfaces + include them in the union/type guards.

- [x] 1_2 Add agent brand-icon module
  - **Deps**: none
  - **Refs**: design.md D1; docs/research/vault.html (`.vault-badge--*` accents)
  - **Scope**: `src/webview/vault/agentIcons.ts`
  - **Acceptance**:
    - Outcome: exports a map `agentId → { svg: string; accent: "claude"|"codex"|"opencode" }` with the three real single-path SVGs normalized to `fill="currentColor"`; no remote refs.
    - Verify: none — static assets, exercised by 4_1 render
  - **Plan**:
    1. Copy the three SVG bodies (Claude + OpenCode from warp → replace `#FF0000` with `currentColor`; OpenAI from opencode already `currentColor`), strip width/height, keep `viewBox`, expose as inline strings keyed by agent id.

## 2. Host — per-agent detail readers

- [x] 2_1 Shared detail substrate + event classifier
  - **Deps**: 1_1
  - **Refs**: design.md D4, D5, D6; docs/research/20260529-agent-session-transcript-schemas.md (gotchas §80-92)
  - **Scope**: `src/vault/readers/detail.ts`, `src/vault/readers/detail.test.ts`
  - **Acceptance**:
    - Outcome: pure helpers — `truncate(text, 600)`, `boundActivity(steps, 12)`, `toolLabel(name, input)` (Read/Edit/Write→path, Bash→command, Grep→pattern, fallback→first string field), and `classifyClaudeStyleEvents(records)` returning `{ firstPrompt, recentActivity, latestMessage, stats }`. Activity contains tool **calls** + `Task` subagent steps only (NOT `tool_result` steps); `firstPrompt`/`latestMessage` are chosen independent of the 12-step cap and skip `summary`/`last-prompt`/sidechain records; usage tokens summed when present.
    - Verify: unit `src/vault/readers/detail.test.ts`
  - **Plan**:
    1. Implement pure IO-free helpers.
    2. `classifyClaudeStyleEvents`: capture first real `user` text; accumulate `tool_use`/`Task` into steps (consult `tool_result` only to attach an optional diff); track last non-sidechain assistant message; sum usage; count messages/tools/subagents; apply bounds.
    3. Unit-test: first prompt survives a >12-step session; Read+Bash+Task → expected steps; `tool_result` is not its own step; `summary`/sidechain records excluded from first/latest.

- [x] 2_2 Claude `readDetail` + resolve-by-sessionId
  - **Deps**: 1_1, 2_1
  - **Refs**: design.md D3, D4, D7; src/vault/readers/claudeReader.ts:62-138,155-205
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.detail.test.ts`
  - **Acceptance**:
    - Outcome: a resolver locates the session file by globbing `~/.claude/projects/*/<sessionId>.jsonl` (metadata-only, containment-checked under the store root); `readDetail` streams it (reusing the skip-malformed loop), runs `classifyClaudeStyleEvents`, returns a bounded `VaultSessionDetail`; the list path stamps `entry.sessionPath` with the jsonl path.
    - Verify: unit `src/vault/readers/claudeReader.detail.test.ts`
  - **Plan**:
    1. Add `resolveSessionPath(sessionId)` (glob + containment check) and `readDetail`.
    2. Feed records to `classifyClaudeStyleEvents`; set `entryId`.
    3. Stamp `sessionPath` in the list path; unit-test with a jsonl fixture (first prompt + tool_use + Task + final assistant + usage).

- [x] 2_3 OpenCode `readDetail`
  - **Deps**: 1_1, 2_1
  - **Refs**: design.md D4, D6, D7; src/vault/readers/opencodeReader.ts:19-115; docs/research/20260529-agent-session-transcript-schemas.md (message-v2 part types)
  - **Scope**: `src/vault/readers/opencodeReader.ts`, `src/vault/readers/opencodeReader.detail.test.ts`
  - **Acceptance**:
    - Outcome: `readDetail(sessionId)` queries `message`+`part` rows for the session, maps `part.type==="tool"`→tool step and `part.type==="subtask"`→subagent step via a pure mapper, derives `firstPrompt`/`latestMessage`/`stats` with exact token sum, excludes synthetic/compaction parts from first/latest; `sessionPath` stays undefined (DB-backed).
    - Verify: unit `src/vault/readers/opencodeReader.detail.test.ts` (pure `mapOpencodeRows` with fixture rows incl. a synthetic part)
  - **Plan**:
    1. Add SQL to fetch the session's messages+parts ordered by time (bounded).
    2. Factor + unit-test pure `mapOpencodeRows(messages, parts)` → `VaultSessionDetail`.
    3. Wire query → mapper in `readDetail`.

- [x] 2_4 Codex `readDetail` (rollout when present, else partial)
  - **Deps**: 1_1, 2_1
  - **Refs**: design.md D4, D7; src/vault/readers/codexReader.ts:23-29,129-188
  - **Scope**: `src/vault/readers/codexReader.ts`, `src/vault/readers/codexReader.detail.test.ts`
  - **Acceptance**:
    - Outcome: `readDetail` parses the per-session rollout jsonl via a **dedicated Codex classifier** (`classifyCodexRolloutEvents` — the rollout schema is NOT Claude-shaped; see design D4 build-time discovery) when found (and stamps `sessionPath`); when only the `threads` index is available it returns a partial detail — `firstPrompt` = `first_user_message`, no `recentActivity`/`latestMessage`, `partial: true`, `limitedReason` set; the list path stamps `sessionPath` from `threads.rollout_path` (or the fallback jsonl path) when present.
    - Verify: unit `src/vault/readers/codexReader.detail.test.ts` (rollout path + index-only partial path)
  - **Plan**:
    1. Resolve rollout jsonl by sessionId (filename scan `rollout-*-<sessionId>.jsonl`, contained under the sessions dir); if present, stream + `classifyCodexRolloutEvents`.
    2. Else build partial detail from the `threads` index row (`first_user_message`) with `partial`/`limitedReason`.
    3. Stamp `sessionPath` in the list path; unit-test both branches.

- [x] 2_5 `VaultService.getDetail` + unreadable reasons
  - **Deps**: 2_2, 2_3, 2_4
  - **Refs**: design.md D3; specs/vault-session-preview/spec.md#requirement-on-demand-session-detail-read; specs/vault-panel/spec.md#requirement-empty-and-partial-failure-states
  - **Scope**: `src/vault/VaultService.ts`, `src/vault/VaultService.detail.test.ts`
  - **Acceptance**:
    - Outcome: `getDetail(entryId)` parses agent+sessionId and dispatches to that reader's `readDetail` (resolving the session by id within the agent store — no full `list()`, no cache), returning a clear error when unresolved; `list()` aggregates per-source skip reasons into `unreadable.reasons`.
    - Verify: unit `src/vault/VaultService.detail.test.ts`
  - **Plan**:
    1. Implement `getDetail(entryId)` dispatch by agent.
    2. Collect per-reader failure reasons into `VaultListResult.unreadable.reasons` (deduped).

## 3. Host — IPC handlers & resume-command string

- [x] 3_1 Resume-command string builder
  - **Deps**: 1_1
  - **Refs**: design.md D9; src/vault/LaunchBuilder.ts; asimov/specs/agent-vault-registry/spec.md#requirement-resume-and-fork-command-templates
  - **Scope**: `src/vault/LaunchBuilder.ts`, `src/vault/LaunchBuilder.command.test.ts`
  - **Acceptance**:
    - Outcome: `buildResumeCommandString(entry)` renders the registry resume template (executable + captured flags) to a single shell string, reusing existing substitution.
    - Verify: unit `src/vault/LaunchBuilder.command.test.ts`
  - **Plan**:
    1. Add the function; unit-test claude/codex/opencode shapes incl. optional flags.

- [x] 3_2 Host handlers: detail + context-menu actions (entryId-based)
  - **Deps**: 2_5, 3_1
  - **Refs**: design.md D3, D9; specs/vault-panel/spec.md#requirement-row-context-menu; src/providers/TerminalViewProvider.ts:320-374
  - **Scope**: `src/providers/TerminalViewProvider.ts`
  - **Acceptance**:
    - Outcome: handlers for `requestVaultSessionDetail` (→ `getDetail` → `vaultSessionDetailResponse{entryId, detail|error}`), `vaultRevealInOS`/`vaultOpenSessionFile` (host resolves path by sessionId → `revealFileInOS` / `showTextDocument`), `vaultOpenWorkingDir` (host derives cwd from the record → open folder), `vaultCopyResumeCommand` (build string → `vscode.env.clipboard`), `vaultCopyFilePath` (host resolves path → `vscode.env.clipboard`). All inputs are `entryId`; no webview path is trusted; file actions no-op when the session has no resolvable file.
    - Verify: manual — right-click a Claude session → Open / Reveal / Copy File Path / Copy Resume Command each act; clicking a row returns detail; an OpenCode session's file actions are absent
  - **Plan**:
    1. Add cases to the vault message switch; resolve session server-side by id before any file action.
    2. Wire each to its VS Code API; guard file actions on a resolvable path.

## 4. Webview — rows, icons, grouping, states

- [x] 4_1 Rewrite row rendering (grid + real icon + hover resume, no fork)
  - **Deps**: 1_2
  - **Refs**: design.md D1, D8, D10; specs/vault-panel/spec.md#requirement-searchable-vault-panel; docs/research/vault.html (`.vault-row`, `.vault-badge`, `.vault-row-actions`)
  - **Scope**: `src/webview/vault/VaultPanel.ts`, `src/webview/vault/VaultPanel.test.ts`
  - **Acceptance**:
    - Outcome: each row is the single-line grid (badge with real agent SVG from the icon map | title | cwd chip | time) with an icon-only Resume revealed on hover/focus; no fork button is rendered and no `vaultFork` is sent; titles/cwd use `textContent`.
    - Verify: unit `src/webview/vault/VaultPanel.test.ts` (no fork button / no `vaultFork`; badge svg comes from the icon map; title via textContent)
  - **Plan**:
    1. Replace codicon badge with `agentIcons` svg + accent class.
    2. Rebuild row DOM to the grid; move Resume into the hover/focus overlay; delete fork rendering + `vaultFork` send.

- [x] 4_2 Grouping modes + no-match + unreadable "Details"
  - **Deps**: 4_1
  - **Refs**: design.md D2; specs/vault-panel/spec.md#requirement-grouping-modes, #requirement-empty-and-partial-failure-states; docs/research/vault.html (`.vault-segmented`, `.vault-group-header`, `.vault-notice`)
  - **Scope**: `src/webview/vault/grouping.ts`, `src/webview/vault/grouping.test.ts`, `src/webview/vault/VaultPanel.ts`, `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: a segmented control switches Recent/Agent/Folder via pure `groupEntries(entries, mode)` (Agent: accent dot + name + count; Folder: collapsible, row cwd chip omitted); selected mode persists across reload; a search with no results shows the distinct no-match state; the unreadable notice's "Details" toggles an inline list of `unreadable.reasons`.
    - Verify: unit `src/webview/vault/grouping.test.ts` (pure grouping) + manual (segmented switch persists; Details expands)
  - **Plan**:
    1. Implement + unit-test `groupEntries`.
    2. Add segmented control + group headers; Folder mode suppresses row cwd chip + supports collapse.
    3. Persist mode via `vscode.getState/setState`; add no-match branch; wire notice "Details" to show `reasons`.

- [x] 4_3 Restyle `vaultPanel.css` to the mockup
  - **Deps**: 4_1
  - **Refs**: design.md D10; docs/research/vault.html (the `LIFT … INTO THE EXTENSION` block)
  - **Scope**: `src/webview/vault/vaultPanel.css`
  - **Acceptance**:
    - Outcome: header/search/toolbar/segmented/notice/empty/no-match/row/badge/actions-overlay/context-menu/preview styles match the mockup, incl. the per-agent accent vars, gradient resume overlay, `.vault-action--fork{display:none}` hook, and the container-query narrow-mode rules.
    - Verify: manual — panel visually matches the mockup at sidebar and wide widths
  - **Plan**:
    1. Port the mockup's extension-CSS block; keep colors on `--vscode-*` vars; add the three `--vault-accent-*` oklch vars.

## 5. Webview — context menu & preview overlay

- [x] 5_1 Row context menu
  - **Deps**: 3_2, 4_1, 4_3
  - **Refs**: design.md D9; specs/vault-panel/spec.md#requirement-row-context-menu; docs/research/vault.html (`.vault-context-menu`)
  - **Scope**: `src/webview/vault/VaultPanel.ts`, `src/webview/vault/VaultPanel.test.ts`, `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: right-click opens the menu at the cursor with the six items; the three file items are hidden when the entry has no `sessionPath`; each item posts the matching `entryId`-only message (no path sent); Esc / click-outside closes; no `⋯` trigger exists.
    - Verify: unit `src/webview/vault/VaultPanel.test.ts` (file items hidden when `sessionPath` absent; each item posts the correct entryId-only message)
  - **Plan**:
    1. Build the menu DOM on `contextmenu`, position at cursor, mark `.is-context-open` on the row.
    2. Conditionally include file items on `sessionPath`; wire actions to messages; close on Esc / outside click.

- [x] 5_2 Session preview overlay (on-demand, stale-safe, partial-aware)
  - **Deps**: 1_1, 3_2, 4_1, 4_3
  - **Refs**: design.md D3, D4, D10; specs/vault-panel/spec.md#requirement-session-preview-activation; specs/vault-session-preview/spec.md#requirement-safe-preview-rendering; docs/research/vault.html (`.vault-preview`)
  - **Scope**: `src/webview/vault/VaultPanel.ts`, `src/webview/vault/VaultPanel.test.ts`, `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: activating a row sets `activePreviewEntryId`, opens the floating preview (anchored near the row, loading state), and posts `requestVaultSessionDetail{entryId}`; on response it renders header + meta + First prompt / Recent activity / Latest message (empty sections omitted) all via `textContent`, shows a "limited detail" notice when `partial`, and an inline error on `error`; responses whose `entryId` ≠ `activePreviewEntryId` are ignored; Esc / click-outside closes; only one preview open at a time.
    - Verify: unit `src/webview/vault/VaultPanel.test.ts` (row activation posts request; stale response ignored; partial → notice; text via textContent) + manual (Claude session preview shows timeline)
  - **Plan**:
    1. Render `.vault-preview` card; open on activation with loading; track `activePreviewEntryId`; post the request.
    2. Handle `vaultSessionDetailResponse`: ignore stale; render sections (icons per step kind, from the static map), omit empties, escape text, show partial/error states; wire Resume + Close, Esc, outside-click.
