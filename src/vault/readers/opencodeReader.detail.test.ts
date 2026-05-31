// src/vault/readers/opencodeReader.detail.test.ts — OpenCode detail mapping (redesign-vault-panel-ui 2_3).

import { describe, expect, it, vi } from "vitest";
import type { SqliteResult } from "../sqlite";
import type { VaultTimelineItem } from "../types";
import {
  mapOpencodeRows,
  type OcMessageRow,
  type OcPartRow,
  readOpenCodeDetail,
  splitOpencodeSubtaskTitle,
} from "./opencodeReader";

function msg(
  id: string,
  role: "user" | "assistant",
  timeCreated: number,
  extra: Record<string, unknown> = {},
): OcMessageRow {
  return { id, timeCreated, data: { role, ...extra } };
}

function textPart(messageId: string, t: number, text: string, synthetic = false): OcPartRow {
  const data: Record<string, unknown> = { type: "text", text };
  if (synthetic) {
    data.synthetic = true;
  }
  return { messageId, timeCreated: t, data };
}

function toolPart(
  messageId: string,
  t: number,
  tool: string,
  input: Record<string, unknown>,
  metadata?: unknown,
): OcPartRow {
  return { messageId, timeCreated: t, data: { type: "tool", callID: `c${t}`, tool, state: { input, metadata } } };
}

function subtaskPart(messageId: string, t: number, agent: string, prompt: string): OcPartRow {
  return { messageId, timeCreated: t, data: { type: "subtask", agent, prompt, description: prompt } };
}

/** Mock readSqlite for readOpenCodeDetail: one parent message + part, plus one
 *  child session row carrying the given `title`/`agent`/`first_user_part`. */
function childDetailMock(child: Record<string, unknown>) {
  return vi.fn(async (_db: string, sql: string): Promise<SqliteResult> => {
    if (!sql.includes("parent_id") && sql.includes("FROM message")) {
      return { status: "ok", rows: [{ id: "m1", time_created: 1, data: JSON.stringify({ role: "user" }) }] };
    }
    if (!sql.includes("parent_id") && sql.includes("FROM part")) {
      return {
        status: "ok",
        rows: [{ message_id: "m1", time_created: 1, data: JSON.stringify({ type: "text", text: "parent prompt" }) }],
      };
    }
    return { status: "ok", rows: [{ time_created: 2, ...child }] };
  });
}

