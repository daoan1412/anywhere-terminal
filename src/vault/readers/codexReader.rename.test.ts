// src/vault/readers/codexReader.rename.test.ts — native rename write into
// Codex threads.title (write-vault-rename-to-store 2_2).

import { describe, expect, it, vi } from "vitest";
import type { writeSqlite } from "../sqlite";
import { renameCodexThread } from "./codexReader";

function okWrite(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ status: "ok" as const, changes: 1 }));
}

describe("renameCodexThread", () => {
  it("issues a parameterized UPDATE scoped to non-archived threads and returns true on ok", async () => {
    const writeSqliteFn = okWrite() as unknown as typeof writeSqlite;
    const ok = await renameCodexThread("thread-1", "My Name", { codexDir: "/fake/codex", writeSqliteFn });
    expect(ok).toBe(true);
    const [dbPath, sql, params] = (writeSqliteFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(dbPath).toBe("/fake/codex/state_5.sqlite");
    expect(sql).toBe("UPDATE threads SET title = ? WHERE id = ? AND archived = 0");
    expect(params).toEqual(["My Name", "thread-1"]);
  });

  it("returns false and never writes for an unsafe thread id", async () => {
    const writeSqliteFn = okWrite() as unknown as typeof writeSqlite;
    const ok = await renameCodexThread("bad id'", "X", { codexDir: "/fake/codex", writeSqliteFn });
    expect(ok).toBe(false);
    expect(writeSqliteFn).not.toHaveBeenCalled();
  });

  it("returns false when the write reports not-found (archived/missing row → overlay fallback)", async () => {
    const writeSqliteFn = vi.fn(async () => ({ status: "not-found" as const, changes: 0 })) as unknown as typeof writeSqlite;
    const ok = await renameCodexThread("thread-1", "X", { codexDir: "/fake/codex", writeSqliteFn });
    expect(ok).toBe(false);
  });
});
