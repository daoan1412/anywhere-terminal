// src/vault/VaultLauncher.ts — Resolve a vault entry into createSession options.
// See: specs/vault-session-launch/spec.md (Resume; Fork when supported),
//      design.md D5,D9.
//
// This resolves an entry id to the exact `{ shell, shellArgs, cwd, env }` shape
// SessionManager.createSession expects (shell = the agent executable, shellArgs =
// the argv from LaunchBuilder). It does NOT spawn — the provider owns the
// createSession call + the `tabCreated` post so the terminal becomes visible (D5).

import { build, type LaunchMode, VaultLaunchError } from "./LaunchBuilder";
import type { VaultService } from "./VaultService";

export interface CreateSessionOptions {
  shell: string;
  shellArgs: string[];
  cwd: string;
  /** Present only for Claude (auth/config override); omitted otherwise. */
  env?: Record<string, string>;
}

export class VaultLauncher {
  constructor(
    private readonly vaultService: VaultService,
    private readonly hostEnv: Record<string, string | undefined> = process.env,
  ) {}

  async resolve(entryId: string, mode: LaunchMode): Promise<CreateSessionOptions> {
    const { entries } = await this.vaultService.list();
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new VaultLaunchError(`No vault session: ${entryId}`, "unknown-entry");
    }
    if (mode === "fork" && !entry.canFork) {
      throw new VaultLaunchError(`Fork is not supported for ${entryId}`, "fork-unsupported");
    }

    const spec = build(entry, mode, this.hostEnv);
    return {
      shell: spec.file,
      shellArgs: spec.args,
      cwd: spec.cwd,
      env: Object.keys(spec.env).length > 0 ? spec.env : undefined,
    };
  }
}
