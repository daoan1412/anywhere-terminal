// src/session/SessionManager.ts — Central registry for all terminal sessions.
//
// Owns: session map, view→session index, terminal-number recycling, grace-period
// destroy queue, the operation-queue serializing destructive operations, and the
// PTY lifecycle wiring (spawn / onData / onExit / resize / kill).
//
// Delegates:
//   - cross-restart snapshot pipeline → SnapshotPersistence
//   - editor-panel registry           → EditorPanelRegistry
//   - per-number custom names         → CustomNameRegistry
//
// See: docs/design/session-manager.md and
//      asimov/changes/restore-terminal-sessions/design.md (D1-D13).

import * as crypto from "node:crypto";
import * as PtyManager from "../pty/PtyManager";
import { PtySession } from "../pty/PtySession";
import { queryProcessCwd } from "../pty/processCwd";
import { type CustomNameStorage, CustomNameRegistry, noopCustomNameStorage } from "./CustomNameRegistry";
import { EditorPanelRegistry } from "./EditorPanelRegistry";
import type { MessageSender } from "./OutputBuffer";
import { OutputBuffer } from "./OutputBuffer";
import type {
  LiveEditorPanelsRecord,
  PendingSnapshot,
  SessionSnapshotMetadata,
  SessionSnapshotsIndex,
} from "./SessionSnapshot";
import type { SessionStorage } from "./SessionStorage";
import { defaultHeadlessFactory, defaultSerializeAddonFactory, SnapshotPersistence } from "./SnapshotPersistence";
import type { HeadlessFactory, MemoryMetrics, SerializeAddonFactory, TerminalSession } from "./TerminalSession";

// ─── Re-exports (preserve external API for tests + providers) ──────

export type {
  HeadlessFactory,
  HeadlessTerminalLike,
  SerializeAddonFactory,
  SerializeAddonLike,
  TerminalSession,
  MemoryMetrics,
} from "./TerminalSession";
export type { CustomNameStorage } from "./CustomNameRegistry";
export { truncateSnapshotBuffer } from "./SnapshotPersistence";

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum total size of scrollback cache per session (in characters). Default 512KB. */
const SCROLLBACK_MAX_SIZE = 512 * 1024;

/** Default grace window between an editor panel disposing and the underlying PTY being destroyed. */
const DEFAULT_GRACE_DESTROY_MS = 5000;

// ─── Options ────────────────────────────────────────────────────────

/**
 * Optional configuration for cross-restart session restore. See:
 * asimov/changes/restore-terminal-sessions/design.md D1, D3, D11.
 */
export interface SessionManagerOptions {
  /** Default false — set true once the rest of the restore pipeline is wired. */
  restoreEnabled?: boolean;
  /** Default 5000ms — grace window before destroying sessions whose webview disposed. */
  gracePeriodMs?: number;
  /** Test seam: inject a fake headless constructor. */
  headlessFactory?: HeadlessFactory;
  /** Test seam: inject a fake serialize-addon constructor. */
  serializeAddonFactory?: SerializeAddonFactory;
  /** Persistence backend for cross-restart snapshots. Required when restoreEnabled === true. */
  storage?: SessionStorage;
}

// ─── SessionManager ─────────────────────────────────────────────────

/**
 * Central registry for all terminal sessions across all views.
 *
 * Owns the lifecycle of each terminal session: creation, input/output routing,
 * resize, and destruction. Handles tab numbering with gap-filling recycling,
 * serializes destructive operations via operation queue, and maintains
 * scrollback cache for view restore. Cross-restart persistence is delegated to
 * SnapshotPersistence; custom tab names to CustomNameRegistry; editor-panel
 * tracking to EditorPanelRegistry.
 */
export class SessionManager {
  /** All sessions indexed by session ID */
  private sessions = new Map<string, TerminalSession>();

  /** View ID → ordered list of session IDs */
  private viewSessions = new Map<string, string[]>();

  /** Set of terminal numbers currently in use (for recycling) */
  private usedNumbers = new Set<number>();

