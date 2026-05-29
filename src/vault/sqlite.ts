// src/vault/sqlite.ts — WAL-safe, read-only SQLite access via the host `sqlite3`
// CLI (no new native dependency). See: design.md D3,
// specs/agent-session-index/spec.md (WAL-safe read-only SQLite access),
// docs/research/20260528-cmux-vault-mechanism.md §4,§7.
//
// We copy the live DB + its `-wal`/`-shm` sidecars into a temp dir and query the
// copy in read-only JSON mode, so a running agent's writes are never disturbed
// and a checkpoint mid-read can't corrupt our snapshot. The query string is
// always static (search/filter happens client-side), and it is passed as a
// single argv element to `execFile` — no shell, no interpolation, no injection.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Capability probe — short, since a missing/old `sqlite3` should fail fast. */
const PROBE_TIMEOUT_MS = 2000;
/** Per-query cap so a hung `sqlite3` can't stall the vault list. */
const QUERY_TIMEOUT_MS = 5000;
/** `sqlite3 -json` output is bounded by the readers' LIMITs; keep headroom. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type SqliteStatus = "ok" | "no-db" | "no-sqlite3" | "query-error";

export interface SqliteResult {
  rows: Record<string, unknown>[];
  status: SqliteStatus;
  /** Populated only for `query-error`. */
  error?: string;
}

/** Injectable IO surface — tests stub this to avoid real fs / child_process. */
export interface SqliteDeps {
  exec(file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }>;
  exists(p: string): Promise<boolean>;
  copy(src: string, dest: string): Promise<void>;
  mkdtemp(): Promise<string>;
  rmrf(dir: string): Promise<void>;
  /**
   * Whether the in-process `node:sqlite` engine is usable. Defaults to a
   * memoized real probe. Used only as a fallback when the `sqlite3` CLI is
   * absent (typically Windows). Tests stub it to isolate the CLI path.
   */
  hasNodeSqlite?(): Promise<boolean>;
  /**
   * Query the copied DB with `node:sqlite` instead of the CLI. Defaults to the
   * real engine. Tests stub it to avoid touching a real sqlite file.
   */
  runNodeQuery?(dbCopy: string, sql: string): Promise<SqliteResult>;
}

const defaultDeps: SqliteDeps = {
  exec: (file, args, options) =>
    execFileAsync(file, args, { timeout: options.timeout, maxBuffer: MAX_BUFFER_BYTES }).then(({ stdout, stderr }) => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    })),
  exists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  copy: (src, dest) => fs.copyFile(src, dest),
  mkdtemp: () => fs.mkdtemp(path.join(os.tmpdir(), "at-vault-")),
  rmrf: (dir) => fs.rm(dir, { recursive: true, force: true }),
};

let probePromise: Promise<boolean> | undefined;
let nodeProbePromise: Promise<boolean> | undefined;

/** Reset the memoized capability probes — tests only. */
export function __resetSqliteProbeCache(): void {
  probePromise = undefined;
  nodeProbePromise = undefined;
}

/**
 * Probe once whether `sqlite3` exists AND supports `-json` (older builds don't).
 * `:memory:` avoids touching any file. Memoized: the first caller's `deps.exec`
 * decides the cached result for the process lifetime.
 */
