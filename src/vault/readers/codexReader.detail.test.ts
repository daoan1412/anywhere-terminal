// src/vault/readers/codexReader.detail.test.ts — Codex detail read (redesign-vault-panel-ui 2_4).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteResult } from "../sqlite";
import { classifyCodexRolloutEvents, readCodexDetail } from "./codexReader";

let codexDir: string;

function rec(
  type: string,
  payload: Record<string, unknown>,
  timestamp = "2026-03-14T04:55:30.000Z",
): Record<string, unknown> {
  return { timestamp, type, payload: { ...payload } };
}

beforeEach(async () => {
  codexDir = await fs.mkdtemp(path.join(os.tmpdir(), "at-codex-detail-"));
});

afterEach(async () => {
  await fs.rm(codexDir, { recursive: true, force: true });
});

describe("classifyCodexRolloutEvents", () => {
  it("maps user/agent messages, function/custom/web tool calls, and the token total", () => {
    const records = [
      rec("session_meta", { id: "abc" }),
      rec("event_msg", { type: "user_message", message: "review the skill" }),
      rec("response_item", { type: "reasoning", content: "secret thoughts" }),
      rec("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"rg --files"}' }),
      rec("response_item", { type: "function_call_output", call_id: "c1", output: "files..." }),
      rec("response_item", { type: "web_search_call", action: { type: "search", query: "orpc docs" } }),
      rec("response_item", {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: skills/x.md\n+content",
      }),
      rec("event_msg", { type: "agent_message", message: "here is the review", phase: "final" }),
      rec("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 12650 } } }),
    ];
    const out = classifyCodexRolloutEvents(records);
    expect(out.firstPrompt).toBe("review the skill");
    expect(out.recentActivity).toEqual([
      { kind: "tool", tool: "exec_command", detail: "rg --files" },
      { kind: "tool", tool: "WebSearch", detail: "orpc docs" },
      { kind: "tool", tool: "apply_patch", detail: "skills/x.md" },
    ]);
    expect(out.latestMessage).toMatchObject({ role: "assistant", text: "here is the review" });
    expect(out.stats).toMatchObject({ messageCount: 2, toolCount: 3, subagentCount: 0, tokenCount: 12650 });
  });

  it("omits tokenCount when no token_count event is present", () => {
    const out = classifyCodexRolloutEvents([rec("event_msg", { type: "user_message", message: "hi" })]);
    expect(out.stats.tokenCount).toBeUndefined();
  });

  it("maps a request_user_input call + its function_call_output into a question item", () => {
    // Plan-mode AskUserQuestion analogue: arguments carry the questions; the answer
    // arrives in a later function_call_output (a JSON string), keyed by question id.
    const records = [
      rec("event_msg", { type: "user_message", message: "plan it" }),
      rec("response_item", {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_q1",
        arguments: JSON.stringify({
          questions: [
            {
              id: "dir",
              header: "Direction",
              question: "Which direction?",
              options: [
                { label: "Built-in", description: "use the built-in provider" },
                { label: "Custom", description: "more control" },
              ],
            },
          ],
        }),
      }),
      rec("response_item", {
        type: "function_call_output",
        call_id: "call_q1",
        output: JSON.stringify({ answers: { dir: { answers: ["Built-in"] } } }),
      }),
    ];
    const out = classifyCodexRolloutEvents(records);
    const question = out.timeline.find((t) => t.kind === "question");
    expect(question?.kind === "question" && question.questions).toEqual([
      {
        prompt: "Which direction?",
        answer: "Built-in",
        options: [
          { label: "Built-in", description: "use the built-in provider", chosen: true },
          { label: "Custom", description: "more control" },
        ],
      },
    ]);
    // Counts as a tool call, not surfaced as a bare "request_user_input" chip.
    expect(out.timeline.some((t) => t.kind === "tool" && t.tool === "request_user_input")).toBe(false);
    expect(out.stats.toolCount).toBe(1);
  });

  it("masks a secret request_user_input answer and never reveals the picked option", () => {
    const records = [
      rec("response_item", {
        type: "function_call",
        name: "request_user_input",
        call_id: "c",
        arguments: JSON.stringify({
          questions: [{ id: "tok", header: "Token", question: "Paste the API token", isSecret: true }],
        }),
      }),
      rec("response_item", {
        type: "function_call_output",
        call_id: "c",
        output: JSON.stringify({ answers: { tok: { answers: ["user_note: sk-supersecret"] } } }),
      }),
    ];
    const out = classifyCodexRolloutEvents(records);
    const q = out.timeline.find((t) => t.kind === "question");
    expect(q?.kind === "question" && q.questions[0]).toEqual({ prompt: "Paste the API token", answer: "••••••" });
    // The raw secret never appears anywhere in the rendered detail.
    expect(JSON.stringify(out)).not.toContain("sk-supersecret");
  });

  it("strips the user_note: prefix and includes the freeform note in the answer", () => {
    const records = [
      rec("response_item", {
        type: "function_call",
        name: "request_user_input",
        call_id: "c",
        arguments: JSON.stringify({
          questions: [{ id: "env", question: "Which env?", options: [{ label: "staging" }, { label: "prod" }] }],
        }),
      }),
      rec("response_item", {
        type: "function_call_output",
        call_id: "c",
        output: JSON.stringify({ answers: { env: { answers: ["staging", "user_note: but only after 5pm"] } } }),
      }),
    ];
    const out = classifyCodexRolloutEvents(records);
    const q = out.timeline.find((t) => t.kind === "question");
    expect(q?.kind === "question" && q.questions[0]).toEqual({
      prompt: "Which env?",
      answer: "staging, but only after 5pm",
      options: [{ label: "staging", chosen: true }, { label: "prod" }],
    });
  });

  it("falls back to a tool chip for a request_user_input with unparseable arguments", () => {
    const records = [
      rec("event_msg", { type: "user_message", message: "plan it" }),
      rec("response_item", { type: "function_call", name: "request_user_input", call_id: "c", arguments: "not json" }),
    ];
    const out = classifyCodexRolloutEvents(records);
    expect(out.timeline.some((t) => t.kind === "question")).toBe(false);
    expect(out.timeline.some((t) => t.kind === "tool" && t.tool === "request_user_input")).toBe(true);
  });

  it("places a Codex child stub at the matching spawn event", () => {
    const out = classifyCodexRolloutEvents(
      [
        rec("event_msg", { type: "user_message", message: "delegate this" }, "2026-03-14T04:55:30.000Z"),
        rec(
          "event_msg",
          {
            type: "collab_agent_spawn_end",
            new_thread_id: "child-thread",
            agent_nickname: "reviewer",
            prompt: "review the implementation",
          },
          "2026-03-14T04:56:00.000Z",
        ),
      ],
      undefined,
      [
        {
          childThreadId: "child-thread",
          title: "Child review",
          firstMessage: "check the diff",
          timestamp: Date.parse("2026-03-14T04:57:00.000Z"),
        },
      ],
    );

    const child = out.timeline.find((item) => item.kind === "subagentSession");
    expect(child).toEqual({
      kind: "subagentSession",
      entryId: "codex:child-thread",
      title: "Child review",
      firstMessage: "check the diff",
      agent: "reviewer",
      timestamp: Date.parse("2026-03-14T04:56:00.000Z"),
    });
    expect(out.stats.subagentCount).toBe(1);
  });

  it("uses the parent spawn prompt before the generic child title fallback", () => {
    const out = classifyCodexRolloutEvents(
      [
        rec(
          "event_msg",
          {
            type: "collab_agent_spawn_end",
            new_thread_id: "child-thread",
            prompt: "review the implementation",
          },
          "2026-03-14T04:56:00.000Z",
        ),
      ],
      undefined,
      [{ childThreadId: "child-thread", timestamp: Date.parse("2026-03-14T04:57:00.000Z") }],
    );

    const child = out.timeline.find((item) => item.kind === "subagentSession");
    expect(child?.kind === "subagentSession" && child.title).toBe("review the implementation");
  });
});

describe("readCodexDetail", () => {
  function jsonl(records: Record<string, unknown>[]): string {
    return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  }

  it("classifies the rollout jsonl when one exists (located by filename)", async () => {
    const sessionId = "019ceab2-21cf-74d1-865a-c176228a6a20";
    const dir = path.join(codexDir, "sessions", "2026", "03", "14");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `rollout-2026-03-14T11-54-28-${sessionId}.jsonl`),
      jsonl([
        rec("event_msg", { type: "user_message", message: "build it" }),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}' }),
        rec("event_msg", { type: "agent_message", message: "done" }),
      ]),
    );
    // No sqlite available → detail still resolves via the filename scan.
    const noSqlite = async (): Promise<SqliteResult> => ({ rows: [], status: "no-sqlite3" });
    const detail = await readCodexDetail(sessionId, { codexDir, readSqliteFn: noSqlite });
    expect(detail).not.toBeNull();
    expect(detail?.entryId).toBe(`codex:${sessionId}`);
    expect(detail?.firstPrompt).toBe("build it");
    expect(detail?.recentActivity).toEqual([{ kind: "tool", tool: "exec_command", detail: "ls" }]);
    expect(detail?.partial).toBeUndefined();
  });

  it("returns a labeled partial detail from the threads index when no rollout exists", async () => {
    const sessionId = "no-rollout-here";
    const threadsRow: SqliteResult = {
      rows: [{ rollout_path: null, first_user_message: "the indexed first prompt" }],
      status: "ok",
    };
    const detail = await readCodexDetail(sessionId, { codexDir, readSqliteFn: async () => threadsRow });
    expect(detail).toMatchObject({
      entryId: `codex:${sessionId}`,
      firstPrompt: "the indexed first prompt",
      recentActivity: [],
      partial: true,
    });
    expect(detail?.limitedReason).toBeTruthy();
    // The index-only fallback surfaces exactly the one indexed prompt (s3).
    expect(detail?.stats.messageCount).toBe(1);
  });

  it("includes discoverable child stubs in a partial parent detail", async () => {
    const parentId = "parent-thread";
    const childId = "child-thread";
    const readSqliteFn = async (_dbPath: string, sql: string): Promise<SqliteResult> => {
      if (sql.includes("thread_spawn_edges")) {
        return { status: "ok", rows: [{ parent_thread_id: parentId, child_thread_id: childId }] };
      }
      if (sql.includes("WHERE id = 'parent-thread'")) {
        return { status: "ok", rows: [{ rollout_path: null, first_user_message: "parent prompt" }] };
      }
      return {
        status: "ok",
        rows: [
          {
            id: childId,
            title: "Child task",
            first_user_message: "child prompt",
            updated_at_ms: 1234,
          },
        ],
      };
    };

    const detail = await readCodexDetail(parentId, { codexDir, readSqliteFn });

    expect(detail?.partial).toBe(true);
    expect(detail?.timeline).toContainEqual({
      kind: "subagentSession",
      entryId: `codex:${childId}`,
      title: "Child task",
      firstMessage: "child prompt",
      agent: "subagent",
      timestamp: 1234,
    });
    expect(detail?.stats.subagentCount).toBe(1);
  });

  it("uses child JSONL session metadata timestamp before SQLite timestamps for unmatched child stubs", async () => {
    const parentId = "parent-thread";
    const childId = "child-thread";
    const dir = path.join(codexDir, "sessions", "2026", "03", "14");
    await fs.mkdir(dir, { recursive: true });
    const childRolloutPath = path.join(dir, "child-meta.jsonl");
    await fs.writeFile(
      childRolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-03-14T04:57:00.000Z",
        payload: { id: childId, source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } },
      })}\n`,
    );
    const readSqliteFn = async (_dbPath: string, sql: string): Promise<SqliteResult> => {
      if (sql.includes("thread_spawn_edges")) {
        return { status: "ok", rows: [{ parent_thread_id: parentId, child_thread_id: childId }] };
      }
      if (sql.includes("WHERE id = 'parent-thread'")) {
        return { status: "ok", rows: [{ rollout_path: null, first_user_message: "parent prompt" }] };
      }
      return {
        status: "ok",
        rows: [
          {
            id: childId,
            rollout_path: childRolloutPath,
            title: "Child task",
            first_user_message: "child prompt",
            created_at_ms: Date.parse("2026-03-14T05:00:00.000Z"),
            updated_at_ms: Date.parse("2026-03-14T05:01:00.000Z"),
          },
        ],
      };
    };

    const detail = await readCodexDetail(parentId, { codexDir, readSqliteFn });
    const child = detail?.timeline.find((item) => item.kind === "subagentSession");

    expect(child?.kind === "subagentSession" && child.timestamp).toBe(Date.parse("2026-03-14T04:57:00.000Z"));
  });

  it("opens a Codex child id through the normal detail path", async () => {
    const childId = "child-thread";
    const dir = path.join(codexDir, "sessions", "2026", "03", "14");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `rollout-2026-03-14T11-54-28-${childId}.jsonl`),
      jsonl([rec("event_msg", { type: "user_message", message: "child work" })]),
    );
    const noSqlite = async (): Promise<SqliteResult> => ({ rows: [], status: "no-db" });

    const detail = await readCodexDetail(childId, { codexDir, readSqliteFn: noSqlite });

    expect(detail?.entryId).toBe(`codex:${childId}`);
    expect(detail?.firstPrompt).toBe("child work");
  });

  it("returns null when neither a rollout nor an index row exists", async () => {
    const detail = await readCodexDetail("ghost", { codexDir, readSqliteFn: async () => ({ rows: [], status: "ok" }) });
    expect(detail).toBeNull();
  });

  it("rejects an unsafe session id", async () => {
    const detail = await readCodexDetail("../../etc", {
      codexDir,
      readSqliteFn: async () => ({ rows: [], status: "ok" }),
    });
    expect(detail).toBeNull();
  });
});