  /** Set of session IDs currently being killed (prevent re-entrant cleanup) */
  private terminalBeingKilled = new Set<string>();

  /** Serialized operation queue for destructive operations */
  private operationQueue: Promise<void> = Promise.resolve();

  /** Whether this manager has been disposed */
  private _disposed = false;

  /** Pending grace-period destroys keyed by viewId. */
  private pendingDestroys: Map<string, NodeJS.Timeout> = new Map();

  /** Default grace window applied when scheduleDestroyForView is called without an explicit delay. */
  private readonly defaultGracePeriodMs: number;

  /** Per-number custom-name persistence (workspace-scoped). */
  private readonly customNames: CustomNameRegistry;

  /** Live editor-panel registry (panelId → entry); persisted via SessionStorage. */
  protected readonly editorPanels: EditorPanelRegistry;

  /** Cross-restart snapshot pipeline (headless mirror, persist + hydrate). */
  private readonly snapshots: SnapshotPersistence;

  /** Persistence backend (workspaceState index + buffer files). May be null in tests. */
  private storage: SessionStorage | null;

  /**
   * Hook fired internally when a session's shell exits — schedules an
   * immediate snapshot so the exit state survives a sudden window close.
   * Public so tests can observe / override the hook.
   */
  onShellExited?: (sessionId: string) => void;

  constructor(customNameStorage: CustomNameStorage = noopCustomNameStorage, options: SessionManagerOptions = {}) {
    this.customNames = new CustomNameRegistry(customNameStorage);
    this.storage = options.storage ?? null;
    this.defaultGracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_DESTROY_MS;
    this.editorPanels = new EditorPanelRegistry((record) => {
      // Only write through to storage when restore is enabled; otherwise we
      // produce churn against `workspaceState` for no benefit.
      if (!this.snapshots.isRestoreEnabled() || !this.storage) return;
      this.storage.scheduleLivePanelsWrite(record);
    });
    this.snapshots = new SnapshotPersistence({
      restoreEnabled: options.restoreEnabled ?? false,
      storage: this.storage,
      headlessFactory: options.headlessFactory ?? defaultHeadlessFactory,
      serializeAddonFactory: options.serializeAddonFactory ?? defaultSerializeAddonFactory,
      getSession: (id) => this.sessions.get(id),
    });
    // Default exit-hook → immediate persist (bypass debounce) so the exit state
    // lands on disk even if the user closes the window right after. Tests
    // override `onShellExited` directly.
    this.onShellExited = (sessionId) => void this.snapshots.flushSessionImmediate(sessionId);
  }

  /** Test/inspection helper — current value of the restore-enabled flag. */
  isRestoreEnabled(): boolean {
    return this.snapshots.isRestoreEnabled();
  }

  /**
   * Flip the restore-enabled flag at runtime in response to a
   * `anywhereTerminal.sessionRestore.enabled` setting change. See design.md D11.
   */
  setRestoreEnabled(enabled: boolean): void {
    this.snapshots.setRestoreEnabled(enabled, this.sessions.keys());
    if (!enabled) this.editorPanels.clear();
  }

  // ─── Snapshot pass-through (test + provider compatibility) ──────

  /**
   * Generate a snapshot for a single session — used by tests and by the
   * persist/sync flush internally. See SnapshotPersistence.
   */
  generateSnapshotMetadata(sessionId: string): { metadata: SessionSnapshotMetadata; buffer: string } | null {
    return this.snapshots.generateSnapshotMetadata(sessionId);
  }

  /** Schedule a debounced snapshot persist for a session. */
  schedulePersist(sessionId: string): void {
    this.snapshots.schedulePersist(sessionId);
  }

  /** Bypass the debounce and persist a single session immediately. */
  async flushSessionImmediate(sessionId: string): Promise<void> {
    await this.snapshots.flushSessionImmediate(sessionId);
  }