function probeSqlite(deps: SqliteDeps): Promise<boolean> {
  if (!probePromise) {
    probePromise = (async () => {
      try {
        await deps.exec("sqlite3", ["-readonly", "-json", ":memory:", "select 1"], { timeout: PROBE_TIMEOUT_MS });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return probePromise;
}

/**
 * Probe once whether the built-in `node:sqlite` module is importable (Node
 * 22.5+). VS Code's Electron host ships a recent enough Node, but the dynamic
 * import is guarded so an older/locked-down runtime degrades to `no-sqlite3`
 * rather than throwing. Memoized.
 */
function probeNodeSqlite(deps: SqliteDeps): Promise<boolean> {
  if (deps.hasNodeSqlite) {
    return deps.hasNodeSqlite();
  }
  if (!nodeProbePromise) {
    nodeProbePromise = (async () => {
      try {
        const mod = await import("node:sqlite");
        return typeof mod.DatabaseSync === "function";
      } catch {
        return false;
      }
    })();
  }
  return nodeProbePromise;
}

/**
 * Run `sql` against the copied DB using `node:sqlite`. The copy is a disposable
 * temp file, so we open it read-WRITE: that lets SQLite replay the copied
 * `-wal` sidecar (read-only opens can fail when the `-shm` can't be created)
 * without ever touching the user's live store. Never throws.
 */
async function defaultRunNodeQuery(dbCopy: string, sql: string): Promise<SqliteResult> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbCopy);
    try {
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
      return { rows: rows.map(normalizeRow), status: "ok" };
    } finally {
      db.close();
    }
  } catch (err) {
    return { rows: [], status: "query-error", error: errorMessage(err) };
  }
}

/**
 * Coerce a `node:sqlite` row into the JSON-ish shapes the readers expect
 * (matching the CLI's `-json` output): BIGINT columns can come back as
 * `bigint`, blobs as `Uint8Array`. The readers only consume text + ms
 * timestamps (well within Number range), so a `bigint → number` coercion is
 * safe; blobs are left as-is (readers ignore them).
 */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runQuery(deps: SqliteDeps, dbCopy: string, sql: string): Promise<SqliteResult> {
  let lastError: string | undefined;
  // One retry: a transient exec failure or a torn JSON read shouldn't drop the
  // whole agent.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await deps.exec("sqlite3", ["-readonly", "-json", dbCopy, sql], { timeout: QUERY_TIMEOUT_MS });
      const trimmed = stdout.trim();
      // `sqlite3 -json` prints nothing for a zero-row result.
      if (trimmed === "") {
        return { rows: [], status: "ok" };
      }
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        lastError = "sqlite3 did not return a JSON array";
        continue;
      }
      return { rows: parsed as Record<string, unknown>[], status: "ok" };
    } catch (err) {
      lastError = errorMessage(err);
    }
  }
  return { rows: [], status: "query-error", error: lastError };
}

/**
 * Read `sql` (a STATIC query) from the SQLite store at `dbPath`, WAL-safe and
 * read-only. Never throws — every failure mode maps to a discriminated status:
 * - `no-sqlite3` — host has no usable `sqlite3 -json`
 * - `no-db`      — the store file is absent
 * - `query-error`— copy/exec/parse failed (the `error` field carries detail)
 * - `ok`         — `rows` holds the parsed result (possibly empty)
 */
export async function readSqlite(dbPath: string, sql: string, deps: SqliteDeps = defaultDeps): Promise<SqliteResult> {
  // Pick an engine: the host `sqlite3` CLI (preferred — proven here, replays
  // WAL natively) or, when that's absent (typically Windows), the in-process
  // `node:sqlite` built-in. Neither → `no-sqlite3` (graceful empty, no crash).
  const useCli = await probeSqlite(deps);
  const useNode = useCli ? false : await probeNodeSqlite(deps);
  if (!useCli && !useNode) {
    return { rows: [], status: "no-sqlite3" };
  }

  let exists = false;
  try {
    exists = await deps.exists(dbPath);
  } catch {
    exists = false;
  }
  if (!exists) {
    return { rows: [], status: "no-db" };
  }

  let tempDir: string | undefined;
  try {
    tempDir = await deps.mkdtemp();
    const dbCopy = path.join(tempDir, "db.sqlite");
    await deps.copy(dbPath, dbCopy);
    // Copy WAL/SHM sidecars when present so the snapshot is consistent.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = dbPath + suffix;
      try {
        if (await deps.exists(sidecar)) {
          await deps.copy(sidecar, dbCopy + suffix);
        }
      } catch {
        // A missing/locked sidecar isn't fatal — query the base copy.
      }
    }
    return useCli ? await runQuery(deps, dbCopy, sql) : await (deps.runNodeQuery ?? defaultRunNodeQuery)(dbCopy, sql);
  } catch (err) {
    return { rows: [], status: "query-error", error: errorMessage(err) };
  } finally {
    if (tempDir) {
      await deps.rmrf(tempDir).catch(() => {});
    }
  }
}
