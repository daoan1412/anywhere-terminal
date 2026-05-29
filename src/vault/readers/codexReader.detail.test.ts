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