  /** Test/inspection helper — the latest in-memory snapshot index. */
  getSnapshotIndexEntries(): Record<string, SessionSnapshotMetadata> {
    return this.snapshots.getSnapshotIndexEntries();
  }

  /**
   * Step 1 of `extension.deactivate`: synchronously write every active
   * session's serialized buffer to its file under `<storageUri>/snapshots/`.
   */
  flushSnapshotsSync(): void {
    this.snapshots.flushSnapshotsSync(this.sessions.keys());
  }

  /**
   * Step 2 of `extension.deactivate`: persist the snapshot index AND the live
   * editor-panels record via the awaited Memento API.
   */
  async flushIndexAwaited(): Promise<void> {
    await this.snapshots.flushIndexAwaited();
    if (this._disposed || !this.snapshots.isRestoreEnabled() || !this.storage) return;
    try {
      await this.storage.writeLivePanelsAwaited(this.editorPanels.toRecord());
    } catch (err) {
      console.error("[AnyWhere Terminal] writeLivePanelsAwaited failed:", err);
    }
  }

  /** Hydrate the pending-restore map from the persisted index (post-restart). */
  hydrateFromSnapshots(index?: SessionSnapshotsIndex): void {
    this.snapshots.hydrateFromSnapshots(index);
  }

  /** Hydrate the live editor-panels registry from workspaceState (post-restart). */
  hydrateLivePanels(record?: LiveEditorPanelsRecord): void {
    if (!this.snapshots.isRestoreEnabled()) return;
    this.editorPanels.hydrate(record);
  }

  hasSnapshotsForLocation(loc: "sidebar" | "panel"): boolean {
    return this.snapshots.hasSnapshotsForLocation(loc);
  }

  consumeSnapshotsForLocation(loc: "sidebar" | "panel"): PendingSnapshot[] {
    return this.snapshots.consumeSnapshotsForLocation(loc);
  }

  consumeSnapshotsForPanel(panelId: string): PendingSnapshot[] {
    return this.snapshots.consumeSnapshotsForPanel(panelId);
  }

  /**
   * Test-only seam: stage a single PendingSnapshot for provider onReady tests.
   * Preserves the legacy `(sm as any)._pendingSnapshots.set(...)` reach-in pattern
   * post-refactor by providing a proper public entry point.
   */
  __stagePendingSnapshot(snap: PendingSnapshot): void {
    this.snapshots.__stagePendingSnapshot(snap);
  }

  // ─── Live editor-panel pass-through ─────────────────────────────

  /** Record a new editor panel in the live-panels registry. Idempotent. */
  registerEditorPanel(panelId: string): void {
    this.editorPanels.register(panelId);
  }

  /** Attach a session to an editor panel. Idempotent. Silent no-op for unknown panelIds. */
  attachSessionToPanel(panelId: string, sessionId: string): void {
    this.editorPanels.attachSession(panelId, sessionId);
  }

  /** Remove an editor panel from the live-panels registry (after a grace-period destroy fires). */
  unregisterEditorPanel(panelId: string): void {
    this.editorPanels.unregister(panelId);
  }

  /** Build a `LiveEditorPanelsRecord` for persistence. */
  getLiveEditorPanelsRecord(): LiveEditorPanelsRecord {
    return this.editorPanels.toRecord();
  }

  // ─── Public API: Core CRUD ──────────────────────────────────────

