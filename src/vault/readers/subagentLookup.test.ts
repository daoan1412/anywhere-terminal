// src/vault/readers/subagentLookup.test.ts — Unit tests for clicked-description → detail.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSubagentDetail } from "./subagentLookup";

let tmpRoot: string;
let subagentsDir: string;
const PARENT = "parent-session";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anywhere-subagent-"));
  // Mirror the real store layout: <root>/projects/<encoded-cwd>/<parent>/subagents/.
  subagentsDir = path.join(tmpRoot, "projects", "-work-proj", PARENT, "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function opts() {
  return { configDir: tmpRoot };
}

/** Write a subagent transcript + its meta sidecar. */
async function writeSubagent(stem: string, description: string, firstText = "do the thing"): Promise<void> {
  const record = {
    type: "user",
    isSidechain: true,
    agentId: stem.replace(/^agent-/, ""),
    message: { role: "user", content: firstText },
    timestamp: "2026-06-01T00:00:00.000Z",
    uuid: `${stem}-u1`,
    parentUuid: null,
    sessionId: PARENT,
  };
  await fs.writeFile(path.join(subagentsDir, `${stem}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  await fs.writeFile(
    path.join(subagentsDir, `${stem}.meta.json`),
    JSON.stringify({ agentType: "Explore", description }),
    "utf8",
  );
}

describe("resolveSubagentDetail", () => {
  it("matches a stub by exact description and returns its detail with the subagent entryId", async () => {
    await writeSubagent("agent-aaa", "Find the auth middleware");

    const detail = await resolveSubagentDetail(PARENT, "Find the auth middleware", opts());

    expect(detail).not.toBeNull();
    expect(detail?.entryId).toBe(`claude:${PARENT}:subagent:agent-aaa`);
  });

  it("matches by PREFIX (terminal right-edge clipping drops trailing chars)", async () => {
    await writeSubagent("agent-bbb", "Find the session preview rendering code");

    const detail = await resolveSubagentDetail(PARENT, "Find the session preview", opts());

    expect(detail?.entryId).toBe(`claude:${PARENT}:subagent:agent-bbb`);
  });

  it("returns null when no stub description starts with the clicked text", async () => {
    await writeSubagent("agent-ccc", "Refactor the parser");
    expect(await resolveSubagentDetail(PARENT, "Find the auth", opts())).toBeNull();
  });

  it("returns null for an empty/whitespace description", async () => {
    await writeSubagent("agent-ddd", "anything");
    expect(await resolveSubagentDetail(PARENT, "   ", opts())).toBeNull();
  });

  it("returns null when the parent session has no subagents", async () => {
    expect(await resolveSubagentDetail("unknown-parent", "whatever", opts())).toBeNull();
  });

  it("breaks ties on shared prefix by newest file mtime", async () => {
    await writeSubagent("agent-old", "Find things everywhere");
    await writeSubagent("agent-new", "Find things in the codebase");
    // Make agent-new's transcript strictly newer.
    const old = new Date("2026-06-01T00:00:00Z");
    const recent = new Date("2026-06-01T01:00:00Z");
    await fs.utimes(path.join(subagentsDir, "agent-old.jsonl"), old, old);
    await fs.utimes(path.join(subagentsDir, "agent-new.jsonl"), recent, recent);

    const detail = await resolveSubagentDetail(PARENT, "Find things", opts());
    expect(detail?.entryId).toBe(`claude:${PARENT}:subagent:agent-new`);
  });
});
