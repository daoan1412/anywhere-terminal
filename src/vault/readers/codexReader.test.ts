// src/vault/readers/codexReader.test.ts — Unit tests for the Codex reader.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SqliteResult } from "../sqlite";
import { readCodexSessions } from "./codexReader";

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
