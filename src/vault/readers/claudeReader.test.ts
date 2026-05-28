// src/vault/readers/claudeReader.test.ts — Unit tests over captured fixtures.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readClaudeSessions } from "./claudeReader";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(here, "..", "__fixtures__", "claude");

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

  it("captures the title from the first user message, model from the first assistant", async () => {
    const { entries } = await readClaudeSessions({ configDir: FIXTURE_ROOT });
    expect(entries[0].title.startsWith("Please help me build a really long prompt")).toBe(true);
  });

  it("bounds the title to <=120 chars and strips newlines (D4)", async () => {
    const { entries } = await readClaudeSessions({ configDir: FIXTURE_ROOT });
    expect(entries[0].title.length).toBeLessThanOrEqual(120);
    expect(entries[0].title).not.toContain("\n");
  });

  it("returns zero entries (not an error) when the projects dir is absent", async () => {
    const { entries, unreadable } = await readClaudeSessions({ configDir: "/nonexistent/claude/root" });
    expect(entries).toEqual([]);
    expect(unreadable).toBe(0);
  });
});
