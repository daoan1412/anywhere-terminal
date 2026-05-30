# Design: nest-workflow-team-sessions

## Decisions

### D1: A "group" is a `subagentSession`, not a new timeline kind — webview unchanged

`VaultPanel.renderSubagentSession` already renders a collapsible block that lazily fetches a child's detail on expand, and `renderNestedInto` → `renderTimelineItem` renders nested `subagentSession`s **recursively**. So a workflow run / team is modelled as a `subagentSession` whose `getDetail` returns a `timeline` of child `subagentSession`s. The entire change is host-side (reader + entryId resolution); no webview, message, or `VaultTimelineItem` schema change.

Rejected: a first-class `agentGroup` item with bespoke inline children — duplicates the lazy-load/expand/stale-guard machinery for no behavioral gain and widens the IPC surface.

**Amendment (live-UI discovery, see D10):** "webview unchanged" held for the *data path* (reader, IPC, schema) but NOT for the *render loop*. Live testing on a real 360-item leader transcript revealed the detail render groups all non-user items into "runs" capped at 5 (`renderRun`), and `subagentSession` nodes were swept into those runs — so a group node deep in a long run (e.g. a Team node at timeline index 17 inside a 31-item run) was hidden behind "Show 26 more steps". One surgical webview change (D10) was required for the feature to be visible at all. The IPC/schema surface remains unchanged.

**Parent stats semantic:** a group counts as ONE nested node in the parent's `stats.subagentCount` (via the existing `Math.max(spawnCalls, totalStubs)`), NOT as its N descendant agents — the descendant count lives in the group node's own label (`· N agents`). This is intentional and documented so the builder doesn't try to inflate the parent count.

### D2: New child entryId markers, parsed inside `readClaudeDetail`

`parseEntryId` splits on the FIRST colon, so everything after `claude:` is the `sessionId`. A dedicated module `src/vault/readers/claudeChildIds.ts` owns format/parse/validate for all child ids so the protocol has one home and is unit-testable:

```ts
// agent leaf (existing, folded in):  claude:<parentId>:subagent:<stem>
// workflow group:                    claude:<parentId>:workflow:<wfId>
// workflow agent leaf:               claude:<parentId>:wfagent:<wfId>:<stem>
// team group:                        claude:<parentId>:team:<urlencoded-teamName>
// team member leaf:                  claude:<memberSessionId>            (a normal full session)

type ClaudeChildId =
  | { kind: "subagent"; parentId: string; stem: string }
  | { kind: "workflow"; parentId: string; wfId: string }
  | { kind: "wfagent"; parentId: string; wfId: string; stem: string }
  | { kind: "team"; parentId: string; teamName: string };

function parseClaudeChildId(sessionId: string): ClaudeChildId | null; // null → plain session id
function formatWorkflowId(parentId, wfId): string;                    // etc.
```

Validators: `parentId`/`stem` via the existing `isSafeSessionId`; `wfId` matches `^wf_[A-Za-z0-9_-]+$`; `<stem>` matches `^agent-[A-Za-z0-9]+$`; `teamName` round-trips through `encodeURIComponent`/`decodeURIComponent`. `readClaudeDetail` checks markers in order (`:wfagent:`, `:workflow:`, `:team:`, `:subagent:`) and routes; anything else is a plain session.

### D3: Workflow discovery + resolution (self-contained under the parent dir)

