// src/vault/readers/opencodeReader.rename.test.ts — native rename write into
// OpenCode's session.title (write-vault-rename-to-store 2_1).

import { describe, expect, it, vi } from "vitest";
import type { writeSqlite } from "../sqlite";
import { renameOpenCodeSession } from "./opencodeReader";

function okWrite(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ status: "ok" as const, changes: 1 }));
}

describe("renameOpenCodeSession", () => {
  it("issues a parameterized UPDATE against session.title and returns true on ok", async () => {
    const writeSqliteFn = okWrite() as unknown as typeof writeSqlite;
    const ok = await renameOpenCodeSession("sess-1", "My Name", { dataDir: "/fake/oc", writeSqliteFn });
    expect(ok).toBe(true);
    expect(writeSqliteFn).toHaveBeenCalledWith(
      "/fake/oc/opencode.db",
      "UPDATE session SET title = ? WHERE id = ? AND (parent_id IS NULL OR parent_id = '')",
      ["My Name", "sess-1"],
    );
  });

  it("returns false and never writes for an unsafe session id", async () => {
    const writeSqliteFn = okWrite() as unknown as typeof writeSqlite;
    const ok = await renameOpenCodeSession("bad id;DROP", "X", { dataDir: "/fake/oc", writeSqliteFn });
    expect(ok).toBe(false);
    expect(writeSqliteFn).not.toHaveBeenCalled();
  });

  it("returns false when the write reports not-found (no row / overlay fallback)", async () => {
    const writeSqliteFn = vi.fn(async () => ({
      status: "not-found" as const,
      changes: 0,
    })) as unknown as typeof writeSqlite;
    const ok = await renameOpenCodeSession("sess-1", "X", { dataDir: "/fake/oc", writeSqliteFn });
    expect(ok).toBe(false);
  });

  it("returns false when the write reports no-sqlite3 (engine absent → overlay fallback)", async () => {
    const writeSqliteFn = vi.fn(async () => ({
      status: "no-sqlite3" as const,
      changes: 0,
    })) as unknown as typeof writeSqlite;
    const ok = await renameOpenCodeSession("sess-1", "X", { dataDir: "/fake/oc", writeSqliteFn });
    expect(ok).toBe(false);
  });
});
