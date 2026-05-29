// src/vault/VaultService.ts — Aggregate per-agent readers into one recency-sorted,
// metadata-only session list with resolved fork support.
// See: specs/agent-session-index/spec.md (Aggregate and sort; Defensive parsing),
//      specs/vault-session-launch/spec.md (Fork when supported), design.md D2,D8.

import { canForkOpenCode } from "./forkSupport";
import type { ReaderResult } from "./readers/claudeReader";
import { readClaudeDetail, readClaudeEntry, readClaudeSessions } from "./readers/claudeReader";
import { readCodexDetail, readCodexEntry, readCodexSessions } from "./readers/codexReader";
import { clampDetailLimit } from "./readers/detail";
import { readOpenCodeDetail, readOpenCodeEntry, readOpenCodeSessions } from "./readers/opencodeReader";
import { getAgentDefinition, VAULT_AGENT_IDS, type VaultAgentId } from "./registry";
import { parseEntryId, type VaultListResult, type VaultSessionDetail, type VaultSessionEntry } from "./types";

// Agent identity is a single source of truth in `registry.ts`: `VaultAgentId`
// is derived from `VAULT_AGENT_IDS`, and the keyed reader records below are
// `satisfies Record<VaultAgentId, …>` so a missing agent is a compile error —
// no positional array or switch to forget (W3).

/** Human label for an agent — derived from the registry, never a parallel array. */
function agentLabel(id: VaultAgentId): string {
  return getAgentDefinition(id)?.displayName ?? id;
}

function isVaultAgentId(value: string): value is VaultAgentId {
  return (VAULT_AGENT_IDS as readonly string[]).includes(value);
}

export type VaultReaders = Record<VaultAgentId, () => Promise<ReaderResult>>;

/** Per-agent on-demand detail readers (resolve a single session by id). The
 *  optional `limit` bounds the returned timeline (most-recent kept) so the
 *  webview can load older messages incrementally. */
export type VaultDetailReaders = Record<
  VaultAgentId,
  (sessionId: string, limit?: number) => Promise<VaultSessionDetail | null>
>;

/** Per-agent single-entry readers (resolve ONE launch entry by id, no full scan).
 *  Backs `getEntry`, the fast path for resume/fork. */
export type VaultEntryReaders = Record<VaultAgentId, (sessionId: string) => Promise<VaultSessionEntry | null>>;

export interface VaultServiceDeps {
  readers?: VaultReaders;
  detailReaders?: VaultDetailReaders;
  entryReaders?: VaultEntryReaders;
  /** Injectable opencode fork probe; defaults to the real version probe. */
  canForkOpenCodeFn?: (minVersion: string) => Promise<boolean>;
}

const defaultReaders = {
  claude: () => readClaudeSessions(),
  codex: () => readCodexSessions(),
  opencode: () => readOpenCodeSessions(),
} satisfies VaultReaders;

const defaultDetailReaders = {
  claude: (sessionId, limit) => readClaudeDetail(sessionId, {}, limit),
  codex: (sessionId, limit) => readCodexDetail(sessionId, {}, limit),
  opencode: (sessionId, limit) => readOpenCodeDetail(sessionId, {}, limit),
} satisfies VaultDetailReaders;

const defaultEntryReaders = {
  claude: (sessionId) => readClaudeEntry(sessionId),
  codex: (sessionId) => readCodexEntry(sessionId),
  opencode: (sessionId) => readOpenCodeEntry(sessionId),
} satisfies VaultEntryReaders;

export class VaultService {
  private readonly readers: VaultReaders;
  private readonly detailReaders: VaultDetailReaders;
  private readonly entryReaders: VaultEntryReaders;
  private readonly canForkOpenCodeFn: (minVersion: string) => Promise<boolean>;

  constructor(deps: VaultServiceDeps = {}) {
    this.readers = deps.readers ?? defaultReaders;
    this.detailReaders = deps.detailReaders ?? defaultDetailReaders;
    this.entryReaders = deps.entryReaders ?? defaultEntryReaders;
    this.canForkOpenCodeFn = deps.canForkOpenCodeFn ?? ((min) => canForkOpenCode(min));
  }

