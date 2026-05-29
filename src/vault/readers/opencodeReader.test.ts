// src/vault/readers/opencodeReader.test.ts — Unit tests for the OpenCode reader.

import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteResult } from "../sqlite";
import { readOpenCodeSessions } from "./opencodeReader";

function stubSqlite(result: SqliteResult) {
  return vi.fn(async (_dbPath: string, _sql: string) => result);
}

const ROWS: Record<string, unknown>[] = [
  {
    id: "s1",
    title: "build a thing",
    directory: "/Users/me/oc",
    time_updated: 5000,
    last_assistant: JSON.stringify({ providerID: "anthropic", modelID: "claude-opus-4-7", agent: "build" }),
  },
  {
    id: "s2",
    title: "another",
    directory: "/Users/me/oc2",
    time_updated: 4000,
    last_assistant: "{ this is not valid json",
  },
];

describe("readOpenCodeSessions", () => {
  it("queries the session table joined to the latest assistant message, recency-ordered", async () => {
    const fn = stubSqlite({ status: "ok", rows: ROWS });
    await readOpenCodeSessions({ dataDir: "/x/oc", readSqliteFn: fn });
    const [dbPath, sql] = fn.mock.calls[0];
    expect(dbPath).toBe("/x/oc/opencode.db");
    expect(sql).toContain("FROM session s");
    expect(sql).toContain('data LIKE \'%"role":"assistant"%\'');
    expect(sql).toContain("ORDER BY s.time_updated DESC");
  });

  it("maps id/title/cwd/modified and derives provider/model + agent", async () => {
    const fn = stubSqlite({ status: "ok", rows: ROWS });
    const { entries } = await readOpenCodeSessions({ dataDir: "/x/oc", readSqliteFn: fn });
    const s1 = entries[0];
    expect(s1.id).toBe("opencode:s1");
    expect(s1.sessionId).toBe("s1");
    expect(s1.title).toBe("build a thing");
    expect(s1.cwd).toBe("/Users/me/oc");
    expect(s1.modified).toBe(5000);
    expect(s1.flags.model).toBe("anthropic/claude-opus-4-7");
    expect(s1.flags.agent).toBe("build");
  });

  it("still lists a session whose assistant JSON is malformed (model/agent undefined)", async () => {
    const fn = stubSqlite({ status: "ok", rows: ROWS });
    const { entries, unreadable } = await readOpenCodeSessions({ dataDir: "/x/oc", readSqliteFn: fn });
    expect(entries).toHaveLength(2);
    expect(unreadable).toBe(0);
    expect(entries[1].flags.model).toBeUndefined();
    expect(entries[1].flags.agent).toBeUndefined();
  });

  it("skips and counts rows without an id", async () => {
    const fn = stubSqlite({ status: "ok", rows: [{ title: "no id" }, ROWS[0]] });
    const { entries, unreadable } = await readOpenCodeSessions({ dataDir: "/x/oc", readSqliteFn: fn });
    expect(entries).toHaveLength(1);
    expect(unreadable).toBe(1);
  });

  it("returns zero entries (no fallback) when the DB is absent", async () => {
    const fn = stubSqlite({ status: "no-db", rows: [] });
    const { entries, unreadable } = await readOpenCodeSessions({ dataDir: "/x/oc", readSqliteFn: fn });
    expect(entries).toEqual([]);
    expect(unreadable).toBe(0);
  });

  it("counts a query-error as one unreadable", async () => {
    const fn = stubSqlite({ status: "query-error", rows: [], error: "boom" });
    const { entries, unreadable } = await readOpenCodeSessions({ dataDir: "/x/oc", readSqliteFn: fn });
    expect(entries).toEqual([]);
    expect(unreadable).toBe(1);
  });
});

describe("readOpenCodeSessions: data-dir resolution", () => {
  const original = process.env.XDG_DATA_HOME;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = original;
    }
  });

  it("defaults to <home>/.local/share/opencode/opencode.db (all OSes, via xdg-basedir)", async () => {
    delete process.env.XDG_DATA_HOME;
    const fn = stubSqlite({ status: "ok", rows: [] });
    await readOpenCodeSessions({ home: "/home/u", readSqliteFn: fn });
    expect(fn.mock.calls[0][0]).toBe(path.join("/home/u", ".local", "share", "opencode", "opencode.db"));
  });

  it("honors $XDG_DATA_HOME", async () => {
    process.env.XDG_DATA_HOME = "/custom/xdg";
    const fn = stubSqlite({ status: "ok", rows: [] });
    await readOpenCodeSessions({ home: "/home/u", readSqliteFn: fn });
    expect(fn.mock.calls[0][0]).toBe(path.join("/custom/xdg", "opencode", "opencode.db"));
  });
});
