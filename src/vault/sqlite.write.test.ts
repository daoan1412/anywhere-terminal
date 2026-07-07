// src/vault/sqlite.write.test.ts — Unit tests for the live-DB writeSqlite helper
// (write-vault-rename-to-store D2).

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { type SqliteWriteDeps, writeSqlite } from "./sqlite";

function makeDeps(overrides: Partial<SqliteWriteDeps> = {}): SqliteWriteDeps {
  return {
    exists: vi.fn(async () => true),
    hasNodeSqlite: vi.fn(async () => true),
    runNodeWrite: vi.fn(async () => ({ status: "ok" as const, changes: 1 })),
    ...overrides,
  };
}

describe("writeSqlite: status mapping", () => {
  it("returns no-sqlite3 (no write attempted) when node:sqlite is absent", async () => {
    const deps = makeDeps({ hasNodeSqlite: vi.fn(async () => false) });
    const result = await writeSqlite("/x/opencode.db", "UPDATE session SET title=? WHERE id=?", ["Foo", "s1"], deps);
    expect(result.status).toBe("no-sqlite3");
    expect(result.changes).toBe(0);
    expect(deps.exists).not.toHaveBeenCalled();
    expect(deps.runNodeWrite).not.toHaveBeenCalled();
  });

  it("returns no-db when the store file is absent (no write attempted)", async () => {
    const deps = makeDeps({ exists: vi.fn(async () => false) });
    const result = await writeSqlite("/x/missing.db", "UPDATE t SET title=? WHERE id=?", ["Foo", "s1"], deps);
    expect(result.status).toBe("no-db");
    expect(deps.runNodeWrite).not.toHaveBeenCalled();
  });

  it("passes the sql + bound params through to the writer and returns ok", async () => {
    const runNodeWrite = vi.fn(async () => ({ status: "ok" as const, changes: 1 }));
    const deps = makeDeps({ runNodeWrite });
    const sql = "UPDATE session SET title = ? WHERE id = ?";
    const result = await writeSqlite("/x/opencode.db", sql, ["My Name", "sess-1"], deps);
    expect(result).toEqual({ status: "ok", changes: 1 });
    expect(runNodeWrite).toHaveBeenCalledWith("/x/opencode.db", sql, ["My Name", "sess-1"]);
  });

  it("propagates not-found (zero rows matched)", async () => {
    const deps = makeDeps({ runNodeWrite: vi.fn(async () => ({ status: "not-found" as const, changes: 0 })) });
    const result = await writeSqlite("/x/opencode.db", "UPDATE t SET title=? WHERE id=?", ["Foo", "nope"], deps);
    expect(result.status).toBe("not-found");
  });

  it("propagates write-error with its message", async () => {
    const deps = makeDeps({
      runNodeWrite: vi.fn(async () => ({ status: "write-error" as const, changes: 0, error: "boom" })),
    });
    const result = await writeSqlite("/x/opencode.db", "UPDATE t SET title=? WHERE id=?", ["Foo", "s1"], deps);
    expect(result.status).toBe("write-error");
    expect(result.error).toBe("boom");
  });
});

describe("writeSqlite: real node:sqlite round-trip", () => {
  it("persists the new title to a real on-disk db and reports changes=1", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "at-vault-write-"));
    const dbFile = path.join(dir, "real.db");
    const seed = new DatabaseSync(dbFile);
    seed.exec("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT)");
    seed.exec("INSERT INTO session VALUES ('s1', 'Old Title')");
    seed.close();

    try {
      // Real deps: exists via fs, real node probe + real writer.
      const result = await writeSqlite(dbFile, "UPDATE session SET title = ? WHERE id = ?", ["New Title", "s1"], {
        exists: async (p) => {
          try {
            await fsp.access(p);
            return true;
          } catch {
            return false;
          }
        },
        hasNodeSqlite: async () => true,
        // no runNodeWrite override → exercises the real defaultRunNodeWrite
      });
      expect(result).toEqual({ status: "ok", changes: 1 });

      const check = new DatabaseSync(dbFile);
      const row = check.prepare("SELECT title FROM session WHERE id = ?").get("s1") as { title: string };
      check.close();
      expect(row.title).toBe("New Title");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("maps an UPDATE that matches no row to not-found (real engine)", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "at-vault-write-"));
    const dbFile = path.join(dir, "real.db");
    const seed = new DatabaseSync(dbFile);
    seed.exec("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT)");
    seed.exec("INSERT INTO session VALUES ('s1', 'Old Title')");
    seed.close();

    try {
      const result = await writeSqlite(dbFile, "UPDATE session SET title = ? WHERE id = ?", ["X", "missing"], {
        exists: async () => true,
        hasNodeSqlite: async () => true,
      });
      expect(result).toEqual({ status: "not-found", changes: 0 });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
