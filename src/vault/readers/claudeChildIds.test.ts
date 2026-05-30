// Tests for the Claude child-id sub-protocol (nest-workflow-team-sessions 1_1).
import { describe, expect, it } from "vitest";
import {
  type ClaudeChildId,
  formatSubagentSessionId,
  formatTeamTurnSessionId,
  formatWorkflowAgentSessionId,
  formatWorkflowSessionId,
  parseClaudeChildId,
} from "./claudeChildIds";

const PARENT = "a62dbe32-e6f3-4c93-ae84-ba2b861cba11";
const WF = "wf_1a0044b3-1c2";
const STEM = "agent-a0007529c420ce068";

describe("parseClaudeChildId — round trips", () => {
  it("subagent", () => {
    const id = formatSubagentSessionId(PARENT, STEM);
    expect(parseClaudeChildId(id)).toEqual<ClaudeChildId>({ kind: "subagent", parentId: PARENT, stem: STEM });
  });

  it("workflow group", () => {
    const id = formatWorkflowSessionId(PARENT, WF);
    expect(parseClaudeChildId(id)).toEqual<ClaudeChildId>({ kind: "workflow", parentId: PARENT, wfId: WF });
  });

  it("workflow agent leaf", () => {
    const id = formatWorkflowAgentSessionId(PARENT, WF, STEM);
    expect(parseClaudeChildId(id)).toEqual<ClaudeChildId>({
      kind: "wfagent",
      parentId: PARENT,
      wfId: WF,
      stem: STEM,
    });
  });

  it("teammate turn (segment) round-trips, including turn 0", () => {
    expect(parseClaudeChildId(formatTeamTurnSessionId(PARENT, 0))).toEqual<ClaudeChildId>({
      kind: "teamTurn",
      memberId: PARENT,
      turn: 0,
    });
    expect(parseClaudeChildId(formatTeamTurnSessionId(PARENT, 12))).toEqual<ClaudeChildId>({
      kind: "teamTurn",
      memberId: PARENT,
      turn: 12,
    });
  });
});

describe("parseClaudeChildId — non-children and rejections", () => {
  it("a plain session id has no marker → null", () => {
    expect(parseClaudeChildId(PARENT)).toBeNull();
    expect(parseClaudeChildId("ses_3291b7256ffezfTi11cVg0iGfT")).toBeNull();
  });

  it("rejects a traversal parentId", () => {
    expect(parseClaudeChildId(formatWorkflowSessionId("../etc", WF))).toBeNull();
    expect(parseClaudeChildId(`..${":subagent:"}${STEM}`)).toBeNull();
  });

  it("rejects a malformed workflow id", () => {
    expect(parseClaudeChildId(`${PARENT}:workflow:not-a-wf`)).toBeNull();
    expect(parseClaudeChildId(`${PARENT}:workflow:`)).toBeNull();
  });

  it("rejects a wfagent stem that isn't agent-*", () => {
    expect(parseClaudeChildId(`${PARENT}:wfagent:${WF}:notanagent`)).toBeNull();
    expect(parseClaudeChildId(`${PARENT}:wfagent:${WF}:`)).toBeNull();
  });

  it("rejects an over-segmented wfagent id (extra colon in stem)", () => {
    expect(parseClaudeChildId(`${PARENT}:wfagent:${WF}:${STEM}:extra`)).toBeNull();
  });

  it("does not confuse :workflow: with :wfagent:", () => {
    expect(parseClaudeChildId(formatWorkflowSessionId(PARENT, WF))?.kind).toBe("workflow");
    expect(parseClaudeChildId(formatWorkflowAgentSessionId(PARENT, WF, STEM))?.kind).toBe("wfagent");
  });

  it("rejects a malformed teammate-turn ordinal", () => {
    expect(parseClaudeChildId(`${PARENT}:turn:`)).toBeNull(); // empty
    expect(parseClaudeChildId(`${PARENT}:turn:abc`)).toBeNull(); // non-numeric
    expect(parseClaudeChildId(`${PARENT}:turn:-1`)).toBeNull(); // signed
    expect(parseClaudeChildId(`${PARENT}:turn:0:1`)).toBeNull(); // over-segmented
  });

  it("rejects a traversal member id in a teammate-turn id", () => {
    expect(parseClaudeChildId("..:turn:0")).toBeNull();
    expect(parseClaudeChildId("../etc:turn:0")).toBeNull();
  });
});
