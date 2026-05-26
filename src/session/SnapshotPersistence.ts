// src/session/SnapshotPersistence.ts — Cross-restart snapshot pipeline.
//
// Owns everything related to restore: per-session xterm-headless mirror,
// SerializeAddon caching, snapshot metadata generation, debounced flush,
// sync deactivate flush, hydrate-on-activate (with index-lost fallback +
// orphan cleanup), and the pending-restore staging map drained by the
// providers' onReady branches.
//
// Extracted from SessionManager.ts so the core session lifecycle and the
// restore pipeline can be reasoned about independently. SessionManager owns
// the canonical session registry and wires `pty.onData`/`onExit`/`resize`
// into this collaborator via `recordData`/`recordExit`/`recordResize`.
//
// See: restore-terminal-sessions design.md D1, D4-D7, D11, D13.

import type { PendingSnapshot, SessionSnapshotMetadata, SessionSnapshotsIndex, ViewLocation } from "./SessionSnapshot";
import type { SessionStorage } from "./SessionStorage";
import { evictIndex } from "./sessionSnapshotEviction";
import type { HeadlessFactory, SerializeAddonFactory, TerminalSession } from "./TerminalSession";

/** Snapshot serialize options — match VS Code core's XtermSerializer (`ptyService.ts:1086-1089`). */
const SERIALIZE_OPTIONS = { scrollback: 1000, excludeAltBuffer: true, excludeModes: true } as const;

/** Hard cap for the serialized buffer attached to a single snapshot. See design.md D5. */
const SNAPSHOT_BUFFER_MAX_BYTES = 1_048_576;

/** Debounce for coalescing high-frequency pty.onData events into one snapshot write. See design.md D6. */
const SNAPSHOT_PERSIST_DEBOUNCE_MS = 1000;

/**
 * Default factory: dynamically loads `@xterm/headless` and constructs a
 * Terminal sized to the PTY. Lazy require avoids the cold-start cost when
 * `sessionRestore.enabled === false`.
 */
export const defaultHeadlessFactory: HeadlessFactory = (cols, rows) => {
  const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
  return new Terminal({
    cols,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
  }) as unknown as import("./TerminalSession").HeadlessTerminalLike;
};

export const defaultSerializeAddonFactory: SerializeAddonFactory = () => {
  const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
  return new SerializeAddon() as unknown as import("./TerminalSession").SerializeAddonLike;
};

/**
 * Trim leading bytes off a serialized buffer when it exceeds the byte cap.
 * Cuts at the nearest LF AFTER the byte slice so the new head starts at a
 * line boundary. The xterm parser is resilient to incomplete escape sequences
 * at the start of a write call.
 */
export function truncateSnapshotBuffer(buffer: string, maxBytes: number = SNAPSHOT_BUFFER_MAX_BYTES): string {
  const totalBytes = Buffer.byteLength(buffer, "utf8");
  if (totalBytes <= maxBytes) return buffer;
  const buf = Buffer.from(buffer, "utf8");
  const tail = buf.subarray(buf.length - maxBytes);
  const lf = tail.indexOf(0x0a);
  const headSafe = lf >= 0 ? tail.subarray(lf + 1) : tail;
  return headSafe.toString("utf8");
}

/** Map a viewId back to the `viewLocation` kept in the persisted index. */
export function viewLocationOf(viewId: string): ViewLocation {
  if (viewId.startsWith("editor-")) return "editor";
  if (viewId === "anywhereTerminal.panel") return "panel";
  return "sidebar";
}

export interface SnapshotPersistenceOptions {
  restoreEnabled: boolean;
  storage: SessionStorage | null;
  headlessFactory: HeadlessFactory;
  serializeAddonFactory: SerializeAddonFactory;
  /** Lookup callback for SessionManager's session registry. */
  getSession: (id: string) => TerminalSession | undefined;
}

export class SnapshotPersistence {
  private readonly headlessFactory: HeadlessFactory;
  private readonly serializeAddonFactory: SerializeAddonFactory;
  private readonly getSession: (id: string) => TerminalSession | undefined;
  private storage: SessionStorage | null;
  private restoreEnabled: boolean;

  /** Debounce timer for coalesced snapshot persistence. Null when idle. */
  private _persistTimer: NodeJS.Timeout | null = null;

  /** Sessions with buffer changes since the last flush. Drained per tick. */
  private _pendingSessions = new Set<string>();

