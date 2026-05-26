// Two-tier persistence for terminal session snapshots.
// - workspaceState: metadata index (anywhereTerminal.sessionSnapshots.index, ~8KB)
//                   + live-panels record (anywhereTerminal.editorPanels.live).
// - storageUri:    serialized buffers as files `<storageUri>/snapshots/<sessionId>.snapshot.ans`.
//
// Design: asimov/changes/restore-terminal-sessions/design.md D4, D5, D6, D11.

import * as path from "node:path";
import type * as vscode from "vscode";
import {
  LIVE_EDITOR_PANELS_KEY,
  type LiveEditorPanelsRecord,
  SESSION_SNAPSHOTS_INDEX_KEY,
  type SessionSnapshotsIndex,
} from "./SessionSnapshot";

export interface FsLike {
  writeFileSync: (file: string, data: string) => void;
  readFileSync: (file: string, encoding: "utf8") => string;
  mkdirSync: (dir: string, options?: { recursive?: boolean }) => void;
  existsSync: (file: string) => boolean;
  unlinkSync: (file: string) => void;
  readdirSync: (dir: string) => string[];
  renameSync: (from: string, to: string) => void;
  rmSync?: (dir: string, options?: { recursive?: boolean; force?: boolean }) => void;
  promises: {
    writeFile: (file: string, data: string) => Promise<void>;
    readFile: (file: string, encoding: "utf8") => Promise<string>;
    mkdir: (dir: string, options?: { recursive?: boolean }) => Promise<unknown>;
    unlink: (file: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
  };
}

const INDEX_DEBOUNCE_MS = 1000;

export class SessionStorage {
  private readonly snapshotsDir: string;

  /**
   * Per-buffer generation counter. Bumped by sync writers AND drops BEFORE
   * the disk op. Async writers capture the gen before serializing and check
   * it on rename — mismatch means a sync/drop won the race; the async result
   * is stale and writes only to its temp file, NEVER touching the canonical
   * path. Eliminates the R5.B1 race where stale unlinks deleted live data.
   * See design.md D16.
   */
  private bufferGens: Map<string, number> = new Map();
  /**
   * Sidecar generation counter. Same semantics as bufferGens but for the
   * shared `<snapshotsDir>/index.json` artifact. Eliminates R5.B2 where a
   * fire-and-forget async sidecar write landed AFTER a sync sidecar write
   * and left the on-disk state stale relative to deactivate.
   */
  private sidecarGen: number = 0;
  /**
   * Monotonic temp-id counter — each in-flight write picks a unique temp
   * path so concurrent async writers cannot clobber each other's spool.
   */
  private tempCounter: number = 0;

  constructor(
    private readonly workspaceState: vscode.Memento,
    readonly storageUri: vscode.Uri,
    private readonly fs: FsLike,
  ) {
    this.snapshotsDir = path.join(storageUri.fsPath, "snapshots");
  }

  /**
   * Load the index. Prefers the sync-written sidecar file at
   * `<storageUri>/snapshots/index.json` — that file is written by
   * `flushSnapshotsSync` during deactivate using a synchronous fs API, so it
   * survives the Memento `update()` cancellation VS Code raises mid-shutdown.
   * Falls back to the workspaceState entry (older builds wrote only there).
   */
  loadIndex(): SessionSnapshotsIndex | undefined {
    const detailed = this.loadIndexDetailed();
    return detailed.kind === "valid" ? detailed.index : undefined;
  }

  /**
   * Detailed load — distinguishes "no index present" from "present but the
   * version is unsupported". Reads the SIDECAR ONLY (design.md D17) — the
   * Memento path was dropped to eliminate the dual-source bug class that
   * round-5 surfaced. One-time migration on activate (see
   * `migrateMementoIndexToSidecar`) copies legacy Memento payloads into the
   * sidecar so upgraded users don't lose their first-session restore.
   */
  loadIndexDetailed():
    | { kind: "valid"; index: SessionSnapshotsIndex }
    | { kind: "missing" }
    | { kind: "unsupported" } {
    const sidecar = this.indexSidecarPath();
    if (!this.fs.existsSync(sidecar)) return { kind: "missing" };
    try {
      const raw = this.fs.readFileSync(sidecar, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSnapshotsIndex>;
      if (parsed && typeof parsed === "object") {
        if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
          return { kind: "valid", index: parsed as SessionSnapshotsIndex };
        }
        // Sidecar present but version we don't understand — authoritative
        // rejection. Corrupted state is discarded per spec; no orphan
        // recovery runs in this case.
        return { kind: "unsupported" };
      }
    } catch {
      // Torn-write / unreadable sidecar — treat as missing so orphan
      // recovery can still salvage individual buffer files. No fallback
      // to Memento (D17: sidecar is the single source of truth).
    }
    return { kind: "missing" };
  }

