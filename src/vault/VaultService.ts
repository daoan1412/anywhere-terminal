// src/vault/VaultService.ts — Aggregate per-agent readers into one recency-sorted,
// metadata-only session list with resolved fork support.
// See: specs/agent-session-index/spec.md (Aggregate and sort; Defensive parsing),
//      specs/vault-session-launch/spec.md (Fork when supported), design.md D2,D8.

import { canForkOpenCode } from "./forkSupport";
import type { ReaderResult } from "./readers/claudeReader";
import { readClaudeSessions } from "./readers/claudeReader";
import { readCodexSessions } from "./readers/codexReader";
import { readOpenCodeSessions } from "./readers/opencodeReader";
import { getAgentDefinition } from "./registry";
import type { VaultListResult, VaultSessionEntry } from "./types";

export interface VaultReaders {
  claude(): Promise<ReaderResult>;
  codex(): Promise<ReaderResult>;
  opencode(): Promise<ReaderResult>;
}

export interface VaultServiceDeps {
  readers?: VaultReaders;
  /** Injectable opencode fork probe; defaults to the real version probe. */
  canForkOpenCodeFn?: (minVersion: string) => Promise<boolean>;
}

const defaultReaders: VaultReaders = {
  claude: () => readClaudeSessions(),
  codex: () => readCodexSessions(),
  opencode: () => readOpenCodeSessions(),
};

export class VaultService {
  private readonly readers: VaultReaders;
  private readonly canForkOpenCodeFn: (minVersion: string) => Promise<boolean>;

  constructor(deps: VaultServiceDeps = {}) {
    this.readers = deps.readers ?? defaultReaders;
    this.canForkOpenCodeFn = deps.canForkOpenCodeFn ?? ((min) => canForkOpenCode(min));
  }

  async list(): Promise<VaultListResult> {
    const results = await Promise.allSettled([
      invokeReader(() => this.readers.claude()),
      invokeReader(() => this.readers.codex()),
      invokeReader(() => this.readers.opencode()),
    ]);

    const entries: VaultSessionEntry[] = [];
    let unreadable = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        entries.push(...r.value.entries);
        unreadable += r.value.unreadable;
      } else {
        // A whole reader failing is surfaced, not silently dropped.
        unreadable += 1;
      }
    }

    // Resolve fork support. Only spawn the opencode probe when it can matter.
    const hasOpenCode = entries.some((e) => e.agent === "opencode");
    const opencodeMin = getAgentDefinition("opencode")?.forkMinVersion ?? "1.14.50";
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
    return { entries, unreadable };
  }
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
