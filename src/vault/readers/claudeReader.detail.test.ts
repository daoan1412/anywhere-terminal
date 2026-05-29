// src/vault/readers/claudeReader.detail.test.ts — Claude detail read (redesign-vault-panel-ui 2_2).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeDetail, resolveClaudeSessionPath } from "./claudeReader";

let configDir: string;

function jsonl(records: Record<string, unknown>[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

async function writeSession(
  encodedCwd: string,
  sessionId: string,
  records: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(configDir, "projects", encodedCwd);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(file, jsonl(records));
  return file;
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "at-claude-detail-"));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("resolveClaudeSessionPath", () => {
  it("locates the unique session file by id under projects/*", async () => {
    const file = await writeSession("-Users-me-proj", "sess-1", [{ type: "user", message: { content: "hi" } }]);
    expect(await resolveClaudeSessionPath("sess-1", { configDir })).toBe(file);
  });

  it("returns null for an unknown id", async () => {
    await writeSession("-Users-me-proj", "sess-1", [{ type: "user", message: { content: "hi" } }]);
    expect(await resolveClaudeSessionPath("nope", { configDir })).toBeNull();
  });

  it("rejects a traversal-style id without scanning", async () => {
    expect(await resolveClaudeSessionPath("../../etc/passwd", { configDir })).toBeNull();
  });
});

describe("readClaudeDetail", () => {
  it("classifies a session: first prompt, tool calls, subagent, latest, usage", async () => {
    await writeSession("-Users-me-proj", "sess-2", [
      { type: "summary", summary: "ignore me" },
      { type: "user", message: { role: "user", content: "build the thing" }, timestamp: "2026-05-01T00:00:00.000Z" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/a.ts" } }],
          usage: { output_tokens: 20, input_tokens: 100 },
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Task", input: { subagent_type: "asm-finder", prompt: "find X" } }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
        timestamp: "2026-05-01T02:00:00.000Z",
      },
    ]);

    const detail = await readClaudeDetail("sess-2", { configDir });
    expect(detail).not.toBeNull();
    if (!detail) {
      return;
    }
    expect(detail.entryId).toBe("claude:sess-2");
    expect(detail.firstPrompt).toBe("build the thing");
    expect(detail.recentActivity).toEqual([
      { kind: "tool", tool: "Read", detail: "/src/a.ts", diff: undefined },
      { kind: "subagent", name: "asm-finder", prompt: "find X" },
    ]);
    expect(detail.latestMessage).toMatchObject({ role: "assistant", text: "all done" });
    expect(detail.stats.toolCount).toBe(1);
    expect(detail.stats.subagentCount).toBe(1);
    expect(detail.stats.tokenCount).toBe(120);
  });

  it("returns null when the session id can't be resolved", async () => {
    expect(await readClaudeDetail("missing", { configDir })).toBeNull();
  });

  it("tolerates corrupt lines and still classifies the rest", async () => {
    const dir = path.join(configDir, "projects", "-Users-me-proj");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "sess-3.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({ type: "user", message: { content: "first" } })}\n{ this is not json\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })}\n`,
    );
    const detail = await readClaudeDetail("sess-3", { configDir });
    expect(detail?.firstPrompt).toBe("first");
    expect(detail?.latestMessage).toMatchObject({ role: "assistant", text: "ok" });
  });
});
