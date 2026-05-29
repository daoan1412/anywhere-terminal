// src/vault/readers/detail.test.ts — Shared detail substrate (redesign-vault-panel-ui 2_1).

import { describe, expect, it } from "vitest";
import {
  boundActivity,
  clampDetailLimit,
  classifyClaudeStyleEvents,
  cleanPromptText,
  createBoundedRecordBuffer,
  finalizeDetail,
  MAX_ACTIVITY_STEPS,
  MAX_DETAIL_LIMIT,
  SOURCE_TRUNCATED_REASON,
  toolLabel,
  truncate,
} from "./detail";

type Rec = Record<string, unknown>;

function userText(text: string, over: Rec = {}): Rec {
  return { type: "user", message: { role: "user", content: text }, timestamp: "2026-05-01T00:00:00.000Z", ...over };
}

function toolResultUser(toolUseId: string): Rec {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  };
}

function assistantText(text: string, over: Rec = {}): Rec {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: "2026-05-01T01:00:00.000Z",
    ...over,
  };
}

function assistantTool(name: string, input: Rec, usage?: Rec): Rec {
  const message: Rec = { role: "assistant", content: [{ type: "tool_use", name, input }] };
  if (usage) {
    message.usage = usage;
  }
  return { type: "assistant", message };
}

describe("truncate", () => {
  it("collapses whitespace and trims", () => {
    expect(truncate("  a\n\n  b   c  ")).toBe("a b c");
  });

  it("caps at the max and appends an ellipsis", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
  });
});

describe("boundActivity", () => {
  it("keeps only the most-recent N (the tail)", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(boundActivity(items, 12)).toEqual(items.slice(8));
    expect(boundActivity([1, 2], 12)).toEqual([1, 2]);
  });
});