describe("mapOpencodeRows", () => {
  it("derives first prompt, tool/subtask steps, latest message, and exact token sum", () => {
    const messages: OcMessageRow[] = [
      msg("m1", "user", 1),
      msg("m2", "assistant", 2, { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } } }),
      msg("m3", "assistant", 3),
    ];
    const parts: OcPartRow[] = [
      textPart("m1", 1, "make it faster"),
      toolPart("m2", 2, "read", { filePath: "/src/a.ts" }),
      toolPart("m2", 2.5, "bash", { command: "npm test" }),
      subtaskPart("m2", 2.7, "general", "go check the thing"),
      textPart("m3", 3, "done, look here"),
    ];

    const out = mapOpencodeRows(messages, parts);
    expect(out.firstPrompt).toBe("make it faster");
    expect(out.recentActivity).toEqual([
      { kind: "tool", tool: "Read", detail: "/src/a.ts", diff: undefined },
      { kind: "tool", tool: "Bash", detail: "npm test", diff: undefined },
      { kind: "subagent", name: "general", prompt: "go check the thing" },
    ]);
    expect(out.latestMessage).toMatchObject({ role: "assistant", text: "done, look here", timestamp: 3 });
    expect(out.stats).toMatchObject({ messageCount: 3, toolCount: 2, subagentCount: 1, tokenCount: 135 });
  });

  it("excludes synthetic text parts and summary messages from first/latest + count", () => {
    const messages: OcMessageRow[] = [
      msg("s0", "user", 1, { summary: true }), // compaction message — excluded
      msg("m1", "user", 2),
      msg("m2", "assistant", 3),
    ];
    const parts: OcPartRow[] = [
      textPart("s0", 1, "SYNTHETIC SUMMARY", true),
      textPart("m1", 2, "the real prompt"),
      textPart("m2", 3, "the real reply"),
    ];
    const out = mapOpencodeRows(messages, parts);
    expect(out.firstPrompt).toBe("the real prompt");
    expect(out.latestMessage).toMatchObject({ role: "assistant", text: "the real reply" });
    expect(out.stats.messageCount).toBe(2); // summary message not counted
  });

  it("does not count textless user rows or unknown-role rows (W7)", () => {
    const messages: OcMessageRow[] = [
      msg("m1", "user", 1), // real user turn (has text)
      msg("m2", "user", 2), // tool-result-only user row (no text) — not a turn
      msg("m3", "assistant", 3), // tool-only assistant turn (no text) — still a turn
      { id: "m4", timeCreated: 4, data: { role: "tool" } }, // unknown role — skipped
    ];
    const parts: OcPartRow[] = [
      textPart("m1", 1, "the only real prompt"),
      toolPart("m3", 3, "read", { filePath: "/a.ts" }),
    ];
    const out = mapOpencodeRows(messages, parts);
    // 1 user (with text) + 1 assistant (tool-only) = 2; the textless user and the
    // unknown-role row are excluded.
    expect(out.stats.messageCount).toBe(2);
    expect(out.firstPrompt).toBe("the only real prompt");
  });

  it("computes a cheap diff stat for an edit tool from its unified-diff metadata", () => {
    const messages: OcMessageRow[] = [msg("m1", "user", 1), msg("m2", "assistant", 2)];
    const parts: OcPartRow[] = [
      textPart("m1", 1, "edit it"),
      toolPart(
        "m2",
        2,
        "edit",
        { filePath: "/a.ts" },
        {
          diff: "--- a/a.ts\n+++ b/a.ts\n+added one\n+added two\n-removed one",
        },
      ),
    ];
    const out = mapOpencodeRows(messages, parts);
    expect(out.recentActivity[0]).toEqual({
      kind: "tool",
      tool: "Edit",
      detail: "/a.ts",
      diff: { added: 2, removed: 1 },
    });
  });

  it("omits tokenCount when no assistant tokens are present", () => {
    const out = mapOpencodeRows([msg("m1", "user", 1), msg("m2", "assistant", 2)], [textPart("m1", 1, "hi")]);
    expect(out.stats.tokenCount).toBeUndefined();
  });

  it("interleaves child sub-session stubs into the timeline by timestamp", () => {
    const messages: OcMessageRow[] = [msg("m1", "user", 1), msg("m2", "assistant", 5)];
    const parts: OcPartRow[] = [textPart("m1", 1, "do the work"), textPart("m2", 5, "all done")];
    const childStubs: { timestamp: number; item: VaultTimelineItem }[] = [
      {
        timestamp: 3,
        item: {
          kind: "subagentSession",
          entryId: "opencode:ses_child",
          title: "Review (@reviewer subagent)",
          timestamp: 3,
        },
      },
    ];
    const out = mapOpencodeRows(messages, parts, undefined, childStubs);
    // user(1) → subagentSession(3) → assistant(5)
    expect(out.timeline.map((i) => i.kind)).toEqual(["message", "subagentSession", "message"]);
    const sub = out.timeline[1];
    expect(sub.kind === "subagentSession" && sub.entryId).toBe("opencode:ses_child");
    expect(out.stats.subagentCount).toBe(1); // counts children, not subtask parts
  });
});

