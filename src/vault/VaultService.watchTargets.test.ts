// src/vault/VaultService.watchTargets.test.ts — FS-watch target resolution for
// auto-refresh (D4) and live-follow (D5). These globs/paths are what the host's
// watchers subscribe to, so they are contract-tested even though the watcher
// wiring itself is verified manually.

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { VaultService } from "./VaultService";

const svc = new VaultService();

describe("VaultService.getStoreWatchTargets", () => {
  const targets = svc.getStoreWatchTargets();

  it("covers all three stores with change-catching globs", () => {
    // Claude projects tree (append-grows via **/*.jsonl).
    const claude = targets.find((t) => t.baseDir.endsWith(path.join(".claude", "projects")));
    expect(claude?.glob).toBe("**/*.jsonl");

    // Codex: SQLite index (+ -wal/-shm via trailing *) AND the rollout JSONL tree.
    const codexDb = targets.find((t) => t.glob === "state_5.sqlite*");
    expect(codexDb).toBeDefined();
    const codexSessions = targets.find((t) => t.baseDir.endsWith("sessions") && t.glob === "**/*.jsonl");
    expect(codexSessions).toBeDefined();

    // OpenCode WAL DB (db + -wal/-shm).
    const opencode = targets.find((t) => t.glob === "opencode.db*");
    expect(opencode?.baseDir.endsWith("opencode")).toBe(true);
  });
});

describe("VaultService.resolveSessionWatchTargets", () => {
  it("scopes codex to the session's rollout file + the index db", async () => {
    const targets = await svc.resolveSessionWatchTargets("codex:abc-123");
    expect(targets.map((t) => t.glob)).toEqual(
      expect.arrayContaining(["**/*-abc-123.jsonl", "state_5.sqlite*"]),
    );
  });

  it("watches the opencode db for an opencode session", async () => {
    const targets = await svc.resolveSessionWatchTargets("opencode:sess1");
    expect(targets).toHaveLength(1);
    expect(targets[0].glob).toBe("opencode.db*");
  });

  it("returns nothing for an unknown agent", async () => {
    expect(await svc.resolveSessionWatchTargets("bogus:x")).toEqual([]);
  });

  it("rejects a glob-unsafe session id (no injection into the watch glob)", async () => {
    expect(await svc.resolveSessionWatchTargets("codex:../../*")).toEqual([]);
    expect(await svc.resolveSessionWatchTargets("codex:a/b")).toEqual([]);
  });
});
