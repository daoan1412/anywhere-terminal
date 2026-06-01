// src/webview/links/subagentLineParser.ts — Pure parser for a Claude CLI subagent
// (Task) invocation HEADER line: `[⏺●]? <AgentType>(<description>)`.
//
// Recognition is by the header ALONE (no cross-line join): the `Done (… tool
// uses …)` / in-progress trailers render as separate, non-contiguous lines and
// xterm `ILink.range` is single-row, so the header cannot be reached from the
// trailer (design.md D2, oracle finding #1). The discriminator is the name word:
// any built-in tool display name or an `mcp__…` name is rejected; anything else
// is treated as an agent type. The status glyph blinks to a blank cell, so it is
// optional. `<description>` is captured verbatim (a prefix suffices downstream).
//
// See: specs/terminal-subagent-preview/spec.md "Detect subagent invocations…".

/** Built-in tool display names that share the `⏺ Name(args)` shape but are NOT
 *  subagents. Any header whose name is one of these (or an MCP tool) is ignored. */
const BUILTIN_TOOL_NAMES = new Set([
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
]);

// `^<indent?><glyph?> <Name>(<description>)<trailing?>$` — the glyph (`⏺` macOS /
// `●` else) blinks to blank, hence optional. `(.+)` is greedy to the LAST `)` so a
// description containing inner parens (`Find foo (bar)`) is captured whole.
const HEADER_RE = /^(\s*(?:[⏺●]\s*)?)([A-Za-z][\w-]*)\((.+)\)\s*$/u;

export interface SubagentHeader {
  /** The agent type word (e.g. `Explore`, `Plan`, `Agent`, a custom type). */
  name: string;
  /** The verbatim description inside the parentheses. */
  description: string;
  /** 0-based column of the first clickable char (the name). */
  startCol: number;
  /** 0-based column of the last clickable char (the closing `)`), inclusive. */
  endCol: number;
}

/**
 * Parse a single terminal row into a subagent header, or null when the row is not
 * a subagent invocation (no match, or a built-in/MCP tool name). Pure — no xterm
 * or DOM access; column offsets are indices into `lineText`.
 */
export function parseSubagentHeader(lineText: string): SubagentHeader | null {
  const match = HEADER_RE.exec(lineText);
  if (!match) {
    return null;
  }
  const prefix = match[1];
  const name = match[2];
  const description = match[3];
  if (BUILTIN_TOOL_NAMES.has(name) || name.startsWith("mcp__")) {
    return null; // a built-in tool / MCP call, not a subagent
  }
  const startCol = prefix.length;
  // string is `prefix + name + "(" + description + ")"`; the `)` sits at:
  const endCol = prefix.length + name.length + 1 + description.length;
  return { name, description, startCol, endCol };
}