  /**
   * Create a new terminal session for a view.
   *
   * Spawns a PTY, creates an OutputBuffer, wires events, and registers
   * the session in all maps. The new session becomes the active tab
   * (unless it is a split pane session).
   *
   * @param options.isSplitPane If true, marks the session as a split pane.
   *   Split pane sessions are excluded from getTabsForView() and do NOT
   *   deactivate existing sessions.
   * @param options.shell Optional shell path override (from settings).
   * @param options.shellArgs Optional shell arguments override (from settings).
   * @param options.cwd Optional working directory override (from settings).
   * @param options.restoreFrom Restore from a hydrated snapshot (preserves
   *   sessionId + metadata). See D7/D13.
   * @returns The session ID (UUID)
   */
  createSession(
    viewId: string,
    webview: MessageSender,
    options?: {
      isSplitPane?: boolean;
      shell?: string;
      shellArgs?: string[];
      cwd?: string;
      restoreFrom?: PendingSnapshot;
    },
  ): string {
    const restoreFrom = options?.restoreFrom;
    const restoringExited = restoreFrom?.metadata.shellExited === true;
    const isSplitPane = options?.isSplitPane ?? restoreFrom?.metadata.isSplitPane ?? false;
    // Preserve the persisted sessionId during restore so the webview's
    // split-layout (`vscode.setState`) keeps referencing the same tabs.
    const id = restoreFrom ? restoreFrom.metadata.sessionId : crypto.randomUUID();
    const number = restoreFrom ? this.reserveNumber(restoreFrom.metadata.terminalNumber) : this.findAvailableNumber();
    const name = `Terminal ${number}`;

    // Resolve shell/args/cwd. For restore: prefer the persisted values; for a
    // fresh session: caller-provided or auto-detected.
    const restoredShell = restoreFrom?.metadata.shell?.trim();
    const optShell = restoredShell || options?.shell;
    const optArgs = restoredShell ? restoreFrom?.metadata.shellArgs : options?.shellArgs;
    let resolvedShell: string;
    let resolvedArgs: string[];
    if (optShell) {
      resolvedShell = optShell;
      resolvedArgs = optArgs ?? [];
    } else {
      const detected = PtyManager.detectShell();
      resolvedShell = detected.shell;
      resolvedArgs = optArgs && optArgs.length > 0 ? optArgs : detected.args;
    }

    const cwd = restoreFrom?.metadata.cwd || options?.cwd || PtyManager.resolveWorkingDirectory();

    // Spawn PTY (skipped for exited shells — restored read-only per D13).
    const pty = new PtySession(id);
    if (!restoringExited) {
      const nodePty = PtyManager.loadNodePty();
      const env = PtyManager.buildEnvironment();
      pty.spawn(nodePty, resolvedShell, resolvedArgs, { cwd, env });
      // Wire passive OSC 7 / OSC 633 cwd parser. Sink receives sanitized absolute
      // paths only; PtySession guarantees byte-identical forwarding to onData.
      pty.setCurrentCwdSink((cwd) => this.setCurrentCwd(id, cwd));
    }

    const outputBuffer = new OutputBuffer(id, webview, pty);

    // Hydrate custom name: restore wins (persisted metadata), then the
    // per-number custom-names record (root tabs only; see add-tab-rename D3).
    const restoredCustomName = restoreFrom?.metadata.customName ?? null;
    const hydratedCustomName = isSplitPane ? null : (restoredCustomName ?? this.customNames.getForNumber(number));

    const session: TerminalSession = {
      id,
      viewId,
      pty,
      name,
      customName: hydratedCustomName,
      // Restored exited sessions surface read-only — keep them inactive so the
      // active-tab indicator doesn't move to a dead shell.
      isActive: !isSplitPane && !restoringExited,
      number,
      outputBuffer,
      scrollbackCache: [],
      scrollbackSize: 0,
      createdAt: Date.now(),
      cols: restoreFrom?.metadata.cols ?? 80,
      rows: restoreFrom?.metadata.rows ?? 30,
      disposables: [],
      webview,
      isSplitPane,
      initialCwd: cwd,
      currentCwd: restoreFrom?.metadata.currentCwd ?? undefined,
      shell: resolvedShell,
      shellArgs: resolvedArgs,
      panelId: viewId.startsWith("editor-") ? viewId.slice("editor-".length) : undefined,
      shellExited: restoringExited || undefined,
      exitCode: restoringExited ? (restoreFrom?.metadata.exitCode ?? null) : undefined,
    };

    // Deactivate other sessions in the same view (only for root tab sessions)
    if (!isSplitPane) {
      const viewSessionIds = this.viewSessions.get(viewId);
      if (viewSessionIds) {
        for (const sid of viewSessionIds) {
          const s = this.sessions.get(sid);
          if (s) s.isActive = false;
        }
      }
    }

    // Register in maps
    this.sessions.set(id, session);
    if (!this.viewSessions.has(viewId)) {
      this.viewSessions.set(viewId, []);
    }
    this.viewSessions.get(viewId)!.push(id);

    // Seed the headless mirror from the restore buffer (if applicable) so
    // subsequent serializes include the prior session's history.
    this.snapshots.attachSession(session, restoreFrom);

    // Wire PTY events
    pty.onData = (data: string) => {
      outputBuffer.append(data);
      this.appendToScrollback(session, data);
      this.snapshots.recordData(session, data);
    };

    pty.onExit = (code: number) => {
      // Record exit state BEFORE cleanup so an immediate persist (queued by
      // the persistence pipeline) captures the exit metadata. See D13.
      this.snapshots.recordExit(session, typeof code === "number" ? code : null);
      this.onShellExited?.(id);

      // If this is an intentional kill, skip cleanup (destroySession handles it)
      if (this.terminalBeingKilled.has(id)) return;

      // Unexpected crash — run cleanup and notify webview
      this.cleanupSession(id);
      this.safePostMessage(webview, { type: "exit", tabId: id, code });
    };

    return id;
  }