describe("toolLabel", () => {
  it("uses file_path for file tools", () => {
    expect(toolLabel("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolLabel("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" })).toBe("/a/b.ts");
    expect(toolLabel("Write", { file_path: "/a/b.ts", content: "..." })).toBe("/a/b.ts");
  });

  it("uses command for Bash and pattern for Grep/Glob", () => {
    expect(toolLabel("Bash", { command: "npm test", description: "run" })).toBe("npm test");
    expect(toolLabel("Grep", { pattern: "foo.*bar" })).toBe("foo.*bar");
    expect(toolLabel("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("falls back to the first string field for unknown tools", () => {
    expect(toolLabel("MysteryTool", { count: 3, label: "hello" })).toBe("hello");
    expect(toolLabel("MysteryTool", { count: 3 })).toBeUndefined();
  });
});

describe("cleanPromptText", () => {
  it("passes a plain human prompt through (trimmed)", () => {
    expect(cleanPromptText("  fix the bug  ")).toBe("fix the bug");
  });

  it("drops the local-command caveat banner and command stdout", () => {
    expect(cleanPromptText("<local-command-caveat>Caveat: …</local-command-caveat>")).toBeUndefined();
    expect(cleanPromptText("<local-command-stdout>done</local-command-stdout>")).toBeUndefined();
  });

  it("drops a bare slash-command (no args)", () => {
    expect(cleanPromptText("<command-name>/clear</command-name>\n<command-args></command-args>")).toBeUndefined();
  });

  it("surfaces the command + args for a slash-command WITH arguments", () => {
    const raw =
      "<command-message>asimov-plan</command-message>\n<command-name>/asimov-plan</command-name>\n<command-args>update the vault UI</command-args>";
    expect(cleanPromptText(raw)).toBe("/asimov-plan update the vault UI");
  });
});

describe("classifyClaudeStyleEvents", () => {
  it("captures the first prompt independently of the 12-step activity cap", () => {
    const records: Rec[] = [userText("the very first prompt")];
    for (let i = 0; i < 20; i++) {
      records.push(assistantTool("Bash", { command: `cmd ${i}` }));
    }
    records.push(assistantText("final answer"));

    const out = classifyClaudeStyleEvents(records);
    expect(out.firstPrompt).toBe("the very first prompt");
    expect(out.recentActivity).toHaveLength(MAX_ACTIVITY_STEPS);
    // Tail kept: last bash call is cmd 19.
    expect(out.recentActivity.at(-1)).toEqual({ kind: "tool", tool: "Bash", detail: "cmd 19", diff: undefined });
    expect(out.latestMessage).toMatchObject({ role: "assistant", text: "final answer" });
  });

  it("records Read + Bash tool calls and a Task as a subagent step", () => {
    const records: Rec[] = [
      userText("do work"),
      assistantTool("Read", { file_path: "/src/x.ts" }),
      assistantTool("Bash", { command: "ls -la" }),
      assistantTool("Task", { subagent_type: "asm-review-frontend", prompt: "review the change" }),
    ];
    const out = classifyClaudeStyleEvents(records);
    expect(out.recentActivity).toEqual([
      { kind: "tool", tool: "Read", detail: "/src/x.ts", diff: undefined },
      { kind: "tool", tool: "Bash", detail: "ls -la", diff: undefined },
      { kind: "subagent", name: "asm-review-frontend", prompt: "review the change" },
    ]);
    expect(out.stats.toolCount).toBe(2);
    expect(out.stats.subagentCount).toBe(1);
  });

  it("does NOT add a tool_result user message as its own step or message", () => {
    const records: Rec[] = [
      userText("start"),
      assistantTool("Read", { file_path: "/a.ts" }),
      toolResultUser("tu_1"),
      assistantText("done"),
    ];
    const out = classifyClaudeStyleEvents(records);
    // Only the Read tool_use is a step — the tool_result is not.
    expect(out.recentActivity).toEqual([{ kind: "tool", tool: "Read", detail: "/a.ts", diff: undefined }]);
    // Messages: user "start" + 2 assistant turns = 3 (the tool_result user is excluded).
    expect(out.stats.messageCount).toBe(3);
    expect(out.latestMessage).toMatchObject({ role: "assistant", text: "done" });
  });

  it("excludes summary and sidechain records from first/latest selection", () => {
    const records: Rec[] = [
      { type: "summary", summary: "a synthetic summary" },
      userText("sidechain prompt", { isSidechain: true }),
      assistantText("sidechain reply", { isSidechain: true }),
      userText("the real first prompt"),
      assistantText("the real latest"),
    ];
    const out = classifyClaudeStyleEvents(records);
    expect(out.firstPrompt).toBe("the real first prompt");
    expect(out.latestMessage).toMatchObject({ role: "assistant", text: "the real latest" });
    // Sidechain turns excluded from the message count too.
    expect(out.stats.messageCount).toBe(2);
  });

  it("computes a diff stat for Edit from the old/new strings", () => {
    const records: Rec[] = [
      userText("edit it"),
      assistantTool("Edit", { file_path: "/a.ts", old_string: "one\ntwo", new_string: "one\ntwo\nthree\nfour" }),
    ];
    const out = classifyClaudeStyleEvents(records);
    expect(out.recentActivity[0]).toEqual({
      kind: "tool",
      tool: "Edit",
      detail: "/a.ts",
      diff: { added: 2, removed: 0 },
    });
  });

  it("sums usage into an approximate token count when present", () => {
    const records: Rec[] = [
      userText("hi"),
      assistantTool("Bash", { command: "a" }, { output_tokens: 100, input_tokens: 500 }),
      assistantTool(
        "Bash",
        { command: "b" },
        {
          output_tokens: 50,
          input_tokens: 1200,
          cache_read_input_tokens: 300,
        },
      ),
    ];
    const out = classifyClaudeStyleEvents(records);
    // output sum (150) + last turn context (1200 + 300) = 1650.
    expect(out.stats.tokenCount).toBe(1650);
  });

  it("omits tokenCount when no usage is present", () => {
    const out = classifyClaudeStyleEvents([userText("hi"), assistantText("yo")]);
    expect(out.stats.tokenCount).toBeUndefined();
  });

  it("builds a full chronological timeline (messages interleaved with tool/subagent steps)", () => {
    const records: Rec[] = [
      userText("do the work"),
      assistantTool("Read", { file_path: "/a.ts" }),
      assistantText("here is the plan"),
      assistantTool("Task", { subagent_type: "asm-finder", prompt: "find it" }),
      userText("looks good"),
    ];
    const out = classifyClaudeStyleEvents(records);
    expect(out.timeline).toEqual([
      { kind: "message", role: "user", text: "do the work", timestamp: expect.any(Number) },
      { kind: "tool", tool: "Read", detail: "/a.ts", diff: undefined },
      { kind: "message", role: "assistant", text: "here is the plan", timestamp: expect.any(Number) },
      { kind: "subagent", name: "asm-finder", prompt: "find it" },
      { kind: "message", role: "user", text: "looks good", timestamp: expect.any(Number) },
    ]);
  });

  it("skips isMeta records, the caveat banner, and bare commands when picking the first prompt", () => {
    const records: Rec[] = [
      userText("<local-command-caveat>Caveat: …</local-command-caveat>", { isMeta: true }),
      userText("<command-name>/clear</command-name>\n<command-args></command-args>"),
      userText("<command-name>/asimov-build</command-name>\n<command-args>ship the vault fix</command-args>"),
      assistantText("on it"),
    ];
    const out = classifyClaudeStyleEvents(records);
    expect(out.firstPrompt).toBe("/asimov-build ship the vault fix");
    // The caveat (meta) + bare /clear are not human turns → not counted.
    expect(out.stats.messageCount).toBe(2);
  });

  it("folds an Agent/Task spawn into a subagentSession when a matching child stub is provided", () => {
    const records: Rec[] = [
      userText("go"),
      assistantTool("Agent", { subagent_type: "cf-oracle", description: "Oracle review of the plan" }),
      assistantText("done"),
    ];
    const out = classifyClaudeStyleEvents(records, {
      childStubs: [
        {
          entryId: "claude:parent:subagent:agent-abc",
          agentType: "cf-oracle",
          description: "Oracle review of the plan",
          firstMessage: "You are reviewing…",
          timestamp: 10,
        },
      ],
    });
    const sub = out.timeline.find((i) => i.kind === "subagentSession");
    expect(sub).toBeDefined();
    if (sub?.kind === "subagentSession") {
      expect(sub.entryId).toBe("claude:parent:subagent:agent-abc");
      expect(sub.title).toBe("Oracle review of the plan");
      expect(sub.agent).toBe("cf-oracle");
    }
    // No bare "subagent" step remains for the matched spawn.
    expect(out.timeline.some((i) => i.kind === "subagent")).toBe(false);
  });

  it("falls back to a plain subagent step when no child stub matches", () => {
    const records: Rec[] = [
      userText("go"),
      assistantTool("Agent", { subagent_type: "general", description: "unmatched" }),
    ];
    const out = classifyClaudeStyleEvents(records, { childStubs: [] });
    expect(out.timeline.some((i) => i.kind === "subagent")).toBe(true);
    expect(out.timeline.some((i) => i.kind === "subagentSession")).toBe(false);
  });

  it("includes isSidechain records only when includeSidechain is set (subagent files)", () => {
    const records: Rec[] = [
      userText("subagent prompt", { isSidechain: true }),
      assistantText("subagent reply", { isSidechain: true }),
    ];
    // Default: sidechain is noise in a MAIN transcript → dropped.
    expect(classifyClaudeStyleEvents(records).timeline).toHaveLength(0);
    // For a subagent file, the sidechain IS the conversation.
    const out = classifyClaudeStyleEvents(records, { includeSidechain: true });
    expect(out.timeline.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("counts distinct subagents as max(spawn calls, stubs) — no double-count on mismatch (W4)", () => {
    // One spawn call whose description does NOT match the one stub: the call
    // surfaces as a plain step AND the stub is appended, but the count is 1.
    const records: Rec[] = [
      userText("go"),
      assistantTool("Agent", { subagent_type: "general", description: "spawn description" }),
    ];
    const stub = { entryId: "claude:p:subagent:agent-x", description: "different", agentType: "cf-oracle" };
    const out = classifyClaudeStyleEvents(records, { childStubs: [stub] });
    expect(out.stats.subagentCount).toBe(1);
  });

  it("counts all stubs when there are more transcripts than matched calls (W4)", () => {
    const records: Rec[] = [userText("go"), assistantTool("Agent", { description: "A" })];
    const stubs = [
      { entryId: "claude:p:subagent:a", description: "A" },
      { entryId: "claude:p:subagent:b", description: "B" },
    ];
    const out = classifyClaudeStyleEvents(records, { childStubs: stubs });
    // 1 matched call + 1 leftover stub = 2 distinct subagents (not 3).
    expect(out.stats.subagentCount).toBe(2);
    expect(out.timeline.filter((i) => i.kind === "subagentSession")).toHaveLength(2);
  });
});

describe("clampDetailLimit (W2)", () => {
  it("passes a finite positive int through, capped at the max", () => {
    expect(clampDetailLimit(400)).toBe(400);
    expect(clampDetailLimit(800)).toBe(800);
    expect(clampDetailLimit(MAX_DETAIL_LIMIT + 5000)).toBe(MAX_DETAIL_LIMIT);
    expect(clampDetailLimit(123.9)).toBe(123);
  });

  it("rejects undefined / non-finite / non-positive → undefined (reader default)", () => {
    expect(clampDetailLimit(undefined)).toBeUndefined();
    expect(clampDetailLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampDetailLimit(Number.NaN)).toBeUndefined();
    expect(clampDetailLimit(0)).toBeUndefined();
    expect(clampDetailLimit(-10)).toBeUndefined();
  });
});

describe("finalizeDetail (contracts P2 — source vs pageable truncation)", () => {
  const base: Omit<import("../types").VaultSessionDetail, "entryId"> = {
    recentActivity: [],
    timeline: [{ kind: "message", role: "user", text: "hi" }],
    stats: { messageCount: 1, toolCount: 0, subagentCount: 0 },
  };

  it("passes the detail through untouched when the source read was complete", () => {
    const out = finalizeDetail("claude:a", { ...base, truncated: true }, false);
    expect(out.partial).toBeUndefined();
    expect(out.limitedReason).toBeUndefined();
    // The classifier's own pageable `truncated` is preserved (drives load-more).
    expect(out.truncated).toBe(true);
  });

  it("marks a source-truncated read as partial WITHOUT touching pageable truncated", () => {
    const out = finalizeDetail("claude:a", { ...base, truncated: true }, true);
    expect(out.partial).toBe(true);
    expect(out.limitedReason).toBe(SOURCE_TRUNCATED_REASON);
    // Still pageable within the retained window — load-more semantics intact.
    expect(out.truncated).toBe(true);
  });

  it("keeps an existing limitedReason instead of overwriting it", () => {
    const out = finalizeDetail("codex:a", { ...base, limitedReason: "index only" }, true);
    expect(out.partial).toBe(true);
    expect(out.limitedReason).toBe("index only");
  });
});

describe("createBoundedRecordBuffer (W1)", () => {
  it("keeps every record in order when under the cap", () => {
    const buf = createBoundedRecordBuffer(2, 3);
    const recs = [{ i: 0 }, { i: 1 }, { i: 2 }];
    for (const r of recs) {
      buf.push(r);
    }
    expect(buf.result()).toEqual({ records: recs, truncated: false });
  });

  it("keeps head + tail and drops the middle when over the cap", () => {
    const buf = createBoundedRecordBuffer(2, 3);
    for (let i = 0; i < 10; i++) {
      buf.push({ i });
    }
    const { records, truncated } = buf.result();
    expect(truncated).toBe(true);
    // head = first 2, tail = last 3.
    expect(records.map((r) => (r as { i: number }).i)).toEqual([0, 1, 7, 8, 9]);
  });
});
