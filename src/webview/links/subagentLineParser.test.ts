// src/webview/links/subagentLineParser.test.ts — Unit tests for the pure header parser.

import { describe, expect, it } from "vitest";
import { parseSubagentHeader } from "./subagentLineParser";

describe("parseSubagentHeader: agent headers match", () => {
  it("matches a glyphed Explore header and captures the verbatim description", () => {
    const result = parseSubagentHeader("⏺ Explore(Find session preview rendering code)");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Explore");
    expect(result?.description).toBe("Find session preview rendering code");
  });

  it("matches the Linux glyph ● too", () => {
    expect(parseSubagentHeader("● Plan(Design the migration)")?.name).toBe("Plan");
  });

  it("matches with NO glyph (blink blanked the cell)", () => {
    const result = parseSubagentHeader("  Agent(Run the smoke test)");
    expect(result?.name).toBe("Agent");
    expect(result?.description).toBe("Run the smoke test");
  });

  it("matches a custom lowercase/hyphenated agent type", () => {
    expect(parseSubagentHeader("⏺ verification(check the diff)")?.name).toBe("verification");
    expect(parseSubagentHeader("⏺ statusline-setup(configure)")?.name).toBe("statusline-setup");
  });

  it("captures a description containing inner parentheses (greedy to last ')')", () => {
    const result = parseSubagentHeader("⏺ Explore(Find foo (and bar) too)");
    expect(result?.description).toBe("Find foo (and bar) too");
  });

  it("reports a clickable column span covering name → ')'", () => {
    // "⏺ Explore(hi)" → glyph(1)+space(1) = prefix len 2; name starts at col 2,
    // ')' is the last char at index 11.
    const result = parseSubagentHeader("⏺ Explore(hi)");
    expect(result?.startCol).toBe(2);
    expect(result?.endCol).toBe(12);
  });
});

describe("parseSubagentHeader: built-in tools + MCP excluded", () => {
  it.each([
    "Read",
    "Bash",
    "Edit",
    "MultiEdit",
    "Update",
    "Create",
    "Write",
    "Grep",
    "Glob",
    "NotebookEdit",
    "Search",
    "Task",
  ])("rejects built-in tool name %s", (tool) => {
    expect(parseSubagentHeader(`⏺ ${tool}(some args)`)).toBeNull();
  });

  it("rejects an mcp__ tool name", () => {
    expect(parseSubagentHeader("⏺ mcp__github__create_issue(args)")).toBeNull();
  });
});

describe("parseSubagentHeader: non-headers return null", () => {
  it("rejects a line without parentheses", () => {
    expect(parseSubagentHeader("⏺ Explore done")).toBeNull();
  });

  it("rejects an empty-description header", () => {
    expect(parseSubagentHeader("⏺ Explore()")).toBeNull();
  });

  it("rejects the Done trailer (a SPACE precedes its paren; a header has none)", () => {
    // The `Done (…)` trailer is a separate line — and its space before `(` means
    // the header regex (name immediately followed by `(`) rejects it outright.
    expect(parseSubagentHeader("⏺ Done (3 tool uses · 12,345 tokens · 1m 2s)")).toBeNull();
    // Stray prose parens mid-line also fail (name not adjacent to `(`).
    expect(parseSubagentHeader("see foo(bar) baz")).toBeNull();
  });

  it("rejects an empty / whitespace line", () => {
    expect(parseSubagentHeader("")).toBeNull();
    expect(parseSubagentHeader("    ")).toBeNull();
  });
});
