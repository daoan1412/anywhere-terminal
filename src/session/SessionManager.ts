// src/session/SessionManager.ts — Central registry for all terminal sessions
// See: docs/design/session-manager.md

import * as crypto from "node:crypto";
import * as PtyManager from "../pty/PtyManager";
import { PtySession } from "../pty/PtySession";
import { queryProcessCwd } from "../pty/processCwd";
import type { MessageSender } from "./OutputBuffer";
import { OutputBuffer } from "./OutputBuffer";

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum total size of scrollback cache per session (in characters). Default 512KB. */
const SCROLLBACK_MAX_SIZE = 512 * 1024;

/** workspaceState key for the per-terminal-number custom-name record. See design.md D3. */
const CUSTOM_NAMES_STORAGE_KEY = "anywhereTerminal.tabCustomNames";

/** Hard cap for a custom name; longer input is silently truncated. See design.md D7. */
const CUSTOM_NAME_MAX_LENGTH = 80;

/**
 * Minimal subset of `vscode.Memento` (read/write key-value) that the
 * `SessionManager` actually uses. Declared locally so tests can pass a tiny
 * in-memory fake without importing vscode.
 */
export interface CustomNameStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/** No-op storage used when no Memento is provided — sessions still work, just without persistence. */
const noopStorage: CustomNameStorage = {
  get: () => undefined,
  update: () => Promise.resolve(),
};

// ─── Data Model ─────────────────────────────────────────────────────

/** A single terminal session with its PTY, buffer, and metadata. */
export interface TerminalSession {
  /** Unique session identifier (UUID) */
  id: string;
  /** Which view this session belongs to (e.g., 'anywhereTerminal.sidebar') */
  viewId: string;
  /** The PTY process wrapper */
  pty: PtySession;
  /** Display name: "Terminal 1", "Terminal 2", etc. */
  name: string;
  /**
   * User-supplied display name. When non-null, takes priority over `name` in
   * the tab label. Reset to null by submitting an empty rename. Hydrated from
   * workspaceState on create for non-split-pane sessions (see design.md D3).
   */
  customName: string | null;
  /** Whether this is the active tab in its view */
  isActive: boolean;
  /** Assigned terminal number (for name and recycling) */
  number: number;
  /** Output buffer instance for this session */
  outputBuffer: OutputBuffer;
  /** Cached scrollback chunks for view restore */
  scrollbackCache: string[];
  /** Total character count across all scrollback chunks */
  scrollbackSize: number;
  /** Timestamp of session creation */
  createdAt: number;
  /** Current terminal columns */
  cols: number;
  /** Current terminal rows */
  rows: number;
  /** Per-session event subscriptions for cleanup */
  disposables: Array<{ dispose(): void }>;
  /** Webview message sender for this session */
  webview: MessageSender;
  /** Whether this session is a split pane (not a root tab). Split pane sessions are excluded from getTabsForView(). */
  isSplitPane: boolean;
  /** Resolved cwd passed to the PTY at spawn time; used for resolving relative file paths in terminal links. */
  initialCwd?: string;
  /** Latest cwd observed from PTY OSC 7 / OSC 633 reports; undefined until the first parse. */
  currentCwd?: string;
}

/** Aggregate memory usage snapshot across all sessions. */
export interface MemoryMetrics {
  /** Number of active sessions */
  sessionCount: number;
  /** Total characters in all output buffers (unflushed) */
  totalBufferSize: number;
  /** Total characters in all scrollback caches */
  totalScrollbackSize: number;
  /** Per-session breakdown */
  sessions: Array<{
    id: string;
    name: string;
    bufferSize: number;
    scrollbackSize: number;
    unackedCharCount: number;
  }>;
}

// ─── SessionManager ─────────────────────────────────────────────────

