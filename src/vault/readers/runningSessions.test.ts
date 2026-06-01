// src/vault/readers/runningSessions.test.ts — Unit tests for the PID-registry reader.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRunningClaudeSessions, type RunningSessionsDeps } from "./runningSessions";

let tmpRoot: string;
let sessionsDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anywhere-running-"));
  sessionsDir = path.join(tmpRoot, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Write a `<pid>.json` registry file. */
async function writePidFile(pid: number, body: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(sessionsDir, `${pid}.json`), JSON.stringify(body), "utf8");
}

/** configDir points claudeRoots at our temp `.claude`-equivalent; sessions sit beside projects. */
function opts() {
  return { configDir: tmpRoot };
}

function aliveDeps(alivePids: number[]): RunningSessionsDeps {
  return { isAlive: vi.fn((pid: number) => alivePids.includes(pid)) };
}

describe("listRunningClaudeSessions", () => {
  it("returns one entry per live pid file, keyed fields intact", async () => {
    await writePidFile(100, { pid: 100, sessionId: "sess-a", cwd: "/work/a", startedAt: 111 });
    await writePidFile(200, { pid: 200, sessionId: "sess-b", cwd: "/work/b", startedAt: 222 });

    const result = await listRunningClaudeSessions(opts(), aliveDeps([100, 200]));

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { pid: 100, sessionId: "sess-a", cwd: "/work/a", startedAt: 111 },
        { pid: 200, sessionId: "sess-b", cwd: "/work/b", startedAt: 222 },
      ]),
    );
  });

  it("skips stale (dead-pid) files", async () => {
    await writePidFile(100, { pid: 100, sessionId: "live", cwd: "/work/a" });
    await writePidFile(200, { pid: 200, sessionId: "dead", cwd: "/work/b" });

    const result = await listRunningClaudeSessions(opts(), aliveDeps([100]));

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("live");
  });

  it("omits startedAt when absent and tolerates missing optional fields", async () => {
    await writePidFile(100, { pid: 100, sessionId: "live", cwd: "/work/a" });
    const [entry] = await listRunningClaudeSessions(opts(), aliveDeps([100]));
    expect(entry).toEqual({ pid: 100, sessionId: "live", cwd: "/work/a" });
    expect("startedAt" in entry).toBe(false);
  });

  it("skips malformed JSON and non-<pid>.json names without failing the scan", async () => {
    await writePidFile(100, { pid: 100, sessionId: "ok", cwd: "/work/a" });
    await fs.writeFile(path.join(sessionsDir, "300.json"), "{ not json", "utf8");
    await fs.writeFile(path.join(sessionsDir, "notes.json"), JSON.stringify({ pid: 1, sessionId: "x", cwd: "/y" }), "utf8");
    await fs.writeFile(path.join(sessionsDir, "999.txt"), "ignored", "utf8");

    const result = await listRunningClaudeSessions(opts(), aliveDeps([100, 300, 1]));

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("ok");
  });

  it("skips files missing required fields (no sessionId / cwd / pid)", async () => {
    await writePidFile(100, { pid: 100, cwd: "/work/a" }); // no sessionId
    await writePidFile(200, { pid: 200, sessionId: "no-cwd" }); // no cwd
    await writePidFile(300, { sessionId: "no-pid", cwd: "/work/c" }); // no pid

    const result = await listRunningClaudeSessions(opts(), aliveDeps([100, 200, 300]));
    expect(result).toHaveLength(0);
  });

  it("dedupes by sessionId, keeping the newest startedAt", async () => {
    await writePidFile(100, { pid: 100, sessionId: "dup", cwd: "/work/a", startedAt: 10 });
    await writePidFile(200, { pid: 200, sessionId: "dup", cwd: "/work/a2", startedAt: 99 });

    const result = await listRunningClaudeSessions(opts(), aliveDeps([100, 200]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 200, startedAt: 99 });
  });

  it("returns [] when the registry dir does not exist", async () => {
    await fs.rm(sessionsDir, { recursive: true, force: true });
    expect(await listRunningClaudeSessions(opts(), aliveDeps([]))).toEqual([]);
  });
});
