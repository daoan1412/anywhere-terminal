---
topic: claude-code-nested-subagents
created-by: research for VS Code session-transcript viewer scope on Claude Code nested subagent support
date: 2026-06-20
libraries: [claude-code]
used-by: []
---

# Research: claude-code-nested-subagents

## Answers
- Claude Code now supports nested subagents: as of Claude Code v2.1.172, “a subagent can spawn its own subagents.” The docs describe this as a fixed feature, not an experimental one. Source: [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents).
- Nesting is capped at 5 levels below the main conversation. The docs say the limit is fixed and not configurable; a depth-5 subagent cannot receive the Agent tool and cannot spawn further. Source: [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents).
- Official docs do not document a new transcript schema for nested subagents. The strongest evidence available still points to the existing sidechain model: community parsers and a Claude Code issue show subagent transcripts as JSONL entries with `isSidechain: true` and `parentUuid` chaining. However, Anthropic does not publish the on-disk JSONL schema as a stable contract, so nested-depth storage semantics are not officially guaranteed. Sources: [Claude Code issue #17591](https://github.com/anthropics/claude-code/issues/17591), [Claude Code issue #24471](https://github.com/anthropics/claude-code/issues/24471), [claude-code-ui spec](https://github.com/KyleAMathews/claude-code-ui/blob/main/spec.md).
- UI guidance is explicit: render nested subagents as a tree in the subagent panel. The docs say the panel below the prompt shows the “full tree,” with each row displaying a descendant count and expandable children; the `/agents` Running tab is flat. Source: [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents).

## Recommended Approach
- Treat nested subagents as supported and cap-aware: render as a tree, but hard-stop traversal/expansion at depth 5 in any viewer logic that mirrors runtime behavior.
- Prefer `parentUuid` + `isSidechain` as the best available reconstruction mechanism for session viewers, but keep the parser tolerant of malformed or missing links.
- Show a tree view by default, with an optional flat “running subagents” list for parity with `/agents`.

## Core Findings
- `min-version: 2.1.172` is attached to the nested-subagent section in the docs.
- The docs explicitly distinguish:
  - nested subagent tree in the prompt-area panel
  - flat running list in `/agents`
- Depth is counted from the main conversation, not per branch.
- To prevent spawning, the docs instruct omitting `Agent` from the subagent’s tools or placing it in `disallowedTools`.

## Transcript / Schema Notes
- A Claude Code issue dump shows a subagent transcript beginning with `{"parentUuid":null,"isSidechain":true,...}` and subsequent entries chained via `parentUuid`.
- A community spec for Claude Code JSONL describes message entries with shared fields including `uuid`, `parentUuid`, `sessionId`, and `isSidechain`.
- Another issue about rewind/compaction shows `isSidechain` is not a reliable indicator for all off-path branches in every workflow, so viewers should not depend on it as the sole source of truth.

## Gaps
- I did not find an official Anthropic document that explicitly says nested subagents are stored in the same project-session JSONL format at every depth.
- I did not find an official public statement of a concurrency cap for nested subagents beyond the 5-level depth cap.
- I did not verify an exact public release date for v2.1.172 from the official changelog text; version-level confirmation is strong, date-level confirmation is incomplete.

## Confidence
- High for nested-subagent support, 5-level cap, and tree-vs-flat UI guidance.
- Medium for transcript-structure conclusions, because those come from issue evidence and community parsers rather than an official schema spec.