/**
 * Central registry for all terminal sessions across all views.
 *
 * Owns the lifecycle of each terminal session: creation, input/output routing,
 * resize, and destruction. Handles tab numbering with gap-filling recycling,
 * serializes destructive operations via operation queue, and maintains
 * scrollback cache for view restore.
 *
 * See: docs/design/session-manager.md
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

  /** Persistent storage for per-number custom tab names (see design.md D3). */
  private readonly customNameStorage: CustomNameStorage;

  /**
   * In-memory authoritative copy of the `{ number → customName }` record.
   * Hydrated once from `customNameStorage` at construction; every mutation
   * goes through this Map first (synchronous, race-free), then a snapshot is
   * fired-and-forgotten to `customNameStorage.update()`. This avoids the
   * load-modify-save race where two concurrent renames each load empty,
   * each write back only their own entry, and one entry is lost. See
   * `.reviews/round-1.md` B1.
   */
  private readonly persistedCustomNames: Map<string, string>;

  constructor(customNameStorage: CustomNameStorage = noopStorage) {
    this.customNameStorage = customNameStorage;
    this.persistedCustomNames = this.loadPersistedNamesFromStorage();
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
   * @returns The session ID (UUID)
   */
  createSession(
    viewId: string,
    webview: MessageSender,
    options?: { isSplitPane?: boolean; shell?: string; shellArgs?: string[]; cwd?: string },
  ): string {
    const isSplitPane = options?.isSplitPane ?? false;
    const id = crypto.randomUUID();
    const number = this.findAvailableNumber();
    const name = `Terminal ${number}`;

    // Load PTY infrastructure
    const nodePty = PtyManager.loadNodePty();

    // Use provided shell/args or auto-detect
    const shell = options?.shell;
    const shellArgs = options?.shellArgs;
    let resolvedShell: string;
    let resolvedArgs: string[];
    if (shell) {
      resolvedShell = shell;
      resolvedArgs = shellArgs ?? [];
    } else {
      const detected = PtyManager.detectShell();
      resolvedShell = detected.shell;
      resolvedArgs = shellArgs && shellArgs.length > 0 ? shellArgs : detected.args;
    }

    const env = PtyManager.buildEnvironment();
    const cwd = options?.cwd || PtyManager.resolveWorkingDirectory();

    // Spawn PTY
    const pty = new PtySession(id);
    pty.spawn(nodePty, resolvedShell, resolvedArgs, { cwd, env });
    // Wire passive OSC 7 / OSC 633 cwd parser. Sink receives sanitized absolute
    // paths only; PtySession guarantees byte-identical forwarding to onData.
    pty.setCurrentCwdSink((cwd) => this.setCurrentCwd(id, cwd));

    // Create OutputBuffer
    const outputBuffer = new OutputBuffer(id, webview, pty);

    // Create session object
    // Hydrate custom name from persisted record (root tabs only; see design.md D3)
    const hydratedCustomName = isSplitPane ? null : (this.persistedCustomNames.get(String(number)) ?? null);

    const session: TerminalSession = {
      id,
      viewId,
      pty,
      name,
      customName: hydratedCustomName,
      isActive: !isSplitPane,
      number,
      outputBuffer,
      scrollbackCache: [],
      scrollbackSize: 0,
      createdAt: Date.now(),
      cols: 80,
      rows: 30,
      disposables: [],
      webview,
      isSplitPane,
      initialCwd: cwd,
    };

    // Deactivate other sessions in the same view (only for root tab sessions)
    if (!isSplitPane) {
      const viewSessionIds = this.viewSessions.get(viewId);
      if (viewSessionIds) {
        for (const sid of viewSessionIds) {
          const s = this.sessions.get(sid);
          if (s) {
            s.isActive = false;
          }
        }
      }
    }

    // Register in maps
    this.sessions.set(id, session);
    if (!this.viewSessions.has(viewId)) {
      this.viewSessions.set(viewId, []);
    }
    this.viewSessions.get(viewId)!.push(id);

    // Wire PTY events
    pty.onData = (data: string) => {
      outputBuffer.append(data);
      this.appendToScrollback(session, data);
    };

    pty.onExit = (code: number) => {
      // If this is an intentional kill, skip cleanup (destroySession handles it)
      if (this.terminalBeingKilled.has(id)) {
        return;
      }

      // Unexpected crash — run cleanup and notify webview
      this.cleanupSession(id);
      this.safePostMessage(webview, { type: "exit", tabId: id, code });
    };

    return id;
  }

  /**
   * Write input data to a session's PTY.
   * Silently ignores calls with unknown session IDs.
   */
  writeToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pty.write(data);
  }

  /**
   * Resize a session's PTY and update stored dimensions.
   * Silently ignores calls with unknown session IDs.
   */
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  /**
   * Switch active session within a view.
   * Sets isActive=true on target, false on all others in the same view.
   * Silently ignores calls with unknown viewId or sessionId.
   */
  switchActiveSession(viewId: string, sessionId: string): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) {
      return;
    }

    // Verify the target session exists and belongs to this view
    if (!viewSessionIds.includes(sessionId)) {
      return;
    }

    for (const sid of viewSessionIds) {
      const s = this.sessions.get(sid);
      if (s) {
        s.isActive = sid === sessionId;
      }
    }
  }

  /**
   * Get tab info for a view (for init/restore messages).
   * Returns an empty array for unknown viewIds.
   */
  getTabsForView(viewId: string): Array<{ id: string; name: string; customName: string | null; isActive: boolean }> {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) {
      return [];
    }

    type TabInfo = { id: string; name: string; customName: string | null; isActive: boolean };
    return viewSessionIds
      .map((sid): TabInfo | undefined => {
        const s = this.sessions.get(sid);
        if (!s || s.isSplitPane) {
          return undefined;
        }
        return { id: s.id, name: s.name, customName: s.customName, isActive: s.isActive };
      })
      .filter((tab): tab is TabInfo => tab !== undefined);
  }

  /**
   * Get a session by ID.
   * Returns undefined if not found.
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Return the resolved cwd recorded at PTY spawn time, or undefined when the
   * session is unknown.
   */
  getInitialCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.initialCwd;
  }

  /**
   * Record the latest cwd parsed from PTY output. Silent no-op for unknown ids.
   * No validation — the parser is responsible for sanitization.
   */
  setCurrentCwd(sessionId: string, cwd: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.currentCwd = cwd;
  }

  /**
   * Return the latest cwd parsed from PTY output, or undefined when never set
   * or the session is unknown.
   */
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
    if (!session) {
      return undefined;
    }
    const pid = session.pty.pid;
    if (pid === undefined) {
      return undefined;
    }
    return queryProcessCwd(pid);
  }

  /**
   * Rename a tab session by setting its `customName`. Single public entry point
   * for the rename feature; all UX triggers converge here (see design.md D2).
   *
   * - Silent no-op on unknown sessionId.
   * - Silent no-op when the target is a split pane (`isSplitPane === true`):
   *   split panes consume terminal numbers but aren't tab identities, so the
   *   persisted record stays scoped to root tabs only (see design.md D3).
   * - `input` is normalized: `null`/whitespace-only → `null` (reset to auto-name);
   *   strings longer than `CUSTOM_NAME_MAX_LENGTH` are silently truncated.
   * - On success: updates `session.customName`, broadcasts `tabRenamed` to the
   *   owning webview, and persists fire-and-forget (see design.md D9).
   */
  renameSession(sessionId: string, input: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.isSplitPane) {
      return;
    }

    const normalized = this.normalizeCustomName(input);
    session.customName = normalized;

    this.safePostMessage(session.webview, {
      type: "tabRenamed",
      tabId: sessionId,
      customName: normalized,
    });

    // Mutate the in-memory authoritative record synchronously (race-free), then
    // enqueue a fire-and-forget snapshot write. See `.reviews/round-1.md` B1.
    const key = String(session.number);
    if (normalized === null) {
      this.persistedCustomNames.delete(key);
    } else {
      this.persistedCustomNames.set(key, normalized);
    }
    this.savePersistedNamesSnapshot();
  }

  /**
   * Clear scrollback cache for a session.
   * Silently ignores calls with unknown session IDs.
   */
  clearScrollback(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.scrollbackCache = [];
    session.scrollbackSize = 0;
  }

  /**
   * Handle ack message for a session's output buffer.
   * Silently ignores calls with unknown session IDs.
   */
  handleAck(sessionId: string, charCount: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.outputBuffer.handleAck(charCount);
  }

  /**
   * Update the webview reference for all sessions belonging to a view.
   * Used when a webview is re-created but sessions survive.
   */
  updateWebviewForView(viewId: string, webview: MessageSender): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) {
      return;
    }

    for (const sid of viewSessionIds) {
      const session = this.sessions.get(sid);
      if (session) {
        session.webview = webview;
        session.outputBuffer.updateWebview(webview);
      }
    }
  }

  /**
   * Get the joined scrollback cache data for a session.
   * Returns an empty string if the session does not exist.
   */
  getScrollbackData(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return "";
    }
    return session.scrollbackCache.join("");
  }

  /**
   * Get aggregate memory usage metrics across all sessions.
   * Computes totals on demand — zero overhead when not called.
   */
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

  /**
   * Pause output flushing for all sessions in a view.
   * PTY data continues to accumulate in the scrollback cache but is not flushed to the webview.
   */
  pauseOutputForView(viewId: string): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) {
      return;
    }

    for (const sid of viewSessionIds) {
      const session = this.sessions.get(sid);
      if (session) {
        session.outputBuffer.pauseOutput();
      }
    }
  }

  /**
   * Resume output flushing for all sessions in a view.
   * Any buffered data is flushed immediately.
   */
  resumeOutputForView(viewId: string): void {
    const viewSessionIds = this.viewSessions.get(viewId);
    if (!viewSessionIds) {
      return;
    }

    for (const sid of viewSessionIds) {
      const session = this.sessions.get(sid);
      if (session) {
        session.outputBuffer.resumeOutput();
      }
    }
  }

  // ─── Public API: Destructive Operations (Queued) ────────────────

  /**
   * Destroy a session (queued, serialized via operation queue).
   */
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
   * Destroy all sessions for a specific view (queued, serialized).
   */
  destroyAllForView(viewId: string): void {
    this.operationQueue = this.operationQueue
      .then(async () => {
        const viewSessionIds = this.viewSessions.get(viewId);
        if (!viewSessionIds) {
          return;
        }
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
   * Registered in context.subscriptions for automatic cleanup on extension deactivation.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    // Kill all PTY processes immediately (no queue — we're shutting down)
    for (const session of this.sessions.values()) {
      try {
        session.outputBuffer.dispose();
      } catch {
        // Best-effort
      }
      try {
        session.pty.kill();
      } catch {
        // Best-effort
      }
      for (const d of session.disposables) {
        try {
          d.dispose();
        } catch {
          // Best-effort
        }
      }
    }

    this.sessions.clear();
    this.viewSessions.clear();
    this.usedNumbers.clear();
    this.terminalBeingKilled.clear();
  }

  // ─── Private: Destroy Implementation ────────────────────────────

  /**
   * Perform the actual destruction of a session.
   * Called from the operation queue — guaranteed serial execution.
   */
  private async performDestroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Already destroyed or never existed
    }

    // Mark as being killed to prevent re-entrant cleanup from onExit
    this.terminalBeingKilled.add(sessionId);

    // Flush and dispose the output buffer
    try {
      session.outputBuffer.dispose();
    } catch {
      // Best-effort
    }

    // Kill the PTY (graceful shutdown)
    try {
      session.pty.kill();
    } catch {
      // Best-effort
    }

    // Wait a tick for onExit to fire (it will be skipped due to terminalBeingKilled)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Clean up maps
    this.cleanupSession(sessionId);

    // Remove from kill tracking
    this.terminalBeingKilled.delete(sessionId);
  }

  // ─── Private: Cleanup ───────────────────────────────────────────

  /**
   * Remove a session from all maps and free its resources.
   */
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Dispose per-session resources
    for (const d of session.disposables) {
      try {
        d.dispose();
      } catch {
        // Best-effort
      }
    }

    // Remove from maps
    this.sessions.delete(sessionId);
    this.usedNumbers.delete(session.number);

    const viewSessionIds = this.viewSessions.get(session.viewId);
    if (viewSessionIds) {
      const idx = viewSessionIds.indexOf(sessionId);
      if (idx !== -1) {
        viewSessionIds.splice(idx, 1);
      }
      if (viewSessionIds.length === 0) {
        this.viewSessions.delete(session.viewId);
      }
    }
  }

  // ─── Private: Number Recycling ──────────────────────────────────

  /**
   * Find the lowest available terminal number starting from 1.
   * Gap-filling algorithm: if numbers {1, 3} are in use, returns 2.
   */
  private findAvailableNumber(): number {
    for (let i = 1; ; i++) {
      if (!this.usedNumbers.has(i)) {
        this.usedNumbers.add(i);
        return i;
      }
    }
  }

  // ─── Private: Scrollback Cache ──────────────────────────────────

  /**
   * Append data to a session's scrollback cache with FIFO eviction.
   */
  private appendToScrollback(session: TerminalSession, data: string): void {
    session.scrollbackCache.push(data);
    session.scrollbackSize += data.length;

    // Evict oldest chunks until under limit
    while (session.scrollbackSize > SCROLLBACK_MAX_SIZE && session.scrollbackCache.length > 0) {
      const evicted = session.scrollbackCache.shift()!;
      session.scrollbackSize -= evicted.length;
    }
  }

  // ─── Private: Custom-Name Persistence ───────────────────────────

  /**
   * Read the persisted `{ number → customName }` record from workspaceState
   * into a Map (called once from the constructor). Defensive: returns an empty
   * Map for any non-object value (corrupted state, first run, no-op storage).
   */
  private loadPersistedNamesFromStorage(): Map<string, string> {
    const raw = this.customNameStorage.get(CUSTOM_NAMES_STORAGE_KEY);
    const result = new Map<string, string>();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return result;
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") {
        result.set(k, v);
      }
    }
    return result;
  }

  /**
   * Write a snapshot of the in-memory record to `workspaceState`. Fire-and-forget
   * (errors logged only; see design.md D9). Snapshot is taken at call time so
   * the persisted state reflects whatever the in-memory map looks like NOW —
   * subsequent mutations are picked up by the NEXT call, not this one.
   */
  private savePersistedNamesSnapshot(): void {
    const snapshot: Record<string, string> = {};
    for (const [k, v] of this.persistedCustomNames) {
      snapshot[k] = v;
    }
    void this.customNameStorage.update(CUSTOM_NAMES_STORAGE_KEY, snapshot).then(undefined, (err) => {
      console.error("[AnyWhere Terminal] Failed to persist custom tab names:", err);
    });
  }

  /**
   * Normalize a rename input to the canonical `customName` value.
   * - null / undefined / empty-after-trim → null (reset to auto-name)
   * - longer than CUSTOM_NAME_MAX_LENGTH → silently truncated
   * - otherwise → trimmed string
   */
  private normalizeCustomName(input: string | null): string | null {
    if (input === null) {
      return null;
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > CUSTOM_NAME_MAX_LENGTH) {
      return trimmed.slice(0, CUSTOM_NAME_MAX_LENGTH);
    }
    return trimmed;
  }

  // ─── Private: Safe Message Posting ──────────────────────────────

  /**
   * Safely post a message to a webview, handling both sync throws and async rejections.
   */
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