  async list(): Promise<VaultListResult> {
    const results = await Promise.allSettled(VAULT_AGENT_IDS.map((id) => invokeReader(() => this.readers[id]())));

    const entries: VaultSessionEntry[] = [];
    let unreadable = 0;
    const reasons: string[] = [];
    results.forEach((r, i) => {
      const label = agentLabel(VAULT_AGENT_IDS[i]);
      if (r.status === "fulfilled") {
        entries.push(...r.value.entries);
        if (r.value.unreadable > 0) {
          unreadable += r.value.unreadable;
          reasons.push(
            `${label}: ${r.value.unreadable} session${r.value.unreadable === 1 ? "" : "s"} couldn't be read`,
          );
        }
      } else {
        // A whole reader failing is surfaced, not silently dropped.
        unreadable += 1;
        reasons.push(`${label}: reader failed`);
      }
    });

    // Resolve fork support. Only spawn the opencode probe when it can matter.
    const hasOpenCode = entries.some((e) => e.agent === "opencode");
    const opencodeMin = getAgentDefinition("opencode")?.forkMinVersion ?? "1.1.54";
    let opencodeCanFork = false;
    if (hasOpenCode) {
      try {
        opencodeCanFork = await this.canForkOpenCodeFn(opencodeMin);
      } catch {
        opencodeCanFork = false;
      }
    }

    for (const entry of entries) {
      entry.canFork = resolveCanFork(entry, opencodeCanFork);
    }

    entries.sort((a, b) => b.modified - a.modified);
    return { entries, unreadable: { count: unreadable, reasons: dedupe(reasons) } };
  }

  /**
   * Read one session's bounded detail on demand (redesign-vault-panel-ui D3).
   * Resolves the session by its id within the right agent's store via that
   * reader's `readDetail` — no full `list()`, no cache. Returns null for an
   * unknown agent or an unresolvable session.
   */
  async getDetail(entryId: string, limit?: number): Promise<VaultSessionDetail | null> {
    const parsed = parseEntryId(entryId);
    if (!parsed || !isVaultAgentId(parsed.agent)) {
      return null;
    }
    // Clamp the webview-supplied limit so a forged/garbage value can't defeat the
    // reader's timeline bound (W2).
    return this.detailReaders[parsed.agent](parsed.sessionId, clampDetailLimit(limit));
  }

  /**
   * Resolve ONE launch entry by id — the fast path for resume/fork. Reads only
   * the relevant agent's store via a point/locate-by-id lookup (no aggregate
   * `list()` over every store, no fork probe for agents other than opencode), so
   * launching is not gated on scanning the full session index. Mirrors getDetail
   * (resolve-by-id, no cache; D3). Returns null for an unknown agent or an
   * unresolvable session. canFork is resolved the same way as in list().
   */
  async getEntry(entryId: string): Promise<VaultSessionEntry | null> {
    const parsed = parseEntryId(entryId);
    if (!parsed || !isVaultAgentId(parsed.agent)) {
      return null;
    }
    const entry = await this.entryReaders[parsed.agent](parsed.sessionId);
    if (!entry) {
      return null;
    }
    let opencodeCanFork = false;
    if (entry.agent === "opencode") {
      const opencodeMin = getAgentDefinition("opencode")?.forkMinVersion ?? "1.1.54";
      try {
        opencodeCanFork = await this.canForkOpenCodeFn(opencodeMin);
      } catch {
        opencodeCanFork = false;
      }
    }
    entry.canFork = resolveCanFork(entry, opencodeCanFork);
    return entry;
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function invokeReader(read: () => Promise<ReaderResult>): Promise<ReaderResult> {
  return Promise.resolve().then(read);
}

function resolveCanFork(entry: VaultSessionEntry, opencodeCanFork: boolean): boolean {
  const def = getAgentDefinition(entry.agent);
  if (!def?.forkCommand) {
    return false;
  }
  if (def.forkMinVersion) {
    // Version-gated agents (currently only opencode).
    return entry.agent === "opencode" ? opencodeCanFork : false;
  }
  return true; // forkCommand present, no version gate (claude, codex)
}