- **Group stubs (parent detail):** `listClaudeWorkflowStubs(parentId)` reads `<parentId>/workflows/wf_*.json`. Per manifest → one `ClaudeChildStub` with `entryId = workflow:<wfId>`, `description = "Workflow: <workflowName> · <agentCount> agents · <status>"`, `timestamp = manifest.startTime`, `firstMessage = manifest.summary`. ENOENT on the `workflows/` dir → `[]` (the common, no-workflow case is one cheap `readdir`).
- **Group detail (`:workflow:`):** read the manifest + `readdir <parentId>/subagents/workflows/<wfId>/`; return a synthetic `VaultSessionDetail` whose `timeline` is one `subagentSession` per `agent-*.jsonl` (`entryId = wfagent:<wfId>:<stem>`, `title` = the agent's first prompt (bounded) else the stem, `agent = "workflow-subagent"`). `firstPrompt = manifest.summary`; `stats.subagentCount = agentCount`. Children ordered by manifest order when derivable, else filename.
- **Agent leaf (`:wfagent:`):** resolve `<parentId>/subagents/workflows/<wfId>/<stem>.jsonl` (containment-checked), stream, `classifyClaudeStyleEvents(records, { includeSidechain: true, limit })` — these records ARE the sidechain. Reuses the existing subagent-leaf path.

Placement: workflow group stubs are merged into the parent timeline by `timestamp` via the existing `mergeUnmatchedStubs` ordering (they won't match an `Agent`/`Task` spawn call). The parent's plain `Workflow` tool step remains as a cosmetic sibling (Risk Map limitation).

**Timestamp parsing:** the manifest `startTime` is a numeric epoch-ms STRING (e.g. `"1780072409110"`), not ISO. `mergeUnmatchedStubs` orders only finite numbers, so the stub `timestamp` MUST be coerced: `Number(startTime)` when finite, else `Date.parse(manifest.timestamp)` (the ISO field) as a fallback, else `undefined` (append-at-end). Apply the same coercion to team-member timestamps.

### D4: Team discovery + resolution (leader self-identifies teamNames)

- **Parent teamNames:** collected during the parent's streaming pass via a side-channel callback (`onRecord`) added to `streamClaudeRecords`, so a `teamName` in the dropped middle of a large transcript is still captured (the bounded buffer only drops retained record *content*, not the streaming pass).
- **Member discovery:** only when `parentTeamNames.size > 0`. `readdir` the parent's project dir; for each OTHER `<uuid>.jsonl`, read its first record; if it has a non-empty `agentName` and its `teamName ∈ parentTeamNames`, it is a member → leaf stub (`entryId = claude:<uuid>`, `title = "@" + agentName`, `firstMessage` = its first user text, `timestamp`).
- **Group stubs (parent detail):** members grouped by `teamName` → one `ClaudeChildStub` per team (`entryId = team:<urlencoded-teamName>`, `description = "Team: <teamName> · <N> members"`, `timestamp` = earliest member). Merged into the timeline by timestamp.
- **Group detail (`:team:`):** resolve `parentId`'s project dir, re-scan siblings whose first record has `agentName` and `teamName == decoded(key)`; return a synthetic detail whose `timeline` is one `subagentSession` per member (`entryId = claude:<memberSessionId>`). No parent re-stream needed — the teamName comes from the id.

### D5: Top-level list excludes non-lead team members

`parseClaudeFile` captures `isTeamMember` — true when the first record carries BOTH a non-empty `agentName` and a non-empty `teamName` (the SAME predicate as grouping in D4, so an `agentName`-only session is never hidden). `readClaudeSessions` skips members EXPLICITLY: the skip is a distinct outcome from "unparseable", so a skipped member is neither pushed to `entries` NOR counted in `unreadable`. Do NOT implement the skip by returning `null` from `buildClaudeEntry` — the current `buildClaudeEntry → null` path increments `unreadable` (claudeReader.ts ~552). Instead detect membership in `readClaudeSessions` (or have `buildClaudeEntry` return a discriminated `{ skip: "team-member" } | entry | null`) and `continue` without counting. The leader (no first-record `agentName`/`teamName`) stays a normal entry. Members remain reachable via their leader's Team group (D4). Accepted edge: a member whose leader file was deleted is unreachable (Risk Map).

### D8: Group nodes render title-only (no `@agent` prefix)

A real subagent renders as `@<agent> · <title>` (VaultPanel.ts ~1572), and `mergeUnmatchedStubs`/`stubToItem` (detail.ts) default a missing `agentType` to `"subagent"` — so a naive group stub would render `@subagent · Workflow: …`. To render group nodes as just their label, `ClaudeChildStub` gains an optional `isGroup?: boolean`; `stubToItem` omits the `agent` field (and `mergeUnmatchedStubs` skips the `"subagent"` default) when `isGroup` is set. This is a localized host change in `detail.ts` — the webview render rule (`item.agent ? … : title`) is unchanged; the synthesized item simply carries no `agent`. Real subagents (with `agentType` from `.meta.json`) are unaffected.

**Group detail is bounded but NON-pageable (review N2):** `synthesizeGroupDetail` caps its timeline at `MAX_TIMELINE_ITEMS` (400) for payload safety, but a group node is rendered through the webview's nested path which has no load-more — so groups are intentionally non-pageable. The cap is far above any realistic group (workflow ~30, team a handful), so it never truncates in practice, and the group NODE label always carries the TRUE total (`· N agents` / `· N members`), so even a pathological >cap group surfaces its real count rather than hiding it silently. Nested load-more is deliberately out of scope (would require a webview change, violating D1).

### D9: Team-group detail validates parent ownership (review N1)

`readClaudeTeamDetail` resolves a `claude:<parentId>:team:<team>` id; before scanning siblings it streams the parent and returns null unless the parent is a LEADER that recorded that `teamName` (`!selfIsMember && teamNames.has(teamName)`, via the shared `teamContextCollector`). Without this, a forged/stale id (`claude:<unrelated-or-member>:team:<knownTeam>`) could synthesize a team group under a parent that never led it — the host must not trust a webview-supplied id beyond path containment. Team groups stay leader-only.

### D10: Nested session nodes are first-class in the detail render — never behind the step cap (live-UI fix)

`renderPreviewDetail` groups every non-user timeline item between two user messages into a "run" capped at 5 items (`renderRun`, CAP=5) behind a "Show N more steps" expand. A `subagentSession` is not a user message, so before this fix it was swept into the run and could be sliced off — a group node (workflow/team) buried mid-run never entered the DOM, making the entire nesting feature invisible on real long transcripts (verified: a Team node at index 17 of a 31-item run was hidden behind "Show 26 more steps" in the running extension).

Fix (surgical, in the render loop only): a `subagentSession` item BREAKS the current run and renders directly via `renderTimelineItem`, then the loop resumes. Runs of ordinary assistant/thinking/tool steps on either side stay independently capped. Nested sub-sessions (subagents, workflow groups, team groups — and their recursive children) are therefore always visible regardless of position. This also fixes the pre-existing redesign-vault-panel-ui subagent nodes, which had the same latent burial.

Rejected: counting only non-`subagentSession` items toward the cap inside `renderRun` (keeps the node but entangles two concerns); inserting synthetic user-message boundaries host-side (abuses the schema). Breaking the run is the minimal, local change.

### D11: Cache-bust the webview bundle URL (live-UI fix, follow-on to D10)

Debugging D10 on the live extension surfaced a second, independent gap: the webview `<script>` src is `webview.asWebviewUri(media/webview.js)` with NO version query, so a webview caches the bundle by URL. After a rebuild, a plain "Reload Window" reloaded the extension host (new reader/data) but kept serving the STALE `webview.js` — so the render logic (D10) and the host data went out of sync, and the new nodes never rendered. Confirmed empirically: webview DevTools `document.querySelectorAll('.vault-preview-subagent-title').length === 0` while the current bundle renders 6.

Fix (`webviewHtml.ts`): append `?v=<mtimeMs>` to the script URL, keyed to the bundle's modification time — fresh fetch whenever the bundle changes, cached when unchanged. Composed in STRING space (`String(asWebviewUri(...)) + "?v=…"`, with `&` if a query already exists), NOT `Uri.with({query})`, because (a) the only use is `src="…"` interpolation and (b) it stays decoupled from the Uri shape (the test/host mock returns a bare fsPath string with no `.with`). statSync failure → fall back to the per-render nonce (always-fresh rather than risk staleness).

This is host-side only and orthogonal to the data path; it exists so iterative webview development (and end users after an update) reliably pick up the new bundle.

### D6: Security — resolve-by-id, containment-checked, no trusted paths

Every new child transcript is located by id under the Claude projects root with the existing `path.relative` containment check (rejects `..`/absolute escapes), exactly like `resolveClaudeSubagentPath`. `wfId`/`stem`/`parentId` are validated against fixed patterns before any path join; `teamName` is `encodeURIComponent`-bounded. Group/leaf ids contain `:` → `isSafeSessionId` rejects them in `getEntry`, so they are inherently view-only (no resume/fork). SVG/icons and `textContent`-only rendering are unchanged (webview untouched).

### D7: Per-open cost is gated

Common no-child case adds: one `readdir(<parentId>/workflows)` (ENOENT-fast) + the team sibling scan ONLY when the parent recorded a `teamName`. When workflow manifests ARE present, the parent open reads+parses each one (≤~250 KB) to build the group-stub label (`workflowName`/`agentCount`/`status`/`summary`) and placement (`startTime`); group-detail open re-reads/parses the manifest to synthesize the child list. Each parse is wrapped in try/catch → a malformed manifest contributes `[]` (defensive parse, existing D8 posture). The cost is bounded (a handful of manifests per session) and absent entirely for the overwhelmingly common no-workflow case.

## Redesign decisions (threaded teammate timeline — supersedes the team-group-node presentation)

The first cut surfaced each team as ONE collapsed `Team: <name> · N members` group node (D4) rendered title-only (D8). Live testing rejected it: the node rendered invisibly (theme CSS vars resolved its border/background to near-nothing) and, even fixed, a single collapsed box buried in a 360-item transcript is poor UX. The DATA layer — member discovery by `teamName`, top-level exclusion (D5), and `teamName` collection across the full stream (D4) — is RETAINED. The PRESENTATION is replaced by a threaded, segmented, color-highlighted timeline. Net effect on prior decisions: **D4's team-group node is replaced** by per-turn `teammateTurn` nodes (workflow groups under D3 are unchanged); **D8 now scopes to workflow groups only**; **D10's run-break extends to `teammateTurn`** and the run cap drops 5→3; **D11 (cache-buster) is kept**; D1's "webview unchanged" no longer holds (the webview gains a new render path).

### D12: Teammate-turn segment id — `claude:<memberId>:turn:<n>` (index-based, view-only)

Opening one teammate turn needs a stable id for "the work between incoming message n and n+1". Use an **index**: `n` = the 0-based ordinal of the turn boundary (a `user` record whose text is `<teammate-message teammate_id="…">`) within the member's file. Claude session files are append-only, so the n-th boundary stays the n-th across reads — index is stable without encoding volatile timestamps into the id. Resolution (host): validate `memberId` (existing safe-id) and `n` (`^\d+$`); locate `<memberId>.jsonl` under the projects root with the existing `path.relative` containment check; stream; slice records `[boundary_n, boundary_{n+1})` (or `[boundary_n, EOF)`); classify with `includeSidechain` (the member's own records). Out-of-range `n` → null (graceful). View-only — the id contains `:` so `getEntry`/`isSafeSessionId` reject it (no resume/fork); the member session stays launchable via its plain `claude:<memberId>`.
Rejected: timestamp-range ids (fragile, verbose, timestamps-as-keys); a webview-supplied record range (never trust the webview — D6).

### D13: `teammateTurn` is a NEW VaultTimelineItem variant (not an overloaded subagentSession)

A teammate turn carries data a one-shot subagent node does not — `agentName`, `color`, `from` (leader or a peer), a message preview, a segment `entryId` — and gets a distinct highlighted render. Add a new variant rather than overload `subagentSession`:

```ts
| { kind: "teammateTurn"; entryId: string; agentName: string; color?: string;
    from: string; /* "leader" | "<peerName>" */ preview: string; timestamp: number }
```

`subagentSession` is retained UNCHANGED for one-shot subagents and workflow groups/agents (single node, no direction/color). Structured-clone-safe (plain object) across `postMessage`. The webview renders `teammateTurn` via a new `renderTeammateTurn` (colored left-bar + dot from `color`, a `from`-derived direction label, the preview; click → lazy-fetch the segment detail by `entryId`, reusing the existing nested expand / stale-guard machinery).
Rejected: extending `subagentSession` with optional team fields — muddies both the one-shot and conversational cases and the render branch.

### D14: Peer-aware team thread built by scanning each member file (merge by timestamp)

`readClaudeDetail` for a leader builds `teammateTurn[]` via a new `buildTeamThread(leaderPath, teamNames, opts)`:
1. Discover members with the existing `scanTeamMembers` (scoped to the leader's project dir).
2. Build a `member → color` map from the leader file's `<teammate-message teammate_id color>` records; members without a leader-side record fall back to a fixed palette by index.
3. Stream each member file once; at every turn boundary (a `user` record matching `<teammate-message teammate_id="X">`) emit a `teammateTurn` { agentName=member, from = X==="team-lead" ? "leader" : X (a PEER), color, preview=bounded boundary text, timestamp, entryId = formatTeamTurnId(member, idx) }.
4. Merge the turns into the leader's classified timeline by `timestamp`, then `boundTimeline`.

Peer DMs need no extra source: a boundary whose `teammate_id` ≠ `team-lead` is a peer message, so scanning each member file yields leader↔member AND member↔member turns. Each message is recorded once (in its recipient's file) → no double-count. Bounded: members are few; each file is streamed once retaining only per-boundary metadata (not full content). The old `listClaudeTeamStubs` (single group stub) and `readClaudeTeamDetail` (`:team:` group detail) are removed.

## Live-fix decisions (post-redesign field testing in the Extension Dev Host)

These came out of running the redesign against real `~/.claude` sessions, after the formal review approved R1–R3.

### D15: vault panel CSS stays INLINE — externalization REVERTED (cache theory was a misdiagnosis)

A "teammate node renders invisible" report was first (HIGH-confidence) diagnosed as **stale CSS delivery**: the theory that inline `<style>${VAULT_CSS}</style>` is "frozen" in the extension-host process, so I externalized vaultPanel.css to a cache-busted `<link>` + a 3rd esbuild target. **This was wrong and is reverted.** Inline CSS is regenerated on *every* `getTerminalHtml` call and refreshes whenever the host reloads new `dist` (which any code change requires) — it is not frozen, and is in fact *more* staleness-proof than an external file (it can never be cached separately). The real causes were two unrelated things: (1) a stale **installed** extension serving old `dist` (fixed by uninstalling it), and (2) a genuine CSS bug — an `overflow: hidden` flex item collapsing to `min-height: auto → 0` height inside the `flex-direction: column` `.vault-preview-body` (the node rendered as a bare colored line). Fix: `flex-shrink: 0` on `.vault-preview-teammate` / `.vault-preview-subagent`. **D11 (the `webview.js` `?v=` cache-buster) is KEPT** — it fixed a *real, observed* stale-JS failure (DevTools showed 0 rendered nodes against a bundle that renders them); only the vault-CSS externalization was the misdiagnosis. Lesson: rule out the dev environment (a stale installed build) before theorizing about build/cache architecture; layout bugs are CSS, not delivery.

### D16: inbound `<teammate-message>` records render as a distinct `teammateMessage` item (not a raw "USER" bubble)

A leader transcript stores each delivered teammate reply as a plain `user` record wrapping `<teammate-message teammate_id="X" color summary>BODY</teammate-message>`, so it rendered as a raw, mislabeled "USER" bubble showing the literal tag. Add a NEW `teammateMessage` timeline variant `{ kind, agentName, color?, from, text, timestamp? }` (view-only — no `entryId`, never launchable). `classifyClaudeStyleEvents` emits it via an **opt-in parser hook** (`opts.teammateMessage`, injected by the Claude reader which owns `parseTeammateTag`) so the generic classifier stays decoupled from the team concept. The webview renders it inline (full bounded body, not collapsible) — distinct from the collapsible `teammateTurn` node. Per field feedback the BLOCK keeps the session's default agent accent (`--vault-user-accent`) and only the SENDER NAME is tinted with `--turn-color` — tinting the whole bubble made inbound chats hard to tell apart from the fully color-keyed turn nodes. `cleanPromptText` also unwraps the tag so member titles read as the instruction, not markup.

### D17: full-transcript messages render as safe markdown-lite (line breaks, code, tables)

Messages were collapsed to one line by `truncate()` (it folds all whitespace), so prose, code, and tables were unreadable. Two layers: (1) a newline-preserving `truncateRich()` in the readers (Claude/Codex/OpenCode message + thinking bodies) keeps line breaks, code indentation, and table alignment within the `MAX_MESSAGE_TEXT` bound; (2) a new `src/webview/vault/markdownLite.ts` renders fenced code → `<pre><code>`, pipe tables → `<table>`, ATX headings, lists, and inline `` `code` ``/`**bold**`. **Security:** every character reaches the DOM via `textContent`/`createTextNode` only — NEVER innerHTML — so the panel's textContent-only rule holds and there is no injection surface (a markdown→HTML lib + sanitizer would have been the wrong tool). All regexes are linear (ReDoS-safe).

### D18: hide content-less sessions from the list; anchor command-wrapper detection with `startsWith`

Two list/detail correctness fixes surfaced on real data. (a) `cleanPromptText` used `t.includes("<command-message>")` to detect slash-command wrappers — a substring check that **silently dropped any human prompt merely mentioning** `<command-message>`/`<command-name>` (a meta-prompt about Claude commands, a pasted transcript). A real command record *is* the wrapper, so detection is anchored with `startsWith`; a prompt that only references it survives verbatim. This was the cause of "no user message shows" in the detail. (b) A session with no real content — no human prompt that survives `cleanPromptText` AND no assistant turn (e.g. a transcript holding only a `/clear` + caveat banner) — is junk; `parseClaudeFile` now reports `hasContent = haveUser || haveAssistant` and the LIST path hides `!hasContent` sessions (same pattern as team-member exclusion). Single-entry resolve still returns them (a real, launchable session), so nothing becomes unreachable.

## Interfaces

```ts
// src/vault/readers/detail.ts
// ClaudeChildStub gains one optional field; group stubs set isGroup so stubToItem
// omits the `agent` prefix (D8).
interface ClaudeChildStub { /* …existing… */ isGroup?: boolean }
// New shared helper to assemble a synthetic group detail from child subagentSession items:
function synthesizeGroupDetail(
  entryId: string,
  children: ClaudeChildStub[],     // each → a subagentSession timeline item
  opts: { firstPrompt?: string; subagentCount: number },
): VaultSessionDetail;

// src/vault/readers/claudeReader.ts
async function listClaudeWorkflowStubs(parentId: string, opts): Promise<ClaudeChildStub[]>; // isGroup:true
async function listClaudeTeamStubs(parentId: string, parentTeamNames: Set<string>, opts): Promise<ClaudeChildStub[]>; // isGroup:true
async function resolveClaudeWorkflowAgentPath(parentId, wfId, stem, opts): Promise<string | null>; // containment-checked
// readClaudeDetail composes: flat subagents ∪ workflow groups ∪ team groups → childStubs.

// streamClaudeRecords gains an optional per-record hook used to collect teamNames
// without retaining records:
function streamClaudeRecords(filePath, opts?: { onRecord?: (rec: Record<string, unknown>) => void }): …

// ── Redesign (D12–D14) ──────────────────────────────────────────────────────
// src/vault/readers/claudeChildIds.ts — new segment kind
//   claude:<memberId>:turn:<n>  → { kind: "teamTurn"; memberId: string; turn: number }   (D12)
function formatTeamTurnId(memberId: string, turn: number): string;

// src/vault/types.ts — new timeline variant (D13)
//   | { kind: "teammateTurn"; entryId; agentName; color?; from; preview; timestamp }

// src/vault/readers/claudeReader.ts
async function buildTeamThread(leaderPath: string, teamNames: Set<string>, opts): Promise<VaultTimelineItem[]>; // D14 — teammateTurn[]
async function readClaudeTeamSegment(memberId: string, turn: number, opts, limit?): Promise<VaultSessionDetail | null>; // D12 slice
// readClaudeDetail (leader path): merges buildTeamThread(...) into the timeline by timestamp;
// the old team-group stub composition is removed. `:turn:` routes to readClaudeTeamSegment.

// src/webview/vault/VaultPanel.ts
function renderTeammateTurn(item): HTMLElement;   // colored accent + from-label + preview; click → lazy segment detail
// renderRun CAP 5 → 3; teammateTurn breaks runs (extends D10).
```

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| Leader teamName in dropped transcript middle | Teammates ungrouped in detail | `streamClaudeRecords` `onRecord` side-collector captures `teamName` during the streaming pass, before head+tail bounding (D4) |
| Top-level list exclusion (D5) | Member with a deleted leader becomes unreachable | Accepted + documented; rare; future "Teams" view is out of scope. Exclusion keyed on first-record `agentName` only (no false-positive on leaders, which lack it) |
| New entryId resolution | Path traversal via crafted id | Validate `wfId`/`stem`/`parentId` against fixed patterns; `path.relative` containment check under projects root, mirroring `resolveClaudeSubagentPath` (D6) |
| Manifest parsing | Cost / malformed JSON on every detail open | Lazy at group-detail open; parse wrapped in try/catch → run contributes `[]` (defensive parse, existing D8 posture) |
| Recursive nesting in webview | User expands a deep/cyclic chain | Expansion is lazy and user-driven (one fetch per click); synthetic ids never self-reference; no auto-recursion |
| Redundant plain `Workflow`/named-spawn step | Cosmetic duplicate next to the group | Documented limitation; group node is the useful artifact; suppression deferred |
| Teammate-turn segment id (D12) | Member file rewritten/truncated → stale index | `n` resolved by counting boundaries at read time; out-of-range → null (graceful); files are append-only in practice |
| Scanning every member file on leader open (D14) | Cost on a large team | Bounded: members are few; one stream per member retaining only per-boundary metadata (timestamp/from/preview), reusing `scanTeamMembers` project-dir scoping |
| New `teammateTurn` IPC item (D13) | Schema drift / unhandled kind | Plain structured-clone-safe object; webview render is gated on `kind`; one-shot agents keep `subagentSession` (no behavioral change there) |
| Highlight via theme border | Repeat of the first design's invisibility | Explicit color accent (member `color` / palette), NOT `--vscode-panel-border`; mandatory live dev-host check (task 6_5) since jsdom misses paint |
