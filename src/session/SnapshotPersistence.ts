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
  /**
   * Optional editor-panel registry — used during hydrate orphan fallback (W2)
   * to map a torn-flush orphan buffer back to its owning editor panel rather
   * than defaulting to sidebar.
   */
  editorPanels?: {
    findPanelForSession(sessionId: string): string | undefined;
  };
}

export class SnapshotPersistence {
  private readonly headlessFactory: HeadlessFactory;
  private readonly serializeAddonFactory: SerializeAddonFactory;
  private readonly getSession: (id: string) => TerminalSession | undefined;
  private readonly editorPanels?: { findPanelForSession(sessionId: string): string | undefined };
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

  /**
   * Per-session epoch token. Bumped by any destructive op that invalidates
   * an in-flight snapshot write: `detachSession`, `resetMirror`,
   * `purgePersistedSnapshot`, `flushSessionImmediateSync`. `flushPending`
   * captures the epoch BEFORE serializing the buffer; after the await on
   * `writeBufferFileAsync` it re-checks — if the epoch advanced, the just-
   * written buffer is stale (e.g. clearScrollback fired while we were mid-
   * write), so we unlink the ghost file and skip the index assignment.
   * See `.reviews/round-4.md` [B2].
   */
  private _sessionEpochs = new Map<string, number>();

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
    this.editorPanels = opts.editorPanels;
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
   *
   * Always bumps the per-session epoch — any in-flight async flush that
   * captured the prior epoch will detect the mismatch after its
   * writeBufferFileAsync await and unlink the ghost write rather than
   * resurrect this session's index entry.
   */
  detachSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session) this.disposeMirrorFor(session);

    this.bumpEpoch(sessionId);
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
    } else if (this.storage) {
      // No index entry (never flushed), but a buffer file MAY exist if a
      // sync exit-snapshot raced ahead. Best-effort unlink so deactivate
      // doesn't leave a ghost file behind for orphan recovery.
      try {
        this.storage.unlinkBufferFile(sessionId);
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Release just the runtime mirror resources (headless terminal + serialize
   * addon + in-memory queues) WITHOUT unlinking the on-disk buffer file or
   * dropping the index entry. Use during extension `deactivate` so the just-
   * persisted snapshots survive to the next activate.
   *
   * Distinct from `detachSession`, which is the per-session destruction path
   * (user closes tab → snapshot deliberately removed). Conflating the two
   * caused the cross-restart-restore failure: `dispose()` was calling
   * `detachSession` and unlinking every buffer file we'd just written in
   * `flushSnapshotsSync` milliseconds earlier.
   */
  releaseMirror(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session) this.disposeMirrorFor(session);
    this._pendingSessions.delete(sessionId);
    this.writeBarriers.delete(sessionId);
    // Bump epoch so any in-flight async write that captured the prior epoch
    // is invalidated — otherwise a late writeBufferFileAsync completion
    // could resurrect a snapshot whose mirror we just disposed.
    this.bumpEpoch(sessionId);
    // Intentionally NOT touching _snapshotIndex or the on-disk buffer file.
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
   *
   * When the session has no headless mirror (restored exited sessions skip
   * mirror seeding — see `attachSession`), there is nothing to RIS into. We
   * still MUST honor the privacy contract: directly purge the persisted
   * buffer file and the index entry so the next restart doesn't resurrect
   * the cleared content. See round-2 [B1].
   */
  resetMirror(sessionId: string): void {
    if (!this.restoreEnabled) return;
    const session = this.getSession(sessionId);
    if (!session) return;

    // Bump epoch FIRST so an in-flight pre-clear flush is invalidated by the
    // time its writeBufferFileAsync resolves. Without this, the late stale
    // write could overwrite the cleared metadata. See .reviews/round-4.md [B2].
    this.bumpEpoch(sessionId);

    if (!session.headless) {
      this.purgePersistedSnapshot(sessionId);
      return;
    }

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
   * Drop the persisted snapshot for a still-alive session — unlinks the buffer
   * file and removes the index entry, leaving the session itself untouched.
   * Distinct from `detachSession` which is the destruction path. Used by
   * `resetMirror` on no-mirror sessions so a `Cmd+K` on a restored-exited
   * terminal still acts as a privacy boundary. See round-2 [B1].
   */
  private purgePersistedSnapshot(sessionId: string): void {
    if (!this.storage) return;
    // Bump epoch so any in-flight async write that captured the prior epoch
    // unlinks the ghost file post-write rather than re-inserting an index entry.
    this.bumpEpoch(sessionId);
    this._pendingSessions.delete(sessionId);
    if (this._snapshotIndex[sessionId]) {
      delete this._snapshotIndex[sessionId];
    }
    try {
      this.storage.unlinkBufferFile(sessionId);
    } catch {
      /* best-effort */
    }
    this.storage.scheduleIndexWrite({ version: 1, entries: { ...this._snapshotIndex } });
    // Keep sidecar in sync — privacy boundary requires no on-disk trail of the
    // cleared session even if the Memento update is later Canceled. See
    // .reviews/round-4.md D2 (was suppressed; cheap to fix alongside B2).
    try {
      this.storage.writeIndexSync({ version: 1, entries: { ...this._snapshotIndex } });
    } catch {
      /* best-effort */
    }
  }

  /** Increment the per-session epoch token. See `_sessionEpochs`. */
  private bumpEpoch(sessionId: string): void {
    this._sessionEpochs.set(sessionId, (this._sessionEpochs.get(sessionId) ?? 0) + 1);
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
   * SYNCHRONOUSLY persist a single session's snapshot. Captures the current
   * mirror state via SerializeAddon, writes the buffer file via the sync fs
   * API, updates `_snapshotIndex` and the sync sidecar. Used by the default
   * shell-exit hook so the exit snapshot is durable BEFORE cleanupSession
   * runs (which previously raced — the async flush couldn't complete before
   * cleanupSession unlinked the file). See .reviews/round-4.md [B3].
   *
   * Returns early when restore is disabled, storage is unset, or the session
   * has no headless mirror (nothing to serialize).
   */
  flushSessionImmediateSync(sessionId: string): void {
    if (this._disposed || !this.restoreEnabled || !this.storage) return;
    this._pendingSessions.delete(sessionId);
    // Bump the epoch up front so any in-flight async write for this session
    // (e.g. a pending debounced flush) is invalidated by the time it returns.
    this.bumpEpoch(sessionId);
    const result = this.generateSnapshotMetadata(sessionId);
    if (!result) return;
    try {
      this.storage.writeBufferFileSync(sessionId, result.buffer);
    } catch (err) {
      console.error("[AnyWhere Terminal] flushSessionImmediateSync writeBufferFileSync failed:", err);
      return;
    }
    this._snapshotIndex[sessionId] = result.metadata;
    // Persist the index synchronously via sidecar so a sudden window close
    // immediately after exit doesn't lose this entry. The awaited Memento
    // update would race with shutdown's Memento cancellation.
    try {
      this.storage.writeIndexSync({ version: 1, entries: { ...this._snapshotIndex } });
    } catch (err) {
      console.error("[AnyWhere Terminal] flushSessionImmediateSync writeIndexSync failed:", err);
    }
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
      // Capture the per-session epoch BEFORE serialize/write. resetMirror /
      // detachSession / releaseMirror / purgePersistedSnapshot /
      // flushSessionImmediateSync all bump the epoch — if any of them fires
      // while we're mid-await, the post-write check below detects the
      // mismatch and unlinks our (now stale) write rather than overwriting
      // the newer state. See .reviews/round-4.md [B2].
      const capturedEpoch = this._sessionEpochs.get(id) ?? 0;
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
      // Per-session epoch re-check: a destructive op (resetMirror, detach,
      // releaseMirror, sync exit-flush) may have bumped the epoch DURING our
      // writeBufferFileAsync await. Our captured buffer is now stale relative
      // to the newer post-op state. Unlink the ghost file we just wrote and
      // skip the metadata assignment so the newer state stays authoritative.
      // See .reviews/round-4.md [B2].
      const currentEpoch = this._sessionEpochs.get(id) ?? 0;
      if (currentEpoch !== capturedEpoch) {
        try {
          storage.unlinkBufferFile(id);
        } catch {
          /* best-effort */
        }
        continue;
      }
      // Per-session liveness re-check: detachSession may have run during the
      // writeBufferFileAsync await above (session destroyed mid-flush). The
      // global generation guard does NOT cover per-session destroys — it's
      // only bumped on setRestoreEnabled. Without this check, the assignment
      // below resurrects an index entry detachSession just dropped, and the
      // file we just wrote becomes a ghost snapshot for a session the user
      // already killed. See round-2 [W3].
      if (!this.getSession(id)) {
        try {
          storage.unlinkBufferFile(id);
        } catch {
          /* best-effort */
        }
        continue;
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
    // Persist the index synchronously alongside the buffer files. VS Code's
    // `Memento.update()` returns a cancelled Thenable when the ext host is
    // shutting down — without this sidecar, the index update silently dies and
    // the next activate sees a stale index referencing prior-session ids whose
    // files are no longer on disk. The sidecar is the authoritative source on
    // load; Memento is the legacy fallback. See `SessionStorage.loadIndex`.
    try {
      const merged: SessionSnapshotsIndex = { version: 1, entries: { ...this._snapshotIndex } };
      const { kept, dropped } = evictIndex(merged, Date.now());
      for (const sid of dropped) {
        try {
          this.storage.unlinkBufferFile(sid);
        } catch {
          /* best-effort */
        }
      }
      this._snapshotIndex = { ...kept.entries };
      this.storage.writeIndexSync(kept);
    } catch (err) {
      console.error("[AnyWhere Terminal] writeIndexSync failed:", err);
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
    // Prefer the typed loadIndexDetailed result over the passed-in legacy
    // arg — only the detailed loader can distinguish "missing" (orphan
    // recovery OK) from "unsupported" (entire restore set MUST be
    // discarded, per .reviews/round-4.md [W3] and round-1 W1).
    //
    // The optional `index` parameter is retained for tests that bypass the
    // storage layer. When passed, it's treated identically to the legacy
    // call site that previously did `hydrateFromSnapshots(loadIndex())`.
    let kind: "valid" | "missing" | "unsupported";
    let incoming: Record<string, SessionSnapshotMetadata>;
    if (index !== undefined) {
      // Caller passed an index explicitly — preserve legacy semantics:
      // wrong version is treated as corrupted (discard, no orphan recovery).
      if (index.version === 1 && index.entries) {
        kind = "valid";
        incoming = { ...index.entries };
      } else {
        kind = "unsupported";
        incoming = {};
      }
    } else if (this.storage.loadIndexDetailed) {
      const detailed = this.storage.loadIndexDetailed();
      kind = detailed.kind;
      incoming = detailed.kind === "valid" ? { ...detailed.index.entries } : {};
    } else {
      // Storage shim without the detailed loader — fall back to legacy load.
      const loaded = this.storage.loadIndex();
      if (loaded && loaded.version === 1 && loaded.entries) {
        kind = "valid";
        incoming = { ...loaded.entries };
      } else if (loaded === undefined) {
        kind = "missing";
        incoming = {};
      } else {
        kind = "unsupported";
        incoming = {};
      }
    }
    // Legacy alias for the orphan-recovery gate below.
    const indexCorrupted = kind === "unsupported";

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
    // but are absent from the index. Covers a torn deactivate flush where new
    // buffer files landed but the awaited Memento index update was interrupted
    // after an older partial index. Skipped entirely when the index was present
    // but corrupted (unsupported version) — per spec, corrupted state is
    // discarded, not recovered. See round-1 W1.
    if (!indexCorrupted) {
      for (const sessionId of this.storage.listBufferFiles()) {
        if (indexAfterEviction[sessionId]) continue;
        let buf: string | null;
        try {
          buf = this.storage.readBufferFile(sessionId);
        } catch {
          // SessionStorage may reject unsafe sessionIds (W8 path-traversal guard).
          continue;
        }
        if (buf === null) continue;
        // Live-panels lookup: if this orphan was previously an editor session,
        // restore it AS an editor session under the same panel — otherwise it
        // defaults to a sidebar terminal. See round-1 W2.
        const owningPanelId = this.editorPanels?.findPanelForSession(sessionId);
        // Note: preferred terminalNumber = 0 falls through to findAvailableNumber()
        // (which starts at 1). See SessionManager.reserveNumber.
        const meta: SessionSnapshotMetadata = {
          sessionId,
          panelId: owningPanelId,
          viewLocation: owningPanelId ? "editor" : "sidebar",
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
