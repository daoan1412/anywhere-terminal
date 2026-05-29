// src/vault/readers/opencodeReader.ts — Read OpenCode sessions (SQLite only).
// See: specs/agent-session-index/spec.md (Read OpenCode sessions), design.md D3,D8,
//      docs/research/20260528-cmux-vault-mechanism.md §7.
//
// Source is the `session` table of ~/.local/share/opencode/opencode.db, with a
// correlated subquery for the latest assistant `message` to recover the model +
// agent. OpenCode has no JSONL fallback: an absent DB contributes zero entries.

import * as os from "node:os";
import * as path from "node:path";
import { boundedPreview } from "../preview";
import { readSqlite } from "../sqlite";
import type { VaultSessionEntry } from "../types";
import type { ReaderResult } from "./claudeReader";

/** Bound the read so the vault list stays cheap (D2). */
const ROW_LIMIT = 500;

const OPENCODE_SESSION_SQL = `SELECT s.id, s.title, s.directory, s.time_updated, (
    SELECT data FROM message
    WHERE session_id = s.id AND data LIKE '%"role":"assistant"%'
    ORDER BY time_created DESC LIMIT 1
) AS last_assistant
FROM session s
ORDER BY s.time_updated DESC
LIMIT ${ROW_LIMIT}`;

export interface OpenCodeReaderOptions {
  home?: string;
  /** Override `~/.local/share/opencode`. */
  dataDir?: string;
  /** Injectable for tests; defaults to the real WAL-safe reader. */
  readSqliteFn?: typeof readSqlite;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") {
    return v || undefined;
  }
  if (typeof v === "number") {
    return String(v);
  }
  return undefined;
}

/** Recover model (provider/model) + agent from the latest assistant message JSON. */
function parseAssistant(raw: unknown): { model?: string; agent?: string } {
  if (typeof raw !== "string" || !raw) {
    return {};
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      return {};
    }
    const providerID = asString(obj.providerID);
    const modelID = asString(obj.modelID);
    const agent = asString(obj.agent);
    const model = providerID && modelID ? `${providerID}/${modelID}` : (modelID ?? providerID);
    return { model, agent };
  } catch {
    return {}; // malformed assistant JSON → no model/agent, entry still listed (D8)
  }
}

function mapSessionRow(row: Record<string, unknown>): VaultSessionEntry | null {
  const sessionId = asString(row.id);
  if (!sessionId) {
    return null;
  }
  const { model, agent } = parseAssistant(row.last_assistant);
  return {
    id: `opencode:${sessionId}`,
    agent: "opencode",
    sessionId,
    title: boundedPreview(asString(row.title) ?? ""),
    cwd: asString(row.directory) ?? "",
    modified: Number(row.time_updated) || 0,
    flags: { model, agent },
    canFork: false, // resolved by VaultService (task 2_5)
  };
}

export async function readOpenCodeSessions(options: OpenCodeReaderOptions = {}): Promise<ReaderResult> {
  const home = options.home ?? os.homedir();
  // OpenCode resolves its data dir via the `xdg-basedir` package, which is the
  // SAME on every OS (it is NOT OS-aware): `$XDG_DATA_HOME/opencode` else
  // `~/.local/share/opencode` — including Windows (`%USERPROFILE%\.local\share`,
  // NOT %APPDATA%). Mirror that here. See docs/research/20260529-cross-platform-store-paths-sqlite.md.
  const xdgData = process.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const dataDir = options.dataDir ?? path.join(xdgData, "opencode");
  const dbPath = path.join(dataDir, "opencode.db");
  const readSqliteFn = options.readSqliteFn ?? readSqlite;

  const result = await readSqliteFn(dbPath, OPENCODE_SESSION_SQL);

  if (result.status === "query-error") {
    return { entries: [], unreadable: 1 };
  }
  if (result.status !== "ok") {
    return { entries: [], unreadable: 0 }; // no-db / no-sqlite3 → zero entries
  }

  const entries: VaultSessionEntry[] = [];
  let unreadable = 0;
  for (const row of result.rows) {
    const entry = mapSessionRow(row);
    if (entry) {
      entries.push(entry);
    } else {
      unreadable++;
    }
  }
  return { entries, unreadable };
}