  /** Write input data to a session's PTY. Silent no-op for unknown session IDs. */
  writeToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pty.write(data);
  }

  /** Resize a session's PTY and update stored dimensions. Silent no-op for unknown session IDs. */
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    this.snapshots.recordResize(session, cols, rows);
  }

  /** Switch active session within a view. Silent no-op for unknown viewId or sessionId. */
  switchActiveSession(viewId: string, sessionId: string): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) return;
    if (!viewSessionIds.includes(sessionId)) return;
    for (const sid of viewSessionIds) {
      const s = this.sessions.get(sid);
      if (s) s.isActive = sid === sessionId;
    }
  }

  /** Get tab info for a view (for init/restore messages). Returns empty array for unknown viewIds. */
  getTabsForView(viewId: string): Array<{ id: string; name: string; customName: string | null; isActive: boolean }> {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) return [];

    type TabInfo = { id: string; name: string; customName: string | null; isActive: boolean };
    return viewSessionIds
      .map((sid): TabInfo | undefined => {
        const s = this.sessions.get(sid);
        if (!s || s.isSplitPane) return undefined;
        return { id: s.id, name: s.name, customName: s.customName, isActive: s.isActive };
      })
      .filter((tab): tab is TabInfo => tab !== undefined);
  }

  /**
   * Like {@link getTabsForView} but also includes split-pane children with an
   * `isSplitPane` flag so the webview can recreate every xterm referenced by
   * `WebviewStateStore.tabLayouts` on reload / cross-restart. See
   * restore-terminal-sessions design.md D12.
   */
  getAllSessionsForView(
    viewId: string,
  ): Array<{ id: string; name: string; customName: string | null; isActive: boolean; isSplitPane: boolean }> {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) return [];

    type SessionInfo = {
      id: string;
      name: string;
      customName: string | null;
      isActive: boolean;
      isSplitPane: boolean;
    };
    return viewSessionIds
      .map((sid): SessionInfo | undefined => {
        const s = this.sessions.get(sid);
        if (!s) return undefined;
        return {
          id: s.id,
          name: s.name,
          customName: s.customName,
          isActive: s.isActive,
          isSplitPane: s.isSplitPane,
        };
      })
      .filter((info): info is SessionInfo => info !== undefined);
  }

  /** Get a session by ID. Returns undefined if not found. */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Return the resolved cwd recorded at PTY spawn time, or undefined when the session is unknown. */
  getInitialCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.initialCwd;
  }

  /** Record the latest cwd parsed from PTY output. Silent no-op for unknown ids. */
  setCurrentCwd(sessionId: string, cwd: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.currentCwd = cwd;
    this.snapshots.schedulePersist(sessionId);
  }

  /** Return the latest cwd parsed from PTY output, or undefined when never set. */
  getCurrentCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.currentCwd;
  }

  /**
   * Asynchronously query the PTY child process's current cwd via the OS
   * process table (`/proc/<pid>/cwd` on Linux, `lsof` on macOS). Returns
   * undefined when the session is unknown, the PTY has no pid, the OS query
   * fails, or the platform is unsupported (Windows).
   *
   * Lazy: only invoke when a clicked file path actually needs resolution.
   * Bounded latency: macOS lsof is capped at 500ms by queryProcessCwd.
   */
  async getLiveCwd(sessionId: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const pid = session.pty.pid;
    if (pid === undefined) return undefined;
    return queryProcessCwd(pid);
  }

  /**
   * Rename a tab session by setting its `customName`. Single public entry point
   * for the rename feature; all UX triggers converge here (see add-tab-rename
   * design.md D2).
   *
   * - Silent no-op on unknown sessionId.
   * - Silent no-op when the target is a split pane (split panes consume terminal
   *   numbers but aren't tab identities, so the persisted record stays scoped
   *   to root tabs only — see design.md D3).
   * - `input` is normalized via CustomNameRegistry.
   * - On success: updates `session.customName`, broadcasts `tabRenamed` to the
   *   owning webview, and persists fire-and-forget (see design.md D9).
   */
  renameSession(sessionId: string, input: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.isSplitPane) return;

    const normalized = this.customNames.normalize(input);
    session.customName = normalized;

    this.safePostMessage(session.webview, {
      type: "tabRenamed",
      tabId: sessionId,
      customName: normalized,
    });

    this.customNames.setForNumber(session.number, normalized);
    this.snapshots.schedulePersist(sessionId);
  }

  /** Clear scrollback cache for a session. Silent no-op for unknown session IDs. */
  clearScrollback(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.scrollbackCache = [];
    session.scrollbackSize = 0;
  }

  /** Handle ack message for a session's output buffer. Silent no-op for unknown session IDs. */
  handleAck(sessionId: string, charCount: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.outputBuffer.handleAck(charCount);
  }

  /**
   * Update the webview reference for all sessions belonging to a view.
   * Used when a webview is re-created but sessions survive.
   */
  updateWebviewForView(viewId: string, webview: MessageSender): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) return;

    for (const sid of viewSessionIds) {
      const session = this.sessions.get(sid);
      if (session) {
        session.webview = webview;
        session.outputBuffer.updateWebview(webview);
      }
    }
  }

  /** Get the joined scrollback cache data for a session. Returns "" if unknown. */
  getScrollbackData(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "";
    return session.scrollbackCache.join("");
  }

  /** Get aggregate memory usage metrics across all sessions. */
  getMemoryMetrics(): MemoryMetrics {
    let totalBufferSize = 0;
    let totalScrollbackSize = 0;
    const sessions: MemoryMetrics["sessions"] = [];

    for (const session of this.sessions.values()) {
      const bufferSize = session.outputBuffer.bufferSize;
      const { scrollbackSize } = session;
      const unackedCharCount = session.outputBuffer.unackedCharCount;

      totalBufferSize += bufferSize;
      totalScrollbackSize += scrollbackSize;

      sessions.push({
        id: session.id,
        name: session.name,
        bufferSize,
        scrollbackSize,
        unackedCharCount,
      });
    }

    return {
      sessionCount: this.sessions.size,
      totalBufferSize,
      totalScrollbackSize,
      sessions,
    };
  }

  /** Pause output flushing for all sessions in a view. */
  pauseOutputForView(viewId: string): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) return;
    for (const sid of viewSessionIds) {
      const s = this.sessions.get(sid);
      if (s) s.outputBuffer.pauseOutput();
    }
  }

  /** Resume output flushing for all sessions in a view (any buffered data flushes immediately). */
  resumeOutputForView(viewId: string): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) return;
    for (const sid of viewSessionIds) {
      const s = this.sessions.get(sid);
      if (s) s.outputBuffer.resumeOutput();
    }
  }

  // ─── Public API: Destructive Operations (Queued) ────────────────

  /** Destroy a session (queued, serialized via operation queue). */
  destroySession(sessionId: string): void {
    this.operationQueue = this.operationQueue
      .then(async () => {
        await this.performDestroy(sessionId);
      })
      .catch((err) => {
        console.error("[AnyWhere Terminal] Destroy operation failed:", err);
      });
  }

  /**
   * Schedule a delayed destroy for every session belonging to a view. Used by
   * `TerminalEditorProvider.onDidDispose` to ride out a window-reload's
   * webview swap. The serializer's `deserializeWebviewPanel` calls
   * `cancelScheduledDestroy(viewId)` BEFORE constructing the new provider.
   * See design.md D3.
   */
  scheduleDestroyForView(viewId: string, delayMs: number = this.defaultGracePeriodMs, onFire?: () => void): void {
    const existing = this.pendingDestroys.get(viewId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingDestroys.delete(viewId);
      this.destroyAllForView(viewId);
      if (onFire) {
        try {
          onFire();
        } catch (err) {
          console.error("[AnyWhere Terminal] scheduleDestroyForView onFire callback failed:", err);
        }
      }
    }, delayMs);
    this.pendingDestroys.set(viewId, timer);
  }

  /** Cancel a previously scheduled destroy. Silent no-op when nothing is pending. */
  cancelScheduledDestroy(viewId: string): void {
    const existing = this.pendingDestroys.get(viewId);
    if (!existing) return;
    clearTimeout(existing);
    this.pendingDestroys.delete(viewId);
  }

  /** Test/inspection helper — current pending-destroy view ids. */
  getPendingDestroyViewIds(): string[] {
    return Array.from(this.pendingDestroys.keys());
  }

  /** Destroy all sessions for a specific view (queued, serialized). */
  destroyAllForView(viewId: string): void {
    this.operationQueue = this.operationQueue
      .then(async () => {
        const viewSessionIds = this.viewSessions.get(viewId);
        if (!viewSessionIds) return;
        // Copy the array since performDestroy modifies viewSessions
        const ids = [...viewSessionIds];
        for (const sid of ids) {
          await this.performDestroy(sid);
        }
      })
      .catch((err) => {
        console.error("[AnyWhere Terminal] DestroyAllForView operation failed:", err);
      });
  }

  /**
   * Dispose the SessionManager. Kills all PTY processes and clears all state.
   * Called explicitly from `extension.deactivate` (NOT registered in
   * context.subscriptions — ordering matters; see design.md D6).
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Tear down the snapshot debounce/timer; per-session mirror disposal
    // happens below in the session iteration via detachSession.
    this.snapshots.dispose();

    // Fire every pending grace-period destroy synchronously so no PTY leaks
    // past extension shutdown. Clear the timer first to suppress its async
    // callback. See design.md D3 + spec "Synchronous cleanup of pending destroys".
    for (const [viewId, timer] of this.pendingDestroys) {
      try {
        clearTimeout(timer);
      } catch {
        /* best-effort */
      }
      try {
        this.destroyAllForView(viewId);
      } catch (err) {
        console.error("[AnyWhere Terminal] destroyAllForView during dispose failed:", err);
      }
    }
    this.pendingDestroys.clear();

    // Kill all PTY processes immediately (no queue — we're shutting down).
    // Reproduces the legacy bypass-cleanupSession path BUT explicitly disposes
    // the headless mirror + SerializeAddon via detachSession so the snapshot
    // pipeline doesn't leak addons across reloads.
    for (const session of this.sessions.values()) {
      try {
        session.outputBuffer.dispose();
      } catch {
        /* best-effort */
      }
      try {
        session.pty.kill();
      } catch {
        /* best-effort */
      }
      for (const d of session.disposables) {
        try {
          d.dispose();
        } catch {
          /* best-effort */
        }
      }
      // Drops the snapshot index entry + unlinks the file + disposes mirror.
      this.snapshots.detachSession(session.id);
    }

    this.sessions.clear();
    this.viewSessions.clear();
    this.usedNumbers.clear();
    this.terminalBeingKilled.clear();
  }

  // ─── Private: Destroy Implementation ────────────────────────────

  /** Perform the actual destruction of a session. Called from the operation queue — serial. */
  private async performDestroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Mark as being killed to prevent re-entrant cleanup from onExit
    this.terminalBeingKilled.add(sessionId);

    // Flush and dispose the output buffer
    try {
      session.outputBuffer.dispose();
    } catch {
      /* best-effort */
    }

    // Kill the PTY (graceful shutdown)
    try {
      session.pty.kill();
    } catch {
      /* best-effort */
    }

    // Wait a tick for onExit to fire (it will be skipped due to terminalBeingKilled)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Clean up maps
    this.cleanupSession(sessionId);

    // Remove from kill tracking
    this.terminalBeingKilled.delete(sessionId);
  }

  // ─── Private: Cleanup ───────────────────────────────────────────

  /** Remove a session from all maps and free its resources. */
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Dispose per-session resources
    for (const d of session.disposables) {
      try {
        d.dispose();
      } catch {
        /* best-effort */
      }
    }

    // Hand off snapshot teardown — disposes headless + addon, drops index
    // entry, unlinks file, schedules an index rewrite.
    this.snapshots.detachSession(sessionId);

    // Remove from maps
    this.sessions.delete(sessionId);
    this.usedNumbers.delete(session.number);

    const viewSessionIds = this.viewSessions.get(session.viewId);
    if (viewSessionIds) {
      const idx = viewSessionIds.indexOf(sessionId);
      if (idx !== -1) viewSessionIds.splice(idx, 1);
      if (viewSessionIds.length === 0) this.viewSessions.delete(session.viewId);
    }
  }

  // ─── Private: Number Recycling ──────────────────────────────────

  /** Find the lowest available terminal number starting from 1 (gap-filling). */
  private findAvailableNumber(): number {
    for (let i = 1; ; i++) {
      if (!this.usedNumbers.has(i)) {
        this.usedNumbers.add(i);
        return i;
      }
    }
  }

  /**
   * Reserve a specific terminal number for restore. If the preferred number is
   * already in use, fall back to `findAvailableNumber()` — restoring two
   * workspaces with overlapping numbers should never crash.
   *
   * Note: `preferred <= 0` is intentionally treated as "no preference" so the
   * hydrate-fallback path (which synthesizes `terminalNumber: 0` for orphan
   * buffer files) routes through `findAvailableNumber()`.
   */
  private reserveNumber(preferred: number): number {
    if (preferred > 0 && !this.usedNumbers.has(preferred)) {
      this.usedNumbers.add(preferred);
      return preferred;
    }
    return this.findAvailableNumber();
  }

  // ─── Private: Scrollback Cache ──────────────────────────────────

  /** Append data to a session's scrollback cache with FIFO eviction. */
  private appendToScrollback(session: TerminalSession, data: string): void {
    session.scrollbackCache.push(data);
    session.scrollbackSize += data.length;

    // Evict oldest chunks until under limit
    while (session.scrollbackSize > SCROLLBACK_MAX_SIZE && session.scrollbackCache.length > 0) {
      const evicted = session.scrollbackCache.shift()!;
      session.scrollbackSize -= evicted.length;
    }
  }

  // ─── Private: Safe Message Posting ──────────────────────────────

  /** Safely post a message to a webview, handling both sync throws and async rejections. */
  private safePostMessage(webview: MessageSender, message: unknown): void {
    try {
      void (webview.postMessage(message) as Thenable<boolean>).then(undefined, () => {
        // Async rejection — webview may be disposed
      });
    } catch {
      // Sync throw — webview may be disposed
    }
  }
}
