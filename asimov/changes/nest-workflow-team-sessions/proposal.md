# Proposal: nest-workflow-team-sessions

## Why

The AI Vault reader only understood one of Claude Code's three child-session mechanisms (flat `subagents/`). `/workflow` runs (their 20–30 agents) were invisible in a session's detail, and named team-member sessions cluttered the top-level list as separate cryptic `<teammate-message …>` rows.

The host **data layer** that discovers workflow + team child sessions was built and verified. The **first presentation** (each team folded into one collapsed `Team: <name> · N members` node nested in the leader's transcript) was rejected after live testing: it rendered invisibly under real themes, and even fixed, a single buried collapsed box is poor UX. This revision keeps the data layer and **redesigns the presentation** into a **threaded, segmented, color-highlighted teammate timeline**: each teammate/agent interaction is a prominent click-to-open node interleaved in the leader's timeline, and a conversational teammate is split into one node per communication turn (it recurs at each message it sends/receives), rather than one box. See `REDESIGN-BRIEF.md` (authoritative design + real-data mockup + verified segmentation).

## Appetite

M (≤3d)

## Scope

### In scope
- Discover workflow runs (manifest + `subagents/workflows/<wfId>/`) and surface each as ONE collapsed group node in the parent's detail timeline; per-agent transcripts lazy-loaded. **[done — retained]**
- Discover team-member sibling sessions (by in-file `teamName`/`agentName`) and EXCLUDE non-lead members from the top-level list. **[done — retained]**
- **Thread team members into the leader's timeline as per-turn `teammateTurn` nodes** — color-highlighted (from the record `color`), labelled by sender (leader / peer), showing the message preview; placed by timestamp. A teammate recurs once per turn.
- **Open a single teammate turn** — a new view-only segment id `claude:<memberId>:turn:<n>` resolves just that turn (incoming request → work → response), host-resolved + containment-checked.
- **Peer-to-peer DMs** (teammate↔teammate) included, by scanning each member file for turn boundaries and merging by timestamp.
- New `teammateTurn` `VaultTimelineItem` variant; webview `renderTeammateTurn`; leader tool/reasoning run cap 5→3.
- Keep the webview-bundle cache-buster (`?v=<mtime>`).

### Out of scope
- Codex / OpenCode (no team/workflow concept).
- A dedicated top-level "Teams" browser, or making orphaned members (leader file deleted) reachable.
- Precise per-agent phase mapping from `workflowProgress` (best-effort label only).
- Resuming/forking a workflow agent, a group node, or a teammate-turn segment (all view-only; the teammate session itself stays launchable by its plain id).

## Capabilities

1. **agent-session-index** — discover workflow + team child sessions; exclude non-lead members from the aggregated list; thread team members as per-turn nodes; resolve the workflow/team-turn child ids.
2. **vault-session-launch** — lock the contract that synthetic child/group/turn ids are view-only and never launchable.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — workflow runs become visible (nested); team members leave the top-level list and appear as color-highlighted per-turn nodes threaded into their leader's timeline.
- **E2E required?** NOT REQUIRED.
- **Justification**: Project defines no E2E (`asimov/project.md` § Commands → E2E: N/A). Host reader logic is covered by Vitest fixtures; the new webview render path is covered by jsdom unit tests AND a mandatory live Extension-Dev-Host check (task 6_5) — jsdom misses CSS/paint, which is exactly how the first presentation's invisibility slipped through.

## Risk Level

MEDIUM — cross-file discovery (scanning member files), a new segment-id resolution under a security-sensitive store root, and a new IPC timeline-item variant; mitigated by reusing the existing containment-checked resolver pattern, append-only-stable turn indices, in-file (not config) linkage, and a structured-clone-safe plain item.
