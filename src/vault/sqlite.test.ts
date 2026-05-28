// src/vault/sqlite.test.ts — Unit tests for the WAL-safe sqlite3 helper.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSqliteProbeCache, readSqlite, type SqliteDeps } from "./sqlite";

function makeDeps(overrides: Partial<SqliteDeps> = {}): SqliteDeps {
  return {
    exec: vi.fn(async () => ({ stdout: "[]", stderr: "" })),
    exists: vi.fn(async () => true),
    copy: vi.fn(async () => {}),
    mkdtemp: vi.fn(async () => "/tmp/at-vault-xyz"),
    rmrf: vi.fn(async () => {}),
    ...overrides,
  };
}

/** An exec that answers the capability probe ok, then defers to `query`. */
function execWith(query: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>) {
  return vi.fn(async (file: string, args: string[]) => {
    if (args.includes(":memory:")) {
      return { stdout: "", stderr: "" };
    }
    return query(file, args);
  });
}

beforeEach(() => {
  __resetSqliteProbeCache();
});

describe("readSqlite: capability probe", () => {
  it("returns no-sqlite3 when the probe throws (binary missing / no -json)", async () => {
    const deps = makeDeps({
      exec: vi.fn(async () => {
        throw new Error("command not found: sqlite3");
      }),
    });
    const result = await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    expect(result.status).toBe("no-sqlite3");
    expect(result.rows).toEqual([]);
    // Never reached the db existence check / copy.
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it("memoizes the probe across calls", async () => {
    let probeCount = 0;
    const deps = makeDeps({
      exec: vi.fn(async (_file: string, args: string[]) => {
        if (args.includes(":memory:")) {
          probeCount++;
        }
        return { stdout: "[]", stderr: "" };
      }),
    });
    await readSqlite("/x/a.sqlite", "SELECT 1", deps);
    await readSqlite("/x/b.sqlite", "SELECT 1", deps);
    expect(probeCount).toBe(1);
  });
});

describe("readSqlite: store presence", () => {
  it("returns no-db when the store file is absent", async () => {
    const deps = makeDeps({
      exec: execWith(async () => ({ stdout: "[]", stderr: "" })),
      exists: vi.fn(async (p: string) => p.includes(":memory:")), // db absent
    });
    const result = await readSqlite("/x/missing.sqlite", "SELECT 1", deps);
    expect(result.status).toBe("no-db");
    expect(deps.copy).not.toHaveBeenCalled();
  });
});

describe("readSqlite: query execution", () => {
  it("returns ok + parsed rows for a valid JSON array", async () => {
    const rows = [{ id: "a", title: "x" }];
    const deps = makeDeps({
      exec: execWith(async () => ({ stdout: JSON.stringify(rows), stderr: "" })),
    });
    const result = await readSqlite("/x/state.sqlite", "SELECT id,title FROM t", deps);
    expect(result.status).toBe("ok");
    expect(result.rows).toEqual(rows);
  });

  it("treats empty stdout as ok with zero rows", async () => {
    const deps = makeDeps({ exec: execWith(async () => ({ stdout: "", stderr: "" })) });
    const result = await readSqlite("/x/state.sqlite", "SELECT 1 WHERE 0", deps);
    expect(result.status).toBe("ok");
    expect(result.rows).toEqual([]);
  });

  it("copies the db and its -wal/-shm sidecars before querying", async () => {
    const deps = makeDeps({
      exec: execWith(async () => ({ stdout: "[]", stderr: "" })),
      exists: vi.fn(async () => true), // db + both sidecars present
    });
    await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    const copyCalls = (deps.copy as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(copyCalls).toContain("/x/state.sqlite");
    expect(copyCalls).toContain("/x/state.sqlite-wal");
    expect(copyCalls).toContain("/x/state.sqlite-shm");
  });

  it("runs the query read-only over the temp copy, not the live db", async () => {
    const deps = makeDeps({ exec: execWith(async () => ({ stdout: "[]", stderr: "" })) });
    await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    const queryCall = (deps.exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => !c[1].includes(":memory:"));
    expect(queryCall?.[1]).toEqual(["-readonly", "-json", "/tmp/at-vault-xyz/db.sqlite", "SELECT 1"]);
  });

  it("returns query-error + message when stdout is not valid JSON (after retry)", async () => {
    const deps = makeDeps({ exec: execWith(async () => ({ stdout: "not json", stderr: "" })) });
    const result = await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    expect(result.status).toBe("query-error");
    expect(result.error).toBeTruthy();
    expect(result.rows).toEqual([]);
  });

  it("returns query-error when stdout is a JSON object, not an array", async () => {
    const deps = makeDeps({ exec: execWith(async () => ({ stdout: '{"id":"a"}', stderr: "" })) });
    const result = await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    expect(result.status).toBe("query-error");
  });

  it("retries the query once, succeeding on the second attempt", async () => {
    let calls = 0;
    const deps = makeDeps({
      exec: execWith(async () => {
        calls++;
        if (calls === 1) {
          throw new Error("database is locked");
        }
        return { stdout: '[{"id":"ok"}]', stderr: "" };
      }),
    });
    const result = await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    expect(result.status).toBe("ok");
    expect(result.rows).toEqual([{ id: "ok" }]);
    expect(calls).toBe(2);
  });

  it("always removes the temp dir, even on query failure", async () => {
    const deps = makeDeps({
      exec: execWith(async () => {
        throw new Error("boom");
      }),
    });
    await readSqlite("/x/state.sqlite", "SELECT 1", deps);
    expect(deps.rmrf).toHaveBeenCalledWith("/tmp/at-vault-xyz");
  });
});
