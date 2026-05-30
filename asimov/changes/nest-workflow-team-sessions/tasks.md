# Tasks: nest-workflow-team-sessions

<!-- Host-only change. Webview is unchanged (D1). All file paths under src/vault/readers/. -->

## 1. Child entryId protocol

- [x] 1_1 Create the Claude child-id module (format/parse/validate)
  - **Deps**: none
  - **Refs**: design.md D2; specs/agent-session-index/spec.md (Surface workflow sub-agents; Group team-member sessions under their leader); src/vault/types.ts (parseEntryId, first-colon split)
  - **Scope**: `src/vault/readers/claudeChildIds.ts`, `src/vault/readers/claudeChildIds.test.ts`
  - **Acceptance**:
    - Outcome: `parseClaudeChildId(sessionId)` returns the tagged union for `:subagent:` / `:workflow:` / `:wfagent:` / `:team:` ids and `null` for a plain id; `format*` helpers produce the inverse; `wfId` (`^wf_[A-Za-z0-9_-]+$`), `stem` (`^agent-[A-Za-z0-9]+$`), and `parentId` (existing safe-id) are validated, teamName round-trips through encode/decode; a malformed/over-segmented id → `null`.
    - Verify: unit src/vault/readers/claudeChildIds.test.ts
  - **Plan**:
    1. Define `ClaudeChildId` union + `parseClaudeChildId` (detect markers in order `:wfagent:`, `:workflow:`, `:team:`, `:subagent:`; split parentId before the marker, validate each segment, reject on mismatch).
    2. Add `formatSubagentId/formatWorkflowId/formatWorkflowAgentId/formatTeamId`; encode teamName with `encodeURIComponent`.
    3. Tests: round-trip each kind, traversal/`..`/empty/extra-colon rejection, plain id → null.

- [x] 1_2 Add group-stub support + synthetic group-detail helper (shared substrate)
  - **Deps**: none
  - **Refs**: design.md D1 (stats), D8 (group renders title-only); src/vault/readers/detail.ts (ClaudeChildStub, stubToItem, mergeUnmatchedStubs, finalizeDetail)
  - **Scope**: `src/vault/readers/detail.ts`, `src/vault/readers/detail.test.ts`
  - **Acceptance**:
    - Outcome: `ClaudeChildStub` gains optional `isGroup`; when set, `stubToItem` produces a `subagentSession` with NO `agent` field and `mergeUnmatchedStubs` does not apply the `"subagent"` default (so the webview renders title-only). A new `synthesizeGroupDetail(entryId, children, { firstPrompt?, subagentCount })` returns a `VaultSessionDetail` whose `timeline` is one `subagentSession` per child. Real (non-group) subagents are unchanged.
    - Verify: unit src/vault/readers/detail.test.ts
  - **Plan**:
    1. Add `isGroup?: boolean` to `ClaudeChildStub`; in `stubToItem`/`mergeUnmatchedStubs`, omit `agent` and the `"subagent"` fallback when `isGroup`.
    2. Add `synthesizeGroupDetail` (build timeline from children via the existing `stubToItem`; `recentActivity: []`, stats from arg, `finalizeDetail(entryId, …, false)`).
    3. Tests: group stub → title-only item (no `@`); non-group subagent still `@agent`; synthesizeGroupDetail shape + child entryIds.

## 2. Workflow nesting (host)

