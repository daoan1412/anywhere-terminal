// src/vault/readers/codexReader.test.ts — Unit tests for the Codex reader.

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteResult } from "../sqlite";
import { readCodexEntry, readCodexSessions } from "./codexReader";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CODEX_DIR = path.join(here, "..", "__fixtures__", "codex");

function stubSqlite(result: SqliteResult) {
  return vi.fn(async (_dbPath: string, _sql: string) => result);
}

const SAMPLE_ROWS: Record<string, unknown>[] = [
  {
    id: "t1",
    rollout_path: "/r/t1.jsonl",
    cwd: "/Users/me/a",
    title: "first thread",
    model: "gpt-5-codex",
    git_branch: "main",
    approval_mode: "on-request",
    sandbox_policy: '{"type":"workspace-write"}',
    reasoning_effort: "high",
    first_user_message: "ignored because title present",
    updated_at_ms: 2000,
  },
  {
    id: "t2",
    cwd: "/Users/me/b",
    title: "",
    first_user_message: "second thread first message",
    updated_at_ms: 1000,
  },
];

describe("readCodexSessions: SQLite path", () => {
  it("queries the threads table with archived filter + recency order", async () => {
    const fn = stubSqlite({ status: "ok", rows: SAMPLE_ROWS });
    await readCodexSessions({ codexDir: "/x/.codex", readSqliteFn: fn });
    const [dbPath, sql] = fn.mock.calls[0];
    expect(dbPath).toBe("/x/.codex/state_5.sqlite");
    expect(sql).toContain("FROM threads");
    expect(sql).toContain("archived = 0");
    expect(sql).toContain("ORDER BY updated_at_ms DESC");
  });

  it("maps thread rows to entries with flags", async () => {
    const fn = stubSqlite({ status: "ok", rows: SAMPLE_ROWS });
    const { entries, unreadable } = await readCodexSessions({ codexDir: "/x/.codex", readSqliteFn: fn });
    expect(unreadable).toBe(0);
    expect(entries).toHaveLength(2);
    const t1 = entries[0];
    expect(t1.id).toBe("codex:t1");
    expect(t1.title).toBe("first thread");
    expect(t1.flags).toEqual({
      model: "gpt-5-codex",
      approval: "on-request",
      sandbox: "workspace-write",
      reasoningEffort: "high",
    });
  });

  it("falls back to first_user_message when title is empty", async () => {
    const fn = stubSqlite({ status: "ok", rows: SAMPLE_ROWS });
    const { entries } = await readCodexSessions({ codexDir: "/x/.codex", readSqliteFn: fn });
    expect(entries[1].title).toBe("second thread first message");
  });

  it("skips and counts rows without an id", async () => {
    const fn = stubSqlite({ status: "ok", rows: [{ cwd: "/no/id" }, SAMPLE_ROWS[0]] });
    const { entries, unreadable } = await readCodexSessions({ codexDir: "/x/.codex", readSqliteFn: fn });
    expect(entries).toHaveLength(1);
    expect(unreadable).toBe(1);
  });
});

describe("readCodexSessions: fallback + errors", () => {
  it("falls back to JSONL scan when the DB is absent", async () => {
    const fn = stubSqlite({ status: "no-db", rows: [] });
    const { entries } = await readCodexSessions({ codexDir: FIXTURE_CODEX_DIR, readSqliteFn: fn });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("codex:codex-sess-1");
    expect(entries[0].cwd).toBe("/Users/me/codexproj");
  });

  it("falls back to JSONL scan when sqlite3 is unavailable", async () => {
    const fn = stubSqlite({ status: "no-sqlite3", rows: [] });
    const { entries } = await readCodexSessions({ codexDir: FIXTURE_CODEX_DIR, readSqliteFn: fn });
    expect(entries).toHaveLength(1);
  });

  it("does NOT fall back on query-error — surfaces it as unreadable", async () => {
    const fn = stubSqlite({ status: "query-error", rows: [], error: "boom" });
    const { entries, unreadable } = await readCodexSessions({ codexDir: FIXTURE_CODEX_DIR, readSqliteFn: fn });
    expect(entries).toEqual([]);
    expect(unreadable).toBe(1);
  });

  it("returns zero entries when fallback dir is also absent", async () => {
    const fn = stubSqlite({ status: "no-db", rows: [] });
    const { entries, unreadable } = await readCodexSessions({ codexDir: "/nonexistent/.codex", readSqliteFn: fn });
    expect(entries).toEqual([]);
    expect(unreadable).toBe(0);
  });
});

describe("readCodexEntry: single-entry resolve", () => {
  it("resolves one thread by id (point lookup on the threads table)", async () => {
    const fn = stubSqlite({ status: "ok", rows: [SAMPLE_ROWS[0]] });
    const entry = await readCodexEntry("t1", { codexDir: "/x/.codex", readSqliteFn: fn });
    const [dbPath, sql] = fn.mock.calls[0];
    expect(dbPath).toBe("/x/.codex/state_5.sqlite");
    expect(sql).toContain("WHERE id = 't1'");
    expect(entry?.id).toBe("codex:t1");
    expect(entry?.flags.model).toBe("gpt-5-codex");
  });

  it("returns null for an unsafe id without touching the db", async () => {
    const fn = stubSqlite({ status: "ok", rows: [] });
    expect(await readCodexEntry("../escape", { codexDir: "/x/.codex", readSqliteFn: fn })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns null when the thread row is missing", async () => {
    const fn = stubSqlite({ status: "ok", rows: [] });
    expect(await readCodexEntry("ghost", { codexDir: "/x/.codex", readSqliteFn: fn })).toBeNull();
  });

  it("returns null (no throw) when no DB and no rollout matches the id", async () => {
    const fn = stubSqlite({ status: "no-db", rows: [] });
    expect(await readCodexEntry("no-such-uuid", { codexDir: FIXTURE_CODEX_DIR, readSqliteFn: fn })).toBeNull();
  });
});

describe("readCodexSessions: home resolution", () => {
  const orig = { home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME };
  afterEach(() => {
    for (const [key, value] of [
      ["CODEX_HOME", orig.home],
      ["CODEX_SQLITE_HOME", orig.sqlite],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("defaults to <home>/.codex/state_5.sqlite (correct on Windows via os.homedir)", async () => {
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SQLITE_HOME;
    const fn = stubSqlite({ status: "ok", rows: [] });
    await readCodexSessions({ home: "/home/u", readSqliteFn: fn });
    expect(fn.mock.calls[0][0]).toBe(path.join("/home/u", ".codex", "state_5.sqlite"));
  });

  it("honors $CODEX_HOME for both the DB and the sessions dir", async () => {
    process.env.CODEX_HOME = path.join(os.tmpdir(), "codex-home-does-not-exist");
    delete process.env.CODEX_SQLITE_HOME;
    const fn = stubSqlite({ status: "ok", rows: [] });
    await readCodexSessions({ readSqliteFn: fn });
    expect(fn.mock.calls[0][0]).toBe(path.join(process.env.CODEX_HOME as string, "state_5.sqlite"));
  });

  it("relocates only the DB via $CODEX_SQLITE_HOME", async () => {
    process.env.CODEX_HOME = "/codex/home";
    process.env.CODEX_SQLITE_HOME = "/codex/db";
    const fn = stubSqlite({ status: "ok", rows: [] });
    await readCodexSessions({ readSqliteFn: fn });
    expect(fn.mock.calls[0][0]).toBe(path.join("/codex/db", "state_5.sqlite"));
  });
});