describe("readOpenCodeDetail child sub-sessions", () => {
  it("queries direct children by parent_id and embeds them as subagentSession stubs", async () => {
    const readSqliteFn = vi.fn(async (_db: string, sql: string): Promise<SqliteResult> => {
      // Check children FIRST — its first-user-message subquery also contains
      // "FROM part", so it must not be misrouted to the parts branch.
      if (!sql.includes("parent_id") && sql.includes("FROM message")) {
        return { status: "ok", rows: [{ id: "m1", time_created: 1, data: JSON.stringify({ role: "user" }) }] };
      }
      if (!sql.includes("parent_id") && sql.includes("FROM part")) {
        return {
          status: "ok",
          rows: [{ message_id: "m1", time_created: 1, data: JSON.stringify({ type: "text", text: "parent prompt" }) }],
        };
      }
      // children query (WHERE s.parent_id = ...)
      return {
        status: "ok",
        rows: [
          {
            id: "ses_kid",
            title: "New session - 2026-05-01T00:00:00Z", // placeholder → falls back to first message
            agent: "reviewer",
            time_created: 2,
            first_user_part: JSON.stringify({ type: "text", text: "go review the diff" }),
          },
        ],
      };
    });

    const detail = await readOpenCodeDetail("ses_parent", { dataDir: "/x/oc", readSqliteFn }, undefined);
    expect(detail).not.toBeNull();
    expect(readSqliteFn).toHaveBeenCalledTimes(3);
    const childSql = readSqliteFn.mock.calls.find((c) => c[1].includes("parent_id"))?.[1] ?? "";
    expect(childSql).toContain("WHERE s.parent_id = 'ses_parent'");
    const stub = detail?.timeline.find((i) => i.kind === "subagentSession");
    expect(stub).toBeDefined();
    if (stub?.kind === "subagentSession") {
      expect(stub.entryId).toBe("opencode:ses_kid");
      expect(stub.title).toBe("go review the diff"); // placeholder title → first message
      expect(stub.agent).toBe("reviewer");
    }
  });

  it("still returns the parent detail when the child query fails", async () => {
    const readSqliteFn = vi.fn(async (_db: string, sql: string): Promise<SqliteResult> => {
      if (sql.includes("FROM message")) {
        return { status: "ok", rows: [{ id: "m1", time_created: 1, data: JSON.stringify({ role: "user" }) }] };
      }
      if (sql.includes("FROM part") && !sql.includes("parent_id")) {
        return {
          status: "ok",
          rows: [{ message_id: "m1", time_created: 1, data: JSON.stringify({ type: "text", text: "hi" }) }],
        };
      }
      return { status: "query-error", rows: [] }; // children query fails → degrade
    });
    const detail = await readOpenCodeDetail("ses_parent", { dataDir: "/x/oc", readSqliteFn }, undefined);
    expect(detail).not.toBeNull();
    expect(detail?.timeline.some((i) => i.kind === "subagentSession")).toBe(false);
  });

  it("strips OpenCode's `(@<agent> subagent)` title suffix so the @agent chip is not duplicated", async () => {
    const readSqliteFn = childDetailMock({
      id: "ses_kid",
      title: "Review logic architecture (@asm-review-logic subagent)",
      agent: "asm-review-logic",
      first_user_part: JSON.stringify({ type: "text", text: "review the logic" }),
    });
    const detail = await readOpenCodeDetail("ses_parent", { dataDir: "/x/oc", readSqliteFn }, undefined);
    const stub = detail?.timeline.find((i) => i.kind === "subagentSession");
    expect(stub?.kind === "subagentSession" && stub.title).toBe("Review logic architecture");
    expect(stub?.kind === "subagentSession" && stub.agent).toBe("asm-review-logic");
  });

  it("recovers the agent from the title suffix when the `agent` column is empty", async () => {
    const readSqliteFn = childDetailMock({
      id: "ses_kid",
      title: "Extract change knowledge (@asm-knowledge-extract subagent)",
      agent: "", // OpenCode leaves the column empty for some nested spawns
      first_user_part: JSON.stringify({ type: "text", text: "extract it" }),
    });
    const detail = await readOpenCodeDetail("ses_parent", { dataDir: "/x/oc", readSqliteFn }, undefined);
    const stub = detail?.timeline.find((i) => i.kind === "subagentSession");
    expect(stub?.kind === "subagentSession" && stub.title).toBe("Extract change knowledge");
    expect(stub?.kind === "subagentSession" && stub.agent).toBe("asm-knowledge-extract");
  });
});

describe("splitOpencodeSubtaskTitle", () => {
  it("splits the `<description> (@<agent> subagent)` form into description + agent", () => {
    expect(splitOpencodeSubtaskTitle("Review logic architecture (@asm-review-logic subagent)")).toEqual({
      title: "Review logic architecture",
      agent: "asm-review-logic",
    });
  });

  it("returns the title untouched (no agent) when there is no subagent suffix", () => {
    expect(splitOpencodeSubtaskTitle("Just a normal title")).toEqual({ title: "Just a normal title" });
  });

  it("does not strip when the suffix would leave an empty description", () => {
    // Nothing meaningful to keep → leave the raw title rather than blank it out.
    expect(splitOpencodeSubtaskTitle("(@general subagent)")).toEqual({ title: "(@general subagent)" });
  });
});
