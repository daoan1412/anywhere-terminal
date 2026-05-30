// src/vault/readers/claudeChildIds.ts — entryId sub-protocol for Claude child
// sessions (nest-workflow-team-sessions D2). One home for the marker grammar so
// every producer/consumer parses identically and traversal is rejected up front.
//
// An entry id is `<agent>:<sessionId>` (types.ts, first-colon split). For Claude
// children the `sessionId` portion carries a marker:
//   subagent leaf : <parentId>:subagent:<stem>
//   workflow group: <parentId>:workflow:<wfId>
//   workflow agent: <parentId>:wfagent:<wfId>:<stem>
//   teammate turn : <memberId>:turn:<n>   (view-only slice of a member session)
// A team MEMBER is a normal full session id (`<uuid>`), not a child id — it has
// no marker and parses as null here (the caller treats it as a plain session). A
// `:turn:` id is a VIEW of one communication turn of a member session (D12); the
// member itself stays launchable by its plain `<memberId>`. (Team members are
// threaded into the leader as `teammateTurn` nodes — there is no `:team:` group
// id any more; D13/D14 superseded it.)

/** Marker substrings. `:wfagent:` MUST be tested before `:workflow:`-style ids
 *  even though they don't overlap, to keep the check order explicit. */
const SUBAGENT_MARKER = ":subagent:";
const WORKFLOW_MARKER = ":workflow:";
const WFAGENT_MARKER = ":wfagent:";
const TEAM_TURN_MARKER = ":turn:";

/** Mirrors claudeReader.isSafeSessionId — filename-safe, no traversal. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
/** Workflow run id, e.g. `wf_1a0044b3-1c2`. */
const WF_ID = /^wf_[A-Za-z0-9_-]+$/;
/** Workflow agent transcript stem, e.g. `agent-a0007529c420ce068`. */
const AGENT_STEM = /^agent-[A-Za-z0-9]+$/;
/** A teammate-turn ordinal — a non-negative integer with no trailing colon. */
const TURN_INDEX = /^\d+$/;

function safeId(value: string): boolean {
  return SAFE_ID.test(value) && !value.includes("..");
}

export type ClaudeChildId =
  | { kind: "subagent"; parentId: string; stem: string }
  | { kind: "workflow"; parentId: string; wfId: string }
  | { kind: "wfagent"; parentId: string; wfId: string; stem: string }
  | { kind: "teamTurn"; memberId: string; turn: number };

/**
 * Parse a Claude `sessionId` (the part after `claude:`) into a child id, or null
 * when it carries no marker (a plain session) OR any segment fails validation
 * (unsafe parentId, malformed wfId/stem, empty teamName, extra colons). Markers
 * are distinct substrings, so at most one applies; each branch validates every
 * segment before returning so a crafted id can never reach a path join.
 */
export function parseClaudeChildId(sessionId: string): ClaudeChildId | null {
  let at = sessionId.indexOf(WFAGENT_MARKER);
  if (at >= 0) {
    const parentId = sessionId.slice(0, at);
    const rest = sessionId.slice(at + WFAGENT_MARKER.length);
    const sep = rest.indexOf(":");
    if (sep <= 0) {
      return null;
    }
    const wfId = rest.slice(0, sep);
    const stem = rest.slice(sep + 1);
    if (!safeId(parentId) || !WF_ID.test(wfId) || !AGENT_STEM.test(stem)) {
      return null;
    }
    return { kind: "wfagent", parentId, wfId, stem };
  }

  at = sessionId.indexOf(WORKFLOW_MARKER);
  if (at >= 0) {
    const parentId = sessionId.slice(0, at);
    const wfId = sessionId.slice(at + WORKFLOW_MARKER.length);
    if (!safeId(parentId) || !WF_ID.test(wfId)) {
      return null;
    }
    return { kind: "workflow", parentId, wfId };
  }

  at = sessionId.indexOf(SUBAGENT_MARKER);
  if (at >= 0) {
    const parentId = sessionId.slice(0, at);
    const stem = sessionId.slice(at + SUBAGENT_MARKER.length);
    if (!safeId(parentId) || !safeId(stem)) {
      return null;
    }
    return { kind: "subagent", parentId, stem };
  }

  at = sessionId.indexOf(TEAM_TURN_MARKER);
  if (at >= 0) {
    const memberId = sessionId.slice(0, at);
    const rest = sessionId.slice(at + TEAM_TURN_MARKER.length);
    // `rest` must be a bare non-negative integer — `^\d+$` rejects an over-
    // segmented id (`<n>:extra`), a sign, or a non-numeric ordinal.
    if (!safeId(memberId) || !TURN_INDEX.test(rest)) {
      return null;
    }
    return { kind: "teamTurn", memberId, turn: Number(rest) };
  }

  return null; // no marker → a plain session id
}

/** `<parentId>:subagent:<stem>` (the sessionId portion). */
export function formatSubagentSessionId(parentId: string, stem: string): string {
  return `${parentId}${SUBAGENT_MARKER}${stem}`;
}

/** `<parentId>:workflow:<wfId>`. */
export function formatWorkflowSessionId(parentId: string, wfId: string): string {
  return `${parentId}${WORKFLOW_MARKER}${wfId}`;
}

/** `<parentId>:wfagent:<wfId>:<stem>`. */
export function formatWorkflowAgentSessionId(parentId: string, wfId: string, stem: string): string {
  return `${parentId}${WFAGENT_MARKER}${wfId}:${stem}`;
}

/** `<memberId>:turn:<n>` — a view-only id for the n-th communication turn of a
 *  member session (D12). `n` is the 0-based ordinal of the turn boundary (an
 *  incoming `<teammate-message>` record) in the member's append-only transcript. */
export function formatTeamTurnSessionId(memberId: string, turn: number): string {
  return `${memberId}${TEAM_TURN_MARKER}${turn}`;
}
