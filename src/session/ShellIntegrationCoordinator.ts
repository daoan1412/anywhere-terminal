// src/session/ShellIntegrationCoordinator.ts — Owns the cross-session
// shell-integration state: per-session cleanup callbacks from the script
// injector, the OSC 633 event reducer (delegated to each session's
// `CommandTracker`), and the cwd-routing side effect.
//
// Extracted from SessionManager so the central registry stays focused on
// session lifecycle. Mirrors the SnapshotPersistence / EditorPanelRegistry /
// CustomNameRegistry pattern. See:
//   asimov/changes/export-terminal-session/.reviews/round-1.md [W1]

import * as crypto from "node:crypto";
import type { ShellIntegrationEvent, ShellIntegrationSink } from "../pty/ShellIntegrationEvents";
import { type InjectionContext, type InjectionResult, injectShellIntegration } from "../pty/ShellIntegrationInjector";
import type { TerminalSession } from "./TerminalSession";

/** Dependencies the coordinator needs from its host (SessionManager). */
export interface ShellIntegrationCoordinatorDeps {
  /** Optional injector context — when undefined, every session bypasses injection. */
  ctx: InjectionContext | undefined;
  /** Look up a session by id (so the sink can resolve cwd / tracker on each event). */
  getSession: (sessionId: string) => TerminalSession | undefined;
  /** Route a parsed `cwd` event back into the session-level cwd store. */
  setCurrentCwd: (sessionId: string, cwd: string) => void;
  /** UUID factory for new TrackedCommand.id values. Injectable for tests. */
  idFactory?: () => string;
}

/**
 * Per-session cleanup map + OSC 633 routing. One instance lives on
 * SessionManager and is shared across every PTY spawn.
 */
export class ShellIntegrationCoordinator {
  /** Per-session cleanup callbacks from the shell-integration injector. */
  private readonly cleanups = new Map<string, () => void>();

  private readonly idFactory: () => string;

  constructor(private readonly deps: ShellIntegrationCoordinatorDeps) {
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID());
  }

  /**
   * If an injector context is configured AND the shell is recognised, run
   * the per-shell injection and return the mutated spawn args/env. Stores
   * the resulting nonce + cleanup so the parser side validates `E` markers
   * and the temp dir is torn down on session dispose.
   *
   * Returns `null` when:
   *   - the coordinator has no injector context (e.g. unit-test SessionManager); OR
   *   - the shell binary is unrecognised; OR
   *   - the user passed opt-out flags (`--noprofile --norc` / `-NoProfile`).
   *
   * Callers fall back to the original (unmodified) args/env in that case.
   */
  injectAtSpawn(
    sessionId: string,
    shellPath: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): InjectionResult | null {
    if (!this.deps.ctx) {
      return null;
    }
    const injection = injectShellIntegration(shellPath, args, env, this.deps.ctx);
    if (!injection) {
      return null;
    }
    this.cleanups.set(sessionId, injection.cleanup);
    return injection;
  }

  /**
   * Build the sink closure the PTY's data stream feeds into. Sink resolves
   * the session lazily on each event so it survives transient lookup races
   * (the session map is the source of truth at event time, not at wire time).
   */
  makeSink(sessionId: string): ShellIntegrationSink {
    return (event: ShellIntegrationEvent): void => this.handleEvent(sessionId, event);
  }

  /**
   * Run the per-session cleanup callback (idempotent — the injector wraps it
   * with a done-flag). No-op when no cleanup was registered for this id (e.g.
   * unrecognised shell or no injector context). Removes the entry from the
   * map so subsequent calls don't re-fire.
   */
  cleanupSession(sessionId: string): void {
    const cleanup = this.cleanups.get(sessionId);
    if (!cleanup) {
      return;
    }
    try {
      cleanup();
    } catch {
      /* best-effort — OS temp cleanup will reclaim later */
    }
    this.cleanups.delete(sessionId);
  }

  /**
   * Run every registered cleanup (used by SessionManager.dispose). Best-
   * effort; never throws.
   */
  cleanupAll(): void {
    for (const cleanup of this.cleanups.values()) {
      try {
        cleanup();
      } catch {
        /* best-effort */
      }
    }
    this.cleanups.clear();
  }

  /**
   * Reducer: routes the parsed event to either the session-level cwd store
   * (cwd events) or the session's `CommandTracker` (A/B/C/D/E events). The
   * tracker owns its state-transition vocabulary internally — this method
   * only resolves runtime context (now / cwd / id factory).
   */
  private handleEvent(sessionId: string, event: ShellIntegrationEvent): void {
    const session = this.deps.getSession(sessionId);
    if (!session) {
      return;
    }
    if (event.kind === "cwd") {
      this.deps.setCurrentCwd(sessionId, event.cwd);
      return;
    }
    session.commandTracking.handleEvent(event, {
      now: Date.now(),
      cwd: session.currentCwd ?? null,
      idFactory: this.idFactory,
    });
  }
}