- [x] 2_1 Discover workflow runs as group stubs
  - **Deps**: 1_1, 1_2
  - **Refs**: design.md D3, D7; specs/agent-session-index/spec.md (Surface workflow sub-agents); src/vault/readers/detail.ts (ClaudeChildStub)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `listClaudeWorkflowStubs(parentId, options)` reads `<projects>/<dir>/<parentId>/workflows/wf_*.json` and returns one `isGroup` `ClaudeChildStub` per manifest (`entryId` = workflow group id, `description` = `Workflow: <workflowName> · <agentCount> agents · <status>`, `timestamp` = coerced `startTime`, `firstMessage` = `summary`); a missing `workflows/` dir → `[]`; a malformed manifest is skipped, not thrown.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. `readdir` `<parentId>/workflows/` (containment-checked); for each `wf_*.json`, read+parse in try/catch, pull top-level fields defensively.
    2. Coerce `timestamp`: `Number(startTime)` when finite, else `Date.parse(manifest.timestamp)`, else `undefined` (D3). Build an `isGroup` stub via `formatWorkflowId`; sort by timestamp.
    3. Tests: fixture parent dir with 2 manifests → 2 group stubs with manifest labels + numeric timestamps; no dir → []; bad JSON → skipped.

- [x] 2_2 Resolve a workflow group's detail (`:workflow:`) — list its agents
  - **Deps**: 1_1, 1_2
  - **Refs**: design.md D3, D8; specs/agent-session-index/spec.md (Surface workflow sub-agents); src/vault/readers/detail.ts (synthesizeGroupDetail, truncate)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `readClaudeDetail` given a `:workflow:<wfId>` id returns `synthesizeGroupDetail` whose `timeline` is one `subagentSession` per `agent-*.jsonl` under `<parentId>/subagents/workflows/<wfId>/` (each `entryId` = wfagent id, `title` = the agent's first prompt bounded else stem, `agent` = `"workflow-subagent"`), `firstPrompt` = manifest summary, `stats.subagentCount` = agent count; unknown wfId/parent → null.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Branch in `readClaudeDetail` on `parseClaudeChildId` → kind `workflow`.
    2. Resolve `<parentId>` (existing path resolver) → its project dir; `readdir subagents/workflows/<wfId>/`; per `agent-*.jsonl` read first user text (reuse `readFirstUserRecord`); build child stubs (entryId via `formatWorkflowAgentId`).
    3. Assemble via `synthesizeGroupDetail`; test ordering + labels + unknown-id null.

- [x] 2_3 Resolve a workflow agent leaf (`:wfagent:`) — its transcript
  - **Deps**: 1_1
  - **Refs**: design.md D3, D6; src/vault/readers/claudeReader.ts (resolveClaudeSubagentPath pattern, classifyClaudeStyleEvents includeSidechain)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `readClaudeDetail` given a `:wfagent:<wfId>:<stem>` id resolves `<parentId>/subagents/workflows/<wfId>/<stem>.jsonl` (containment-checked under the projects root, traversal rejected), streams it, and classifies with `includeSidechain:true`; an unsafe/unlocatable id → null.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Add `resolveClaudeWorkflowAgentPath(parentId, wfId, stem, options)` mirroring `resolveClaudeSubagentPath` (validate, join, `path.relative` containment).
    2. Branch in `readClaudeDetail` for kind `wfagent` → stream + `classifyClaudeStyleEvents({ includeSidechain: true, limit })` + `finalizeDetail`.
    3. Tests: real fixture transcript classified; `../` traversal in stem rejected → null.

## 3. Team nesting (host)

- [x] 3_1 Collect parent teamNames during stream + detect team members
  - **Deps**: none
  - **Refs**: design.md D4, D5; specs/agent-session-index/spec.md (Group team-member sessions under their leader); src/vault/readers/claudeReader.ts (streamClaudeRecords, parseClaudeFile)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `streamClaudeRecords` accepts an optional `onRecord` hook called for every parsed record (before head+tail bounding), enabling teamName collection across the whole file; `parseClaudeFile` result carries `isTeamMember` = true when the first/early record has a non-empty `agentName`.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Add optional `{ onRecord? }` to `streamClaudeRecords`; invoke it in the parse loop before `buffer.push`.
    2. Add `isTeamMember` to `ClaudeFileFields`; set it from the first record's `agentName`.
    3. Tests: onRecord sees a teamName that lands in the dropped middle (force tiny head+tail caps); teammate fixture → isTeamMember true, leader fixture → false.

- [x] 3_2 Discover team-member siblings as group stubs
  - **Deps**: 1_1, 1_2, 3_1
  - **Refs**: design.md D4, D7; specs/agent-session-index/spec.md (Group team-member sessions under their leader)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `listClaudeTeamStubs(parentId, parentTeamNames, options)` returns `[]` when `parentTeamNames` is empty; otherwise scans the parent's project dir, treats each OTHER `<uuid>.jsonl` whose first record has BOTH `agentName` and `teamName ∈ parentTeamNames` as a member, and returns one `isGroup` `ClaudeChildStub` per teamName (`entryId` = team group id, `description` = `Team: <teamName> · <N> members`, `timestamp` = earliest member, coerced to epoch ms).
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Guard on empty `parentTeamNames`; `readdir` the parent's project dir.
    2. For each sibling (≠ parent), read first record; keep when BOTH `agentName` present and `teamName` matches; group by teamName via `formatTeamId`; one `isGroup` stub per team.
    3. Tests: 2 teammates + 1 unrelated member → 1 group of 2; empty teamNames → [].

- [x] 3_3 Resolve a team group's detail (`:team:`) — list its members
  - **Deps**: 1_1, 1_2, 3_2
  - **Refs**: design.md D4, D8; specs/agent-session-index/spec.md (Group team-member sessions under their leader)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `readClaudeDetail` given a `:team:<encoded-teamName>` id resolves `<parentId>`'s project dir, re-scans siblings whose first record has BOTH `agentName` and `teamName == decoded(key)`, and returns `synthesizeGroupDetail` whose `timeline` is one `subagentSession` per member (`entryId` = `claude:<memberSessionId>`, `title` = `@<agentName>`); unknown parent/team → consistently an empty-timeline detail (or null) — pick one and assert it.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Branch in `readClaudeDetail` for kind `team`; decode teamName.
    2. Resolve parent project dir; reuse the sibling scan from 3_2 (factor a shared `scanTeamMembers(projectDir, parentId, teamNames)`); build member child stubs.
    3. Assemble via `synthesizeGroupDetail`; tests: 2 members → 2-item timeline with member full-session entryIds.

- [x] 3_4 Exclude non-lead team members from the top-level list
  - **Deps**: 3_1
  - **Refs**: design.md D5; specs/agent-session-index/spec.md (Group team-member sessions under their leader → Scenario)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `readClaudeSessions` skips files whose first record has BOTH `agentName` and `teamName` (via `parseClaudeFile().isTeamMember`) — NOT added to `entries` AND NOT counted in `unreadable` (skip is a distinct outcome from a parse failure; must not reuse the `buildClaudeEntry → null` path that increments unreadable). Leader + non-team sessions still listed; a genuinely-unreadable file still counts unreadable.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Make the skip explicit in `readClaudeSessions` (or return a discriminated `{skip:"team-member"}` from `buildClaudeEntry`): `continue` without touching `unreadable`.
    2. Tests: dir with leader + 2 teammates + 1 normal session → list has leader + normal only, `unreadable.count` unchanged; a separately-corrupt file still increments unreadable.

## 4. Compose parent detail

- [x] 4_1 Fold workflow + team groups into the parent's detail timeline
  - **Deps**: 2_1, 3_2
  - **Refs**: design.md D3, D4; src/vault/readers/detail.ts (classifyClaudeStyleEvents childStubs, mergeUnmatchedStubs)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: the parent-session branch of `readClaudeDetail` builds `childStubs` = flat subagents ∪ workflow group stubs ∪ team group stubs (team only when teamNames were collected), and `classifyClaudeStyleEvents` merges them; a parent with a workflow + a team shows both group nodes in its timeline, placed by timestamp.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. In the parent path, stream with `onRecord` collecting teamNames; compute `listClaudeSubagentStubs ∪ listClaudeWorkflowStubs ∪ listClaudeTeamStubs`.
    2. Pass combined stubs to `classifyClaudeStyleEvents`; verify a fixture parent (subagent + workflow manifest + sibling teammate) yields all three nested nodes.

## 5. Make nested nodes visible in the detail render (live-UI fix)

- [x] 5_1 Break the run-collapse on `subagentSession` so group nodes are never hidden
  - **Deps**: 4_1
  - **Refs**: design.md D10; specs/agent-session-index "Nested session nodes are always visible"; src/webview/vault/VaultPanel.ts (renderPreviewDetail run loop, renderRun CAP=5)
  - **Scope**: `src/webview/vault/VaultPanel.ts`, `src/webview/vault/VaultPanel.test.ts`
  - **Acceptance**:
    - Outcome: in the detail render loop a `subagentSession` item breaks the current run and renders directly (never sliced off behind "Show N more"); runs of ordinary steps on either side stay capped at 5. Discovered via live UI testing on a real 360-item leader where the Team node (timeline idx 17) was buried in a 31-item run behind "Show 26 more steps".
    - Verify: unit src/webview/vault/VaultPanel.test.ts
  - **Plan**:
    1. In `renderPreviewDetail`, add a `subagentSession` guard that appends the node directly, and a `subagentSession` break inside the run-accumulation inner loop.
    2. Test: a run of 6 tools + a `subagentSession` group + 6 tools → `.vault-preview-subagent-title` present in DOM, two independent "Show 1 more" caps remain.

- [x] 5_2 Cache-bust the webview bundle URL so reloads pick up the new render code
  - **Deps**: 5_1
  - **Refs**: design.md D11; src/providers/webviewHtml.ts (scriptUri)
  - **Scope**: `src/providers/webviewHtml.ts`, `src/providers/webviewHtml.test.ts`
  - **Acceptance**:
    - Outcome: the `webview.js` `<script>` src carries a `?v=<mtimeMs>` query so a reload never serves a stale cached bundle (the failure mode that hid D10 in the live extension: DevTools showed 0 rendered subagent titles against a bundle that renders 6). Composed in string space; statSync failure falls back to the nonce.
    - Verify: unit src/providers/webviewHtml.test.ts
  - **Plan**:
    1. statSync the resolved `media/webview.js` path; append `?v=<mtimeMs>` (or `&v=` if a query exists) to `String(asWebviewUri(...))`.
    2. Test getTerminalHtml emits `webview.js?v=…` with exactly one `?`.

## 6. Redesign — threaded, segmented teammate timeline

<!-- Supersedes the team-GROUP-node presentation. REUSED as-is: scanTeamMembers, teamName
     collection (3_1), top-level member exclusion (3_4), workflow nesting (section 2), the
     child-id module (1_1), the cache-buster (5_2). SUPERSEDED by this section: 3_2
     (listClaudeTeamStubs group), 3_3 (`:team:` group detail), and D8's team-group branch. -->

- [x] 6_1 Add the `:turn:` segment id + member-segment reader
  - **Deps**: 1_1
  - **Refs**: design.md D12; specs/agent-session-index/spec.md (Open a single teammate turn); src/vault/readers/claudeChildIds.ts; src/vault/readers/claudeReader.ts (resolveClaudeSessionPath, streamClaudeRecords, classifyClaudeStyleEvents)
  - **Scope**: `src/vault/readers/claudeChildIds.ts`, `src/vault/readers/claudeChildIds.test.ts`, `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `parseClaudeChildId` returns `{kind:"teamTurn", memberId, turn}` for `claude:<memberId>:turn:<n>` (n = `^\d+$`), `formatTeamTurnId` is the inverse; over-segmented/unsafe → null. `readClaudeTeamSegment(memberId, n)` locates `<memberId>.jsonl` (containment-checked), streams, slices `[boundary_n, boundary_{n+1})` by `<teammate-message>` user records, classifies with `includeSidechain` → `VaultSessionDetail`; out-of-range n / unsafe id → null. `readClaudeDetail` routes `:turn:` to it.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Add the `teamTurn` kind + `formatTeamTurnId` to claudeChildIds (validate n as a non-negative integer; reject extra colons).
    2. `readClaudeTeamSegment`: resolve member path; collect boundary indices (records whose user text matches `<teammate-message teammate_id="…">`); slice the n-th window; classify.
    3. Tests: id round-trip + rejection; fixture member → segment n contains exactly that turn's records; out-of-range/forged → null.

- [x] 6_2 Add `teammateTurn` timeline item + `buildTeamThread` (peer-aware)
  - **Deps**: 6_1, 3_1
  - **Refs**: design.md D13, D14; specs/agent-session-index/spec.md (Thread team-member turns into the leader timeline); src/vault/readers/claudeReader.ts (scanTeamMembers, readClaudeDetail leader path, boundTimeline)
  - **Scope**: `src/vault/types.ts`, `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`
  - **Acceptance**:
    - Outcome: `VaultTimelineItem` gains the `teammateTurn` variant (D13). `buildTeamThread(leaderPath, teamNames)` scans each member file for turn boundaries → `teammateTurn[]` with `from` (`leader`/peer), `color` (leader color-map + palette fallback), bounded `preview`, `timestamp`, `entryId = claude:<memberId>:turn:<idx>`. `readClaudeDetail` (leader) merges these by `timestamp` and DROPS the old team-group stub from the composition. Members stay excluded from the top-level list (unchanged). Peer messages (boundary `teammate_id` ≠ team-lead) appear with `from=<peer>`.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Add the `teammateTurn` variant to `src/vault/types.ts`.
    2. `buildTeamThread`: color map from the leader file's `<teammate-message teammate_id color>`; per member, stream and emit one item per boundary; return merged-by-timestamp.
    3. Rewire `readClaudeDetail` leader path to merge `buildTeamThread(...)` instead of `listClaudeTeamStubs`; keep workflow + flat-subagent composition.
    4. Tests: fixture leader + ≥2 members incl. a peer message → correct turn count, `from`, color, chronological order; member still absent from the list.

- [x] 6_3 Render `teammateTurn` + drop run cap to 3
  - **Deps**: 6_2
  - **Refs**: design.md D13, D10; specs/agent-session-index/spec.md (Nested and teammate nodes are always visible and visually distinct); src/webview/vault/VaultPanel.ts (renderTimelineItem, renderPreviewDetail run loop, renderRun, renderSubagentSession, populateNested); src/webview/vault/vaultPanel.css
  - **Scope**: `src/webview/vault/VaultPanel.ts`, `src/webview/vault/VaultPanel.test.ts`, `src/webview/vault/vaultPanel.css`
  - **Acceptance**:
    - Outcome: `renderTimelineItem` handles `teammateTurn` via a new `renderTeammateTurn` — a color-accented node (left bar/dot from `color`, a `from`-derived direction label, the bounded preview) that breaks the run and lazy-loads its segment on click via `entryId` (reuse `populateNested`). `renderRun` CAP is 3 (was 5). Highlight uses an explicit accent, NOT `--vscode-panel-border`.
    - Verify: unit src/webview/vault/VaultPanel.test.ts
  - **Plan**:
    1. Add `renderTeammateTurn` + a `teammateTurn` branch in `renderTimelineItem` and in the run-break guard (extends D10).
    2. CSS: a `.vault-preview-teammate` style with a visible color accent (driven by an inline `--turn-color` from the item `color`).
    3. CAP 5→3. Tests: teammateTurn renders preview + direction, visible mid-run of 4 tools; cap=3.

- [x] 6_4 Remove superseded team-group-node code
  - **Deps**: 6_3
  - **Refs**: design.md "Redesign decisions" (supersession); src/vault/readers/claudeReader.ts (listClaudeTeamStubs, readClaudeTeamDetail); src/vault/readers/claudeChildIds.ts (`:team:`)
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`, `src/vault/readers/claudeChildIds.ts`, `src/vault/readers/claudeChildIds.test.ts`, `src/webview/vault/VaultPanel.ts`
  - **Acceptance**:
    - Outcome: `listClaudeTeamStubs`, `readClaudeTeamDetail`, and the `:team:` id branch are removed (replaced by 6_1/6_2); their tests are deleted or repointed. The old `renderSubagentSession` path stays only for one-shot subagents and workflow groups. No dead `:team:` references; suite green.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Delete the team-group stub/detail functions + `:team:` parsing; remove their tests.
    2. Confirm `parseClaudeChildId` + readers no longer reference `:team:`; run the suite.

- [x] 6_5 Live verify in the Extension Dev Host
  - **Deps**: 6_3
  - **Refs**: REDESIGN-BRIEF.md (mockup); design.md D14
  - **Scope**: none (manual verification only)
  - **Acceptance**:
    - Outcome: on the real ARCO leader (`6eeef531-…`), the detail shows color-highlighted teammate turns (usdg/yield/aap/vault-router) threaded in place, each opening its one segment; runs cap at 3; nodes are visibly distinct (not theme-invisible). Clean relaunch (Shift+F5 → F5).
    - Verify: manual — open `6eeef531` in the dev host; confirm highlighted threaded turns + single-segment open + cap 3
    - **Done**: user-confirmed live. Field testing surfaced four follow-up fixes → Section 7.

## 7. Live-fix follow-ups (field testing on real `~/.claude` sessions)

Found by running the redesign in the dev host after R1–R3 approval. Each is RED→GREEN tested; full gate green (1827 unit tests).

- [x] 7_1 Inbound `<teammate-message>` renders as a `teammateMessage` node, not a raw "USER" bubble
  - **Refs**: design.md D16
  - **Scope**: `src/vault/types.ts`, `src/vault/readers/{detail,claudeReader}.ts`, `src/webview/vault/VaultPanel.ts`, `vaultPanel.css`; fixtures + tests
  - **Outcome**: new `teammateMessage` timeline variant; classifier emits it via an opt-in `parseTeammateTag` hook; clean body + `@sender` (name-only color), tag never shown.

- [x] 7_2 Revert the vault-CSS externalization (cache misdiagnosis); keep the real fixes
  - **Refs**: design.md D15
  - **Scope**: `src/providers/webviewHtml.ts`, `esbuild.js` (reverted to inline + 2-target); `vaultPanel.css` (`flex-shrink: 0`)
  - **Outcome**: vault CSS inline again; `webview.js` `?v=` cache-buster (D11) KEPT; flexbox zero-height collapse fixed with `flex-shrink: 0`.

- [x] 7_3 Rich, safe markdown rendering for transcript messages (line breaks, code, tables)
  - **Refs**: design.md D17
  - **Scope**: `src/vault/readers/detail.ts` (`truncateRich`) + codex/opencode readers; new `src/webview/vault/markdownLite.ts` + tests
  - **Outcome**: `truncateRich` preserves structure; `markdownLite` renders blocks via `textContent` only (no innerHTML); ReDoS-safe.

- [x] 7_4 Stop dropping prompts that mention command wrappers; hide content-less sessions
  - **Refs**: design.md D18
  - **Scope**: `src/vault/readers/detail.ts` (`cleanPromptText` `includes`→`startsWith`), `claudeReader.ts` (`hasContent` + list skip); fixtures + tests
  - **Outcome**: a prompt merely referencing `<command-message>` survives verbatim (the "no user message" bug); `/clear`-only sessions hidden from the list, still resolvable by id.

- [x] 7_5 Review triage (R4): clear stale `pendingNested` on collapse-mid-load; ellipsize the direction label
  - **Scope**: `src/webview/vault/VaultPanel.ts` (collapse branches), `vaultPanel.css` (`.vault-preview-teammate-dir`); test
  - **Outcome**: collapsing a node mid-load drops its in-flight request so a late response can't populate the hidden body; long peer names ellipsize.
