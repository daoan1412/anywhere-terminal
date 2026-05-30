## ADDED Requirements

### Requirement: Surface workflow sub-agents

The system SHALL discover `/workflow` runs for a Claude session and surface each run as ONE nested group child in that session's detail timeline. Workflow run manifests live at `<projects>/<dir>/<parentId>/workflows/<wfId>.json` and the per-agent transcripts at `<projects>/<dir>/<parentId>/subagents/workflows/<wfId>/agent-*.jsonl` (each `isSidechain:true`). The group node's label SHALL come from the manifest (`workflowName`, `agentCount`, `status`) — NOT from the agents' `.meta.json`, which carries only `{agentType:"workflow-subagent"}`. Expanding the group SHALL list its agents (label = each agent's first prompt, bounded), and expanding an agent SHALL lazy-load that agent's transcript. Because the parent's `Workflow` tool call carries no run id, group placement SHALL use the manifest's start time. A workflow agent is one-shot (no back-and-forth) and SHALL render as a single node, not segmented.

The entry-id contract for workflow children is: group `claude:<parentId>:workflow:<wfId>`, agent leaf `claude:<parentId>:wfagent:<wfId>:<stem>`. `<wfId>` SHALL match `wf_[A-Za-z0-9_-]+` and `<stem>` SHALL match `agent-[A-Za-z0-9]+`; the resolved transcript path SHALL be containment-checked under the Claude projects root (traversal rejected), never trusting any webview-supplied path.

### Requirement: Thread team-member turns into the leader timeline

A Claude session file whose first record carries BOTH a non-empty `agentName` and a non-empty `teamName` SHALL be treated as a non-lead team member (the exclusion predicate MUST match the grouping predicate, so an `agentName`-only session is never hidden). The system SHALL EXCLUDE non-lead members from the aggregated top-level session list — without counting them toward the unreadable tally (a skip is not a parse failure). The leader is the session that records that `teamName`; because the team episode may sit anywhere in a large transcript, the leader's `teamName`s SHALL be collected across the FULL streamed transcript (not only the bounded head+tail window). The live team config at `~/.claude/teams/<teamName>/config.json` MUST NOT be relied upon for linkage (it is deleted on teardown); the durable in-file `teamName`/`agentName` fields are the source of truth.

Instead of one collapsed group node, the system SHALL surface each member as a sequence of per-turn nodes threaded into the leader's detail timeline. A member's transcript is a sequence of turns; each turn begins at a `user` record whose text is `<teammate-message teammate_id="X">` (the incoming message) and runs until the next such record (or end of file). For each turn the system SHALL emit one `teammateTurn` timeline item carrying: the member's `agentName`, a `color` (from the leader file's `<teammate-message teammate_id color>` record for that member, else a fixed palette by index), the sender `from` (`"leader"` when `X` is `team-lead`, otherwise the peer member name), a bounded message preview, a `timestamp`, and the segment entry-id. Turns SHALL be merged into the leader's timeline by `timestamp`. Member-to-member (peer) messages SHALL be included, discovered by scanning each member file (a turn boundary whose `teammate_id` is not `team-lead` is a peer message); each message is recorded once in its recipient's file, so no turn is double-counted. Team-member discovery SHALL be scoped to the leader's own project directory and skipped entirely when the leader records no `teamName`.

#### Scenario: A teammate is threaded, not listed top-level

- **WHEN** a session file's first record has both an `agentName` and a `teamName` (a non-lead team member)
- **THEN** it does not appear in the top-level list (and is not counted unreadable), and each of its communication turns appears as a color-highlighted `teammateTurn` node — labelled with the member name and sender (leader or peer) — interleaved by time in the detail of the leader that recorded the same `teamName`

### Requirement: Open a single teammate turn

The system SHALL resolve a view-only segment id `claude:<memberId>:turn:<n>` to a detail containing ONLY the records of the n-th turn of that member's transcript (from the n-th incoming `<teammate-message>` boundary up to the next boundary, or end of file) — i.e. from receiving the request through the member's response. `<memberId>` SHALL satisfy the existing session-id safety check and `<n>` SHALL be a non-negative integer; the member transcript SHALL be located under the Claude projects root with the existing containment check, never trusting a webview-supplied path or record range. An out-of-range `<n>` or unsafe id SHALL resolve to null. The id is view-only (it contains `:` and therefore is rejected by the launch entry resolver); the member session itself remains independently launchable by its plain `claude:<memberId>`.

### Requirement: Nested and teammate nodes are always visible and visually distinct

When the detail view renders a session's timeline, a nested node — a one-shot subagent, a workflow group, or a `teammateTurn` — SHALL be rendered directly and SHALL NOT be hidden behind the per-run "Show N more steps" step-collapse, regardless of how many ordinary steps surround it (it breaks the run). Runs of ordinary assistant/thinking/tool steps MAY remain capped, at no more than THREE items before "Show N more". A `teammateTurn` node SHALL be visually distinct from ordinary transcript steps using an explicit accent (a colored bar/dot keyed to the member `color`) and MUST NOT rely on a subtle theme border that can resolve to near-invisible under a real color theme.

#### Scenario: A teammate turn deep in a long run is still visible and highlighted

- **WHEN** a `teammateTurn` node sits among more than three non-user timeline items (e.g. between many tool steps with no intervening user message)
- **THEN** it renders directly with its color accent and message preview, while the ordinary steps on either side stay independently capped at three behind "Show N more"
