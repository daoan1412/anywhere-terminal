// src/vault/storeStamp.test.ts — Stamp + equality helpers (cache-vault-load 2_2/2_3).

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sameStamps, stampStoreFiles } from "./storeStamp";

describe("sameStamps", () => {
  it("is true for identical stamp sets", () => {
    const a = { "/db": { mtimeMs: 1, size: 2 }, "/db-wal": { mtimeMs: 3, size: 4 } };
    const b = { "/db": { mtimeMs: 1, size: 2 }, "/db-wal": { mtimeMs: 3, size: 4 } };
    expect(sameStamps(a, b)).toBe(true);
  });

  it("is false when an mtime or size differs", () => {
    expect(sameStamps({ "/db": { mtimeMs: 1, size: 2 } }, { "/db": { mtimeMs: 9, size: 2 } })).toBe(false);
    expect(sameStamps({ "/db": { mtimeMs: 1, size: 2 } }, { "/db": { mtimeMs: 1, size: 9 } })).toBe(false);
  });

  it("is false when the path set differs (e.g. -wal appears/disappears)", () => {
    expect(
      sameStamps(
        { "/db": { mtimeMs: 1, size: 2 } },
        { "/db": { mtimeMs: 1, size: 2 }, "/db-wal": { mtimeMs: 1, size: 1 } },
      ),
    ).toBe(false);
  });

  it("treats two empty sets as equal (no DB present both times)", () => {
    expect(sameStamps({}, {})).toBe(true);
  });
});

describe("stampStoreFiles", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("stamps existing files and omits missing ones", async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vault-stamp-"));
    const db = path.join(dir, "store.db");
    await fsp.writeFile(db, "hello");
    const stamps = await stampStoreFiles([db, `${db}-wal`]);
    expect(Object.keys(stamps)).toEqual([db]);
    expect(stamps[db].size).toBe(5);
    expect(stamps[db].mtimeMs).toBeGreaterThan(0);
  });
});