  /**
   * Per-session promise chain of in-flight headless writes. xterm.js
   * `write(data, cb)` is asynchronous — the buffer is not guaranteed to be
   * up-to-date until `cb` fires. Async flushes MUST await this barrier before
   * `serialize()` so the snapshot reflects the full byte stream.
   * Sync flush (deactivate) is best-effort — captures whatever is currently
   * parsed; this is the accepted ≤8ms loss window. See `.reviews/round-1.md` B1.
   */
  private writeBarriers = new Map<string, Promise<void>>();

  /**
   * Incremented when persistence is invalidated (restore toggled off, storage
   * swapped). In-flight async flushes capture the generation at entry and
   * abort if it changes — prevents stale writes from resurrecting purged
   * snapshots. See `.reviews/round-1.md` W9.
   */
  private _persistGeneration = 0;

  /** Latest snapshot metadata, indexed by sessionId. Used to compose the persisted index. */
  private _snapshotIndex: Record<string, SessionSnapshotMetadata> = {};

  /**
   * Pending restore snapshots loaded on activate via `hydrateFromSnapshots`.
   * Drained by `consumeSnapshotsForLocation` / `consumeSnapshotsForPanel`.
   */
  private _pendingSnapshots: Map<string, PendingSnapshot> = new Map();

  private _disposed = false;

  constructor(opts: SnapshotPersistenceOptions) {
    this.restoreEnabled = opts.restoreEnabled;
    this.storage = opts.storage;
    this.headlessFactory = opts.headlessFactory;
    this.serializeAddonFactory = opts.serializeAddonFactory;
    this.getSession = opts.getSession;
  }

  isRestoreEnabled(): boolean {
    return this.restoreEnabled;
  }

  /**
   * Flip the restore-enabled flag at runtime in response to a setting change.
   * SessionManager passes its live session ids so we can dispose every mirror.
   * See design.md D11.
   */
  setRestoreEnabled(enabled: boolean, liveSessionIds: Iterable<string>): void {
    if (this.restoreEnabled === enabled) return;
    this.restoreEnabled = enabled;
    // Invalidate any in-flight async flush so it can't resurrect snapshots
    // after this teardown completes.
    this._persistGeneration++;
    if (!enabled) {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      this._pendingSessions.clear();
      this.writeBarriers.clear();
      // Dispose every mirror + cached addon. The session itself stays alive;
      // only the restore pipeline is torn down.
      for (const id of liveSessionIds) {
        const session = this.getSession(id);
        if (session) this.disposeMirrorFor(session);
      }
      this._snapshotIndex = {};
      if (this.storage) void this.storage.purge();
    }
  }

  // ─── Mirror lifecycle ───────────────────────────────────────────

  /**
   * Called by SessionManager.createSession after the session is registered.
   * Seeds the headless mirror from a restore buffer (when applicable) so a
   * subsequent serialize includes prior history. Mirrors VS Code core's
   * `ptyService.ts` restore flow.
   *
   * When restoring an EXITED shell (`restoreFrom.metadata.shellExited`), the
   * mirror is NOT seeded — there is no live PTY and the existing buffer file
   * on disk already captures everything.
   */
  attachSession(session: TerminalSession, restoreFrom?: PendingSnapshot): void {
    if (!this.restoreEnabled) return;
    if (!restoreFrom?.buffer) return;
    if (restoreFrom.metadata.shellExited === true) return;
    try {
      const seeded = this.headlessFactory(session.cols, session.rows);
      session.headless = seeded;
      // Track the seed write so an immediate snapshot waits for it to parse.
      const seedBarrier = new Promise<void>((resolve) => {
        try {
          seeded.write(restoreFrom.buffer, () => resolve());
        } catch (err) {
          console.error("[AnyWhere Terminal] Failed to seed headless mirror from restore buffer:", err);
          resolve();
        }
      });
      this.writeBarriers.set(session.id, seedBarrier);
    } catch (err) {
      console.error("[AnyWhere Terminal] Failed to construct seeded headless mirror:", err);
    }
  }