  /**
   * One-time activate-time migration: if no sidecar exists yet and a
   * legacy Memento snapshot index is present, copy it to the sidecar
   * (sync) and delete the Memento entry. After this, all reads + writes
   * go through the sidecar only. See design.md D17.
   *
   * Idempotent: if the sidecar already exists or no Memento payload is
   * present, this is a silent no-op. Caller (extension.activate) invokes
   * this before any hydrate.
   */
  migrateMementoIndexToSidecar(): void {
    if (this.fs.existsSync(this.indexSidecarPath())) return;
    const mem = this.workspaceState.get<SessionSnapshotsIndex>(SESSION_SNAPSHOTS_INDEX_KEY);
    if (!mem || typeof mem !== "object") return;
    if (mem.version !== 1 || !mem.entries) {
      // Unsupported legacy payload — drop the Memento entry; nothing to migrate.
      try {
        void this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined);
      } catch {
        /* best-effort */
      }
      return;
    }
    try {
      this.commitIndexSync(mem);
    } catch (err) {
      console.error("[AnyWhere Terminal] migrateMementoIndexToSidecar commitIndexSync failed:", err);
      return;
    }
    // Best-effort drop the legacy Memento entry — even if it fails
    // (Canceled mid-shutdown), the sidecar is now authoritative.
    try {
      void this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined);
    } catch {
      /* best-effort */
    }
  }

  loadLivePanels(): LiveEditorPanelsRecord | undefined {
    return this.workspaceState.get<LiveEditorPanelsRecord>(LIVE_EDITOR_PANELS_KEY);
  }

  /**
   * Defensive: a poisoned `sessionId` from `workspaceState` (another extension
   * with FS write access could plant `../../etc`) would otherwise escape
   * `snapshotsDir` through `path.join`. Fresh sessions use `crypto.randomUUID`
   * which is safe by construction; this check guards the restored / hydrated
   * path. See round-1 W8.
   */
  private assertSafeSessionId(sessionId: string): void {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("[AnyWhere Terminal] Invalid sessionId: empty");
    }
    if (path.basename(sessionId) !== sessionId) {
      throw new Error(`[AnyWhere Terminal] Refusing path-traversal sessionId: ${sessionId}`);
    }
    if (sessionId.startsWith(".") || sessionId.includes("/") || sessionId.includes("\\")) {
      throw new Error(`[AnyWhere Terminal] Refusing unsafe sessionId: ${sessionId}`);
    }
  }

  bufferFilePath(sessionId: string): string {
    this.assertSafeSessionId(sessionId);
    return path.join(this.snapshotsDir, `${sessionId}.snapshot.ans`);
  }

  bufferFileRelativePath(sessionId: string): string {
    this.assertSafeSessionId(sessionId);
    return path.posix.join("snapshots", `${sessionId}.snapshot.ans`);
  }

  private ensureSnapshotsDir(): void {
    this.fs.mkdirSync(this.snapshotsDir, { recursive: true });
  }

  private indexSidecarPath(): string {
    return path.join(this.snapshotsDir, "index.json");
  }

  readBufferFile(sessionId: string): string | null {
    let file: string;
    try {
      file = this.bufferFilePath(sessionId);
    } catch (err) {
      console.warn("[AnyWhere Terminal] readBufferFile rejected unsafe sessionId:", err);
      return null;
    }
    if (!this.fs.existsSync(file)) {
      return null;
    }
    try {
      return this.fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  listBufferFiles(): string[] {
    try {
      if (!this.fs.existsSync(this.snapshotsDir)) {
        return [];
      }
      return this.fs
        .readdirSync(this.snapshotsDir)
        .filter((name) => name.endsWith(".snapshot.ans"))
        .map((name) => name.replace(/\.snapshot\.ans$/, ""));
    } catch {
      return [];
    }
  }

  // ─── Transactional commit API (design.md D16) ──────────────────────
  //
  // Sync writers / drops bump the per-artifact generation BEFORE the disk
  // op. Async writers capture-then-act-then-recheck — if the gen moved
  // during their await, they unlink their temp file ONLY (never canonical).
  // All writes go through `<canonical>.tmp.<n>` + `renameSync` / `rename`
  // for atomicity on the same filesystem.

  /** Snapshot the current buffer generation for `id` — pass to commitBufferAsync later. */
  currentBufferGen(sessionId: string): number {
    return this.bufferGens.get(sessionId) ?? 0;
  }

  /** Snapshot the current sidecar generation — pass to commitIndexAsync later. */
  currentSidecarGen(): number {
    return this.sidecarGen;
  }

  private nextTempId(): number {
    return ++this.tempCounter;
  }

  private tempPath(canonical: string, tempId: number): string {
    return `${canonical}.tmp.${tempId}`;
  }

  private bumpBufferGen(sessionId: string): number {
    const next = (this.bufferGens.get(sessionId) ?? 0) + 1;
    this.bufferGens.set(sessionId, next);
    return next;
  }

  /**
   * Synchronously commit a buffer snapshot. Bumps gen FIRST so any in-flight
   * async writer sees the mismatch on its post-write check and unlinks only
   * its temp.
   */
  commitBufferSync(sessionId: string, data: string): void {
    const canonical = this.bufferFilePath(sessionId);
    this.bumpBufferGen(sessionId);
    this.ensureSnapshotsDir();
    const temp = this.tempPath(canonical, this.nextTempId());
    this.fs.writeFileSync(temp, data);
    this.fs.renameSync(temp, canonical);
  }

  /**
   * Async commit a buffer snapshot. Caller must pass the gen they captured
   * before serializing. Two checkpoints (pre-write + pre-rename) ensure a
   * stale write never reaches the canonical path. Returns the outcome so
   * the caller can skip the in-memory index update on stale results.
   */
  async commitBufferAsync(
    sessionId: string,
    data: string,
    capturedGen: number,
  ): Promise<"renamed" | "stale-skipped" | "stale-post-write"> {
    // Pre-write check: if the gen already advanced past `capturedGen`,
    // someone else's sync write / drop won the race before we even mkdir'd.
    if ((this.bufferGens.get(sessionId) ?? 0) !== capturedGen) return "stale-skipped";
    const canonical = this.bufferFilePath(sessionId);
    await this.fs.promises.mkdir(this.snapshotsDir, { recursive: true });
    const temp = this.tempPath(canonical, this.nextTempId());
    await this.fs.promises.writeFile(temp, data);
    // Post-write, pre-rename check: a sync writer / drop may have run
    // during our await. Mismatch → clean up the temp and bail; never
    // overwrite the canonical with our stale data.
    if ((this.bufferGens.get(sessionId) ?? 0) !== capturedGen) {
      try {
        await this.fs.promises.unlink(temp);
      } catch {
        /* best-effort */
      }
      return "stale-post-write";
    }
    await this.fs.promises.rename(temp, canonical);
    return "renamed";
  }

  /**
   * Drop a session's buffer file. Bumps the gen so any in-flight async
   * writer sees the mismatch and unlinks its temp only — preventing the
   * R5.B1 race where the async stale unlink targeted the canonical path.
   */
  dropBuffer(sessionId: string): void {
    this.bumpBufferGen(sessionId);
    let canonical: string;
    try {
      canonical = this.bufferFilePath(sessionId);
    } catch (err) {
      console.warn("[AnyWhere Terminal] dropBuffer rejected unsafe sessionId:", err);
      return;
    }
    try {
      if (this.fs.existsSync(canonical)) {
        this.fs.unlinkSync(canonical);
      }
    } catch {
      /* best-effort */
    }
  }

  /** Synchronously commit the snapshot index sidecar. Bumps sidecarGen first. */
  commitIndexSync(index: SessionSnapshotsIndex): void {
    this.sidecarGen += 1;
    this.ensureSnapshotsDir();
    const canonical = this.indexSidecarPath();
    const temp = this.tempPath(canonical, this.nextTempId());
    this.fs.writeFileSync(temp, JSON.stringify(index));
    this.fs.renameSync(temp, canonical);
  }

  /** Async commit the snapshot index sidecar with a generation check. */
  async commitIndexAsync(
    index: SessionSnapshotsIndex,
    capturedGen: number,
  ): Promise<"renamed" | "stale-skipped" | "stale-post-write"> {
    if (this.sidecarGen !== capturedGen) return "stale-skipped";
    await this.fs.promises.mkdir(this.snapshotsDir, { recursive: true });
    const canonical = this.indexSidecarPath();
    const temp = this.tempPath(canonical, this.nextTempId());
    await this.fs.promises.writeFile(temp, JSON.stringify(index));
    if (this.sidecarGen !== capturedGen) {
      try {
        await this.fs.promises.unlink(temp);
      } catch {
        /* best-effort */
      }
      return "stale-post-write";
    }
    await this.fs.promises.rename(temp, canonical);
    return "renamed";
  }

  /**
   * Best-effort cleanup of stray `*.tmp.*` files in the snapshots dir.
   * Called from hydrate after activate to remove any temp file that was
   * left orphaned by a process crash mid-rename. See design.md D16.
   */
  cleanupOrphanTemps(): void {
    try {
      if (!this.fs.existsSync(this.snapshotsDir)) return;
      for (const name of this.fs.readdirSync(this.snapshotsDir)) {
        if (name.includes(".tmp.")) {
          try {
            this.fs.unlinkSync(path.join(this.snapshotsDir, name));
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }

  // ─── Legacy timers (kept until R-4 drops Memento dual-write) ────────

  private livePanelsTimer: NodeJS.Timeout | null = null;
  private pendingLivePanels: LiveEditorPanelsRecord | null = null;

  scheduleLivePanelsWrite(record: LiveEditorPanelsRecord): void {
    this.pendingLivePanels = record;
    if (this.livePanelsTimer) {
      return;
    }
    this.livePanelsTimer = setTimeout(() => {
      this.livePanelsTimer = null;
      const toWrite = this.pendingLivePanels;
      this.pendingLivePanels = null;
      if (!toWrite) {
        return;
      }
      void this.workspaceState.update(LIVE_EDITOR_PANELS_KEY, toWrite);
    }, INDEX_DEBOUNCE_MS);
  }

  cancelPendingIndex(): void {
    if (this.livePanelsTimer) {
      clearTimeout(this.livePanelsTimer);
      this.livePanelsTimer = null;
    }
    this.pendingLivePanels = null;
  }

  async writeLivePanelsAwaited(record: LiveEditorPanelsRecord): Promise<void> {
    await this.workspaceState.update(LIVE_EDITOR_PANELS_KEY, record);
  }

  async purge(): Promise<void> {
    this.cancelPendingIndex();
    // FILE CLEANUP MUST RUN FIRST — VS Code raises a `Canceled` Thenable on
    // `Memento.update()` during ext-host shutdown. If we awaited Memento
    // before touching disk, a Canceled rejection would leave the sidecar +
    // buffer files behind for the next activate to hydrate as phantoms.
    // See .reviews/round-4.md [B4].
    try {
      if (this.fs.existsSync(this.snapshotsDir)) {
        if (this.fs.rmSync) {
          this.fs.rmSync(this.snapshotsDir, { recursive: true, force: true });
        } else {
          for (const name of this.fs.readdirSync(this.snapshotsDir)) {
            try {
              this.fs.unlinkSync(path.join(this.snapshotsDir, name));
            } catch {
              /* best-effort */
            }
          }
        }
      }
    } catch {
      // best-effort cleanup
    }
    // Each Memento update is independently try/awaited so a Canceled on the
    // first does not block the second. The sidecar is the source of truth
    // (D17) and is already cleared above; Memento entries are best-effort.
    // See .reviews/round-5.md [W2].
    try {
      await this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined);
    } catch {
      /* best-effort */
    }
    try {
      await this.workspaceState.update(LIVE_EDITOR_PANELS_KEY, undefined);
    } catch {
      /* best-effort */
    }
  }
}
