// src/vault/readers/claudeReader.test.ts — Unit tests over captured fixtures.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readClaudeDetail, readClaudeEntry, readClaudeSessions } from "./claudeReader";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(here, "..", "__fixtures__", "claude");
const CMDS_FIXTURE_ROOT = path.join(here, "..", "__fixtures__", "claude-cmds");
const TITLE_FIXTURE_ROOT = path.join(here, "..", "__fixtures__", "claude-title");
const SUBAGENT_FIXTURE_ROOT = path.join(here, "..", "__fixtures__", "claude-subagents");

describe("readClaudeSessions", () => {
  it("reads the valid session and counts the malformed one as unreadable", async () => {
    const { entries, unreadable } = await readClaudeSessions({ configDir: FIXTURE_ROOT });
    expect(entries).toHaveLength(1);
    expect(unreadable).toBe(1);
  });

  it("maps the documented metadata fields", async () => {
    const { entries } = await readClaudeSessions({ configDir: FIXTURE_ROOT });
    const e = entries[0];
    expect(e.id).toBe("claude:sess-valid");
    expect(e.agent).toBe("claude");
    expect(e.sessionId).toBe("sess-valid");
    expect(e.cwd).toBe("/Users/me/proj");
    expect(e.flags.model).toBe("claude-opus-4-7");
    expect(e.flags.permissionMode).toBe("acceptEdits");
    expect(e.flags.configDir).toBe(FIXTURE_ROOT);
    expect(e.modified).toBeGreaterThan(0);
    expect(e.canFork).toBe(false);
  });

  it("falls back to the first user message when there is no ai-title", async () => {
    const { entries } = await readClaudeSessions({ configDir: FIXTURE_ROOT });
    expect(entries[0].title.startsWith("Please help me build a really long prompt")).toBe(true);
  });

  it("prefers Claude's latest ai-title over the first user message", async () => {
    const { entries } = await readClaudeSessions({ configDir: TITLE_FIXTURE_ROOT });
    expect(entries).toHaveLength(1);
    // The newest ai-title wins over both the stale early one and the prompt.
    expect(entries[0].title).toBe("Redesign the AI Vault panel");
  });

  it("bounds the title to <=120 chars and strips newlines (D4)", async () => {
    const { entries } = await readClaudeSessions({ configDir: FIXTURE_ROOT });
    expect(entries[0].title.length).toBeLessThanOrEqual(120);
    expect(entries[0].title).not.toContain("\n");
  });

  it("skips the caveat banner and bare slash-commands, titling from the first real prompt", async () => {
    const { entries } = await readClaudeSessions({ configDir: CMDS_FIXTURE_ROOT });
    expect(entries).toHaveLength(1);
    // Not the <local-command-caveat> banner, not the bare /clear — the first
    // command WITH args wins.
    expect(entries[0].title).toBe("/asimov-plan update the vault UI please");
  });

  it("returns zero entries (not an error) when the projects dir is absent", async () => {
    const { entries, unreadable } = await readClaudeSessions({ configDir: "/nonexistent/claude/root" });
    expect(entries).toEqual([]);
    expect(unreadable).toBe(0);
  });

  it("does NOT list subagent transcripts as separate sessions (only the parent)", async () => {
    const { entries } = await readClaudeSessions({ configDir: SUBAGENT_FIXTURE_ROOT });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("claude:sess-parent");
  });
});

describe("readClaudeEntry: single-entry resolve", () => {
  it("resolves one session by id with the same fields as the list scan", async () => {
    const entry = await readClaudeEntry("sess-valid", { configDir: FIXTURE_ROOT });
    expect(entry?.id).toBe("claude:sess-valid");
    expect(entry?.sessionId).toBe("sess-valid");
    expect(entry?.cwd).toBe("/Users/me/proj");
    expect(entry?.flags.model).toBe("claude-opus-4-7");
    expect(entry?.flags.permissionMode).toBe("acceptEdits");
    expect(entry?.flags.configDir).toBe(FIXTURE_ROOT);
  });

  it("returns null for an unsafe id (path traversal)", async () => {
    expect(await readClaudeEntry("../../escape", { configDir: FIXTURE_ROOT })).toBeNull();
  });

  it("returns null for a session that does not exist", async () => {
    expect(await readClaudeEntry("nope-not-here", { configDir: FIXTURE_ROOT })).toBeNull();
  });
});