  /**
   * Called by SessionManager.cleanupSession. Disposes the headless mirror +
   * SerializeAddon, removes the index entry, unlinks the buffer file, and
   * schedules an index rewrite so the dropped entry doesn't linger.
   */
  detachSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session) this.disposeMirrorFor(session);

    this._pendingSessions.delete(sessionId);
    this.writeBarriers.delete(sessionId);
    if (this._snapshotIndex[sessionId]) {
      delete this._snapshotIndex[sessionId];
      if (this.storage) {
        try {
          this.storage.unlinkBufferFile(sessionId);
        } catch {
          /* best-effort */
        }
        this.storage.scheduleIndexWrite({ version: 1, entries: { ...this._snapshotIndex } });
      }
    }
  }

  // ─── PTY event hooks ────────────────────────────────────────────

  /**
   * Forward PTY bytes to the per-session xterm-headless mirror and schedule a
   * persist. Lazy-constructs the mirror on first data when restore is enabled.
   * Failures MUST NOT propagate — the user-visible PTY output and scrollback
   * cache already fired before this is called. See design.md D1.
   */
  recordData(session: TerminalSession, data: string): void {
    if (!this.restoreEnabled) return;
    // Once the shell has exited, freeze the mirror so post-exit noise doesn't
    // overwrite the captured state. See D13.
    if (session.shellExited) return;
    if (!session.headless) {
      try {
        session.headless = this.headlessFactory(session.cols, session.rows);
      } catch (err) {
        console.error("[AnyWhere Terminal] Failed to construct headless mirror:", err);
        return;
      }
    }
    // Chain the write callback onto the per-session barrier. Async flushes
    // await the latest barrier before serialize so the snapshot is consistent.
    // The map stores only the tail Promise — the chain itself stays
    // bounded because each `.then(() => writePromise)` returns a single
    // Promise (no nesting).
    const prior = this.writeBarriers.get(session.id) ?? Promise.resolve();
    const writePromise = new Promise<void>((resolve) => {
      try {
        // biome-ignore lint/style/noNonNullAssertion: just constructed above
        session.headless!.write(data, () => resolve());
      } catch (err) {
        console.error("[AnyWhere Terminal] Headless mirror write failed:", err);
        resolve();
      }
    });
    this.writeBarriers.set(session.id, prior.then(() => writePromise));
    this.schedulePersist(session.id);
  }

  /** Mirror a PTY resize. Best-effort — never break the user-facing resize on a mirror failure. */
  recordResize(session: TerminalSession, cols: number, rows: number): void {
    if (!session.headless) return;
    try {
      session.headless.resize(cols, rows);
    } catch {
      // headless is best-effort.
    }
  }

  /**
   * Reset the headless mirror to empty (RIS — `\x1bc`). Used by
   * `SessionManager.clearScrollback` so a user-triggered clear is also a
   * persistence boundary — the next snapshot reflects an empty buffer rather
   * than restoring the just-cleared content after a restart. See round-1 B2.
   */
  resetMirror(sessionId: string): void {
    if (!this.restoreEnabled) return;
    const session = this.getSession(sessionId);
    if (!session?.headless) return;
    // RIS (Reset to Initial State) clears the buffer, scrollback, and modes.
    // Track it in the barrier chain so the next serialize sees the empty state.
    const prior = this.writeBarriers.get(sessionId) ?? Promise.resolve();
    const resetPromise = new Promise<void>((resolve) => {
      try {
        // biome-ignore lint/style/noNonNullAssertion: checked above
        session.headless!.write("\x1bc", () => resolve());
      } catch (err) {
        console.error("[AnyWhere Terminal] Headless mirror reset failed:", err);
        resolve();
      }
    });
    this.writeBarriers.set(sessionId, prior.then(() => resetPromise));
    // Persist immediately so the cleared state survives a quick window close.
    void this.flushSessionImmediate(sessionId);
  }

  /**
   * Record an exit code on the session and freeze the mirror. Caller (SessionManager)
   * is responsible for firing the `onShellExited` hook (which by default kicks an
   * immediate flush).
   */
  recordExit(session: TerminalSession, exitCode: number | null): void {
    session.shellExited = true;
    session.exitCode = exitCode;
  }

  // ─── Snapshot generation ────────────────────────────────────────

  /**
   * Generate a snapshot for a single session. Returns metadata + serialized
   * buffer, or `null` when there is no headless mirror to serialize from.
   * The SerializeAddon instance is constructed on first call and cached on
   * the session.
   *
   * Buffer is truncated to 1 MB on output at the nearest LF boundary.
   */
  generateSnapshotMetadata(sessionId: string): { metadata: SessionSnapshotMetadata; buffer: string } | null {
    const session = this.getSession(sessionId);
    if (!session || !session.headless) return null;

    if (!session.serializeAddon) {
      try {
        const addon = this.serializeAddonFactory();
        session.headless.loadAddon(addon);
        session.serializeAddon = addon;
      } catch (err) {
        console.error("[AnyWhere Terminal] Failed to load SerializeAddon:", err);
        return null;
      }
    }

    let raw: string;
    try {
      raw = session.serializeAddon.serialize(SERIALIZE_OPTIONS);
    } catch (err) {
      console.error("[AnyWhere Terminal] SerializeAddon.serialize failed:", err);
      return null;
    }
    const buffer = truncateSnapshotBuffer(raw);
    const bufferBytes = Buffer.byteLength(buffer, "utf8");

    const viewLocation = viewLocationOf(session.viewId);
    const metadata: SessionSnapshotMetadata = {
      sessionId: session.id,
      panelId: session.panelId,
      viewLocation,
      terminalNumber: session.number,
      customName: session.customName,
      shell: session.shell ?? "",
      shellArgs: session.shellArgs ?? [],
      cwd: session.initialCwd ?? "",
      currentCwd: session.currentCwd ?? null,
      cols: session.cols,
      rows: session.rows,
      bufferFile: `snapshots/${session.id}.snapshot.ans`,
      bufferBytes,
      isSplitPane: session.isSplitPane,
      // For roots: own id. For splits: the owning tab's id (so eviction can
      // keep/drop split groups atomically). See round-1 B4.
      rootTabId: session.rootTabId ?? session.id,
      snapshotAt: Date.now(),
      shellExited: session.shellExited ?? false,
      exitCode: session.exitCode ?? null,
    };
    return { metadata, buffer };
  }

  // ─── Scheduling + flush ─────────────────────────────────────────

  /**
   * Mark a session for snapshot persistence. Hot loops are coalesced via a
   * single 1000ms debounce. No-op when restoreEnabled === false or no
   * SessionStorage is configured. See design.md D6.
   */
  schedulePersist(sessionId: string): void {
    if (!this.restoreEnabled || !this.storage) return;
    this._pendingSessions.add(sessionId);
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this.flushPending();
    }, SNAPSHOT_PERSIST_DEBOUNCE_MS);
  }

  /**
   * Bypass the debounce and persist a single session immediately. Used by the
   * shell-exit hook so the exit state lands on disk even if the user closes
   * the window in the next moment.
   */
  async flushSessionImmediate(sessionId: string): Promise<void> {
    if (!this.restoreEnabled || !this.storage) return;
    this._pendingSessions.add(sessionId);
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    await this.flushPending();
  }

  /**
   * Drain `_pendingSessions`: regenerate each snapshot, write its buffer file
   * (async), apply eviction, and schedule the index write. Errors per session
   * are swallowed and logged so a single broken session can't poison the rest.
   *
   * Generation guard: if `setRestoreEnabled(false)` (or storage swap) lands
   * mid-flush, the captured `generation` no longer matches the live one and
   * the flush aborts cleanly — preventing a stale write from resurrecting
   * a snapshot the purge just deleted. See `.reviews/round-1.md` W9.
   */
  private async flushPending(): Promise<void> {
    if (!this.storage || !this.restoreEnabled) return;
    const storage = this.storage;
    const generation = this._persistGeneration;
    const isStillCurrent = () =>
      this.restoreEnabled && this.storage === storage && this._persistGeneration === generation;
    const ids = Array.from(this._pendingSessions);
    this._pendingSessions.clear();
    for (const id of ids) {
      if (!isStillCurrent()) return;
      const session = this.getSession(id);
      if (!session) {
        // Session destroyed before flush — drop its index entry + buffer file.
        delete this._snapshotIndex[id];
        try {
          storage.unlinkBufferFile(id);
        } catch {
          /* best-effort */
        }
        continue;
      }
      // Wait for any in-flight headless writes to be parsed before serialize.
      // See round-1 B1.
      await this.awaitWriteBarrier(id);
      if (!isStillCurrent()) return;
      const result = this.generateSnapshotMetadata(id);
      if (!result) continue;
      try {
        await storage.writeBufferFileAsync(id, result.buffer);
      } catch (err) {
        if (!isStillCurrent()) return;
        console.error("[AnyWhere Terminal] writeBufferFileAsync failed:", err);
        continue;
      }
      if (!isStillCurrent()) {
        // Persistence was invalidated mid-await — unlink the just-written file.
        try {
          storage.unlinkBufferFile(id);
        } catch {
          /* best-effort */
        }
        return;
      }
      this._snapshotIndex[id] = result.metadata;
    }
    if (!isStillCurrent()) return;
    // Apply eviction before persisting the index.
    const merged: SessionSnapshotsIndex = { version: 1, entries: { ...this._snapshotIndex } };
    const { kept, dropped } = evictIndex(merged, Date.now());
    this._snapshotIndex = { ...kept.entries };
    for (const sid of dropped) {
      try {
        storage.unlinkBufferFile(sid);
      } catch {
        /* best-effort */
      }
    }
    storage.scheduleIndexWrite(kept);
  }

  /** Test/inspection helper — the latest in-memory snapshot index. */
  getSnapshotIndexEntries(): Record<string, SessionSnapshotMetadata> {
    return { ...this._snapshotIndex };
  }

  /**
   * Synchronously write the buffer file for every live session. Used in the
   * first step of `extension.deactivate` so buffers survive even when the
   * main-thread RPC is killed before the awaited index update lands.
   * Caller passes the list of live session ids.
   */
  flushSnapshotsSync(liveSessionIds: Iterable<string>): void {
    if (this._disposed || !this.restoreEnabled || !this.storage) return;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._pendingSessions.clear();
    for (const id of liveSessionIds) {
      const result = this.generateSnapshotMetadata(id);
      if (!result) continue;
      try {
        this.storage.writeBufferFileSync(id, result.buffer);
      } catch (err) {
        console.error("[AnyWhere Terminal] writeBufferFileSync failed:", err);
        continue;
      }
      this._snapshotIndex[id] = result.metadata;
    }
  }

  /**
   * Step 2 of the deactivate flush: persist the snapshot index via the awaited
   * Memento API. Live-panels record is owned by SessionManager (which calls
   * `storage.writeLivePanelsAwaited` directly via EditorPanelRegistry).
   */
  async flushIndexAwaited(): Promise<void> {
    if (this._disposed || !this.restoreEnabled || !this.storage) return;
    const merged: SessionSnapshotsIndex = { version: 1, entries: { ...this._snapshotIndex } };
    const { kept, dropped } = evictIndex(merged, Date.now());
    this._snapshotIndex = { ...kept.entries };
    for (const sid of dropped) {
      try {
        this.storage.unlinkBufferFile(sid);
      } catch {
        /* best-effort */
      }
    }
    await this.storage.writeIndexAwaited(kept);
  }

  // ─── Hydrate-on-activate ────────────────────────────────────────

  /**
   * Hydrate the pending-restore map from the persisted index (post-restart).
   * Reads each buffer file referenced by an index entry; entries whose buffer
   * file is missing/unreadable are dropped silently. Orphan buffer files (not
   * referenced by any surviving entry) are deleted. If the index is missing
   * but buffer files exist, a minimal index is reconstructed from the
   * surviving files. Exited entries are KEPT (restored read-only — see D13).
   *
   * No-op when restoreEnabled === false (the activate path is responsible for
   * purging persisted state in that case — see D11).
   */
  hydrateFromSnapshots(index?: SessionSnapshotsIndex): void {
    if (!this.restoreEnabled || !this.storage) return;
    const now = Date.now();
    const incoming: Record<string, SessionSnapshotMetadata> =
      index && index.version === 1 && index.entries ? { ...index.entries } : {};

    // Step 1 — Eviction (age, size, count). Drop expired entries first so we
    // don't load their buffer files.
    const initial: SessionSnapshotsIndex = { version: 1, entries: incoming };
    const { kept } = evictIndex(initial, now);
    const indexAfterEviction = { ...kept.entries };

    // Step 2 — Load buffer file for each surviving entry. Drop entries with
    // missing/unreadable files.
    const hydrated: Array<{ metadata: SessionSnapshotMetadata; buffer: string }> = [];
    for (const meta of Object.values(indexAfterEviction)) {
      const buf = this.storage.readBufferFile(meta.sessionId);
      if (buf === null) {
        delete indexAfterEviction[meta.sessionId];
        continue;
      }
      hydrated.push({ metadata: meta, buffer: buf });
    }

    // Step 3 — Buffer-file fallback. Inspect buffer files that survived on disk
    // but are absent from the index, not only when the index is entirely empty.
    // Covers a torn deactivate flush where new buffer files landed but the
    // awaited Memento index update was interrupted after an older partial index.
    // Reconstructed metadata defaults to a sidebar terminal with no shell config.
    for (const sessionId of this.storage.listBufferFiles()) {
      if (indexAfterEviction[sessionId]) continue;
      const buf = this.storage.readBufferFile(sessionId);
      if (buf === null) continue;
      // Note: preferred terminalNumber = 0 falls through to findAvailableNumber()
      // (which starts at 1). See SessionManager.reserveNumber.
      const meta: SessionSnapshotMetadata = {
        sessionId,
        viewLocation: "sidebar",
        terminalNumber: 0,
        customName: null,
        shell: "",
        shellArgs: [],
        cwd: "",
        currentCwd: null,
        cols: 80,
        rows: 24,
        bufferFile: this.storage.bufferFileRelativePath(sessionId),
        bufferBytes: Buffer.byteLength(buf, "utf8"),
        isSplitPane: false,
        rootTabId: sessionId,
        snapshotAt: now,
        shellExited: false,
        exitCode: null,
      };
      hydrated.push({ metadata: meta, buffer: buf });
      indexAfterEviction[sessionId] = meta;
    }

    // Step 4 — Orphan cleanup. Any buffer file not referenced by the surviving
    // index must be unlinked.
    const surviving = new Set(Object.keys(indexAfterEviction));
    for (const sessionId of this.storage.listBufferFiles()) {
      if (!surviving.has(sessionId)) {
        try {
          this.storage.unlinkBufferFile(sessionId);
        } catch {
          /* best-effort */
        }
      }
    }

    // Step 5 — Stage in memory.
    this._pendingSnapshots.clear();
    for (const item of hydrated) {
      this._pendingSnapshots.set(item.metadata.sessionId, item);
    }
    this._snapshotIndex = { ...indexAfterEviction };
  }

  // ─── Pending restore snapshot consumption ───────────────────────

  hasSnapshotsForLocation(loc: "sidebar" | "panel"): boolean {
    for (const snap of this._pendingSnapshots.values()) {
      if (snap.metadata.viewLocation === loc) return true;
    }
    return false;
  }

  /**
   * Drain pending snapshots for a sidebar/panel location. Returned entries
   * (including exited ones, per D13) are removed from the pending map.
   */
  consumeSnapshotsForLocation(loc: "sidebar" | "panel"): PendingSnapshot[] {
    const out: PendingSnapshot[] = [];
    for (const [sessionId, snap] of this._pendingSnapshots) {
      if (snap.metadata.viewLocation === loc) {
        out.push(snap);
        this._pendingSnapshots.delete(sessionId);
      }
    }
    return out;
  }

  /**
   * Test-only seam: stage a single PendingSnapshot directly without going
   * through the full `hydrateFromSnapshots` storage I/O path. Used by tests
   * exercising provider onReady restore branches.
   */
  __stagePendingSnapshot(snap: PendingSnapshot): void {
    this._pendingSnapshots.set(snap.metadata.sessionId, snap);
  }

  /** Drain pending snapshots for a specific editor panelId. */
  consumeSnapshotsForPanel(panelId: string): PendingSnapshot[] {
    const out: PendingSnapshot[] = [];
    for (const [sessionId, snap] of this._pendingSnapshots) {
      if (snap.metadata.viewLocation === "editor" && snap.metadata.panelId === panelId) {
        out.push(snap);
        this._pendingSnapshots.delete(sessionId);
      }
    }
    return out;
  }

  // ─── Shutdown ───────────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._pendingSessions.clear();
    // Disposal of per-session mirrors is performed by SessionManager via
    // detachSession during cleanupSession (called as it tears down each PTY).
  }

  // ─── Private helpers ────────────────────────────────────────────

  /** Wait for the current write barrier to settle. Best-effort — never throws. */
  private async awaitWriteBarrier(sessionId: string): Promise<void> {
    const barrier = this.writeBarriers.get(sessionId);
    if (!barrier) return;
    try {
      await barrier;
    } catch {
      // The write promise resolver swallows errors; this catch is defensive.
    }
  }

  private disposeMirrorFor(session: TerminalSession): void {
    if (session.serializeAddon) {
      try {
        session.serializeAddon.dispose();
      } catch {
        /* best-effort */
      }
      session.serializeAddon = undefined;
    }
    if (session.headless) {
      try {
        session.headless.dispose();
      } catch {
        /* best-effort */
      }
      session.headless = undefined;
    }
  }
}