describe("readClaudeDetail subagent nesting (new <sessionId>/subagents layout)", () => {
  it("folds each subagent into the parent timeline as a lazy subagentSession", async () => {
    const detail = await readClaudeDetail("sess-parent", { configDir: SUBAGENT_FIXTURE_ROOT });
    expect(detail).not.toBeNull();
    const sub = detail?.timeline.find((i) => i.kind === "subagentSession");
    expect(sub).toBeDefined();
    if (sub?.kind === "subagentSession") {
      expect(sub.entryId).toBe("claude:sess-parent:subagent:agent-deadbeef01");
      expect(sub.title).toBe("Oracle review of refactor"); // from meta.description
      expect(sub.agent).toBe("cf-oracle");
      expect(sub.firstMessage).toContain("reviewing the refactor");
    }
    // The matched Agent spawn becomes the rich block, not a bare subagent step.
    expect(detail?.timeline.some((i) => i.kind === "subagent")).toBe(false);
  });

  it("resolves a subagent transcript by its composite id, including its sidechain records", async () => {
    const detail = await readClaudeDetail("sess-parent:subagent:agent-deadbeef01", {
      configDir: SUBAGENT_FIXTURE_ROOT,
    });
    expect(detail).not.toBeNull();
    expect(detail?.entryId).toBe("claude:sess-parent:subagent:agent-deadbeef01");
    // The subagent file is entirely isSidechain — it IS the conversation here.
    expect(
      detail?.timeline.some((i) => i.kind === "message" && i.role === "assistant" && i.text.includes("ship it")),
    ).toBe(true);
    expect(detail?.timeline.some((i) => i.kind === "thinking")).toBe(true);
  });

  it("rejects an unsafe subagent stem (path traversal)", async () => {
    expect(
      await readClaudeDetail("sess-parent:subagent:../../escape", { configDir: SUBAGENT_FIXTURE_ROOT }),
    ).toBeNull();
  });
});

describe("readClaudeSessions incremental", () => {
  // Build a throwaway store with one project dir + one session file we can mutate.
  async function makeStore(): Promise<{ configDir: string; file: string; cleanup: () => Promise<void> }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vault-claude-inc-"));
    const projDir = path.join(root, "projects", "-Users-me-proj");
    await fsp.mkdir(projDir, { recursive: true });
    const file = path.join(projDir, "sess-1.jsonl");
    await fsp.writeFile(
      file,
      [
        JSON.stringify({ type: "user", cwd: "/Users/me/proj", message: { content: "ORIGINAL prompt title" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8" } }),
      ].join("\n"),
    );
    return { configDir: root, file, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
  }

  it("reuses the cached entry without re-reading the body when (mtime,size) is unchanged", async () => {
    const { configDir, cleanup } = await makeStore();
    try {
      const first = await readClaudeSessions({ configDir });
      expect(first.entries).toHaveLength(1);
      expect(first.cache.kind).toBe("files");

      // Poison the cached entry's title: if the reader re-reads the body, it would
      // overwrite this with "ORIGINAL prompt title". Reuse must preserve it.
      const poisoned = structuredClone(first.cache);
      if (poisoned.kind === "files") {
        for (const k of Object.keys(poisoned.files)) {
          poisoned.files[k].entry = { ...poisoned.files[k].entry, title: "CACHED_TITLE" };
        }
      }
      const second = await readClaudeSessions({ configDir }, poisoned);
      expect(second.entries[0].title).toBe("CACHED_TITLE");
    } finally {
      await cleanup();
    }
  });

  it("re-reads a file whose mtime changed", async () => {
    const { configDir, file, cleanup } = await makeStore();
    try {
      const first = await readClaudeSessions({ configDir });
      const poisoned = structuredClone(first.cache);
      if (poisoned.kind === "files") {
        for (const k of Object.keys(poisoned.files)) {
          poisoned.files[k].entry = { ...poisoned.files[k].entry, title: "CACHED_TITLE" };
        }
      }
      // Bump mtime forward → stamp mismatch → rebuild from the (unchanged) body.
      const future = new Date(Date.now() + 60_000);
      await fsp.utimes(file, future, future);
      const second = await readClaudeSessions({ configDir }, poisoned);
      expect(second.entries[0].title).toBe("ORIGINAL prompt title");
    } finally {
      await cleanup();
    }
  });

  it("drops a cached entry whose file no longer exists", async () => {
    const { configDir, file, cleanup } = await makeStore();
    try {
      const first = await readClaudeSessions({ configDir });
      await fsp.rm(file);
      const second = await readClaudeSessions({ configDir }, first.cache);
      expect(second.entries).toHaveLength(0);
      if (second.cache.kind === "files") {
        expect(Object.keys(second.cache.files)).toHaveLength(0);
      }
    } finally {
      await cleanup();
    }
  });
});
