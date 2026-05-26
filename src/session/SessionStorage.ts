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
  rmSync?: (dir: string, options?: { recursive?: boolean; force?: boolean }) => void;
  promises: {
    writeFile: (file: string, data: string) => Promise<void>;
    readFile: (file: string, encoding: "utf8") => Promise<string>;
    mkdir: (dir: string, options?: { recursive?: boolean }) => Promise<unknown>;
    unlink: (file: string) => Promise<void>;
  };
}

const INDEX_DEBOUNCE_MS = 1000;

export class SessionStorage {
  private readonly snapshotsDir: string;
  private indexTimer: NodeJS.Timeout | null = null;
  private pendingIndex: SessionSnapshotsIndex | null = null;

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
   * version is unsupported". Hydrate MUST consult this variant so it can
   * gate orphan recovery on the `missing` case only; an `unsupported` index
   * is authoritative-and-rejected — the entire restore set is discarded per
   * round-1 W1 and .reviews/round-4.md [W3].
   */
  loadIndexDetailed():
    | { kind: "valid"; index: SessionSnapshotsIndex }
    | { kind: "missing" }
    | { kind: "unsupported" } {
    const sidecar = this.indexSidecarPath();
    if (this.fs.existsSync(sidecar)) {
      try {
        const raw = this.fs.readFileSync(sidecar, "utf8");
        const parsed = JSON.parse(raw) as Partial<SessionSnapshotsIndex>;
        if (parsed && typeof parsed === "object") {
          if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
            return { kind: "valid", index: parsed as SessionSnapshotsIndex };
          }
          // Sidecar present but version we don't understand — authoritative
          // rejection. Do NOT fall through to Memento (would be stale relative
          // to whatever wrote the sidecar) and do NOT run orphan recovery
          // (corrupted state is discarded per spec).
          return { kind: "unsupported" };
        }
      } catch {
        // Torn-write / unreadable sidecar — fall through to Memento as legacy
        // recovery. This is "missing" not "unsupported": we have no signal
        // about which version was intended.
      }
    }
    const mem = this.workspaceState.get<SessionSnapshotsIndex>(SESSION_SNAPSHOTS_INDEX_KEY);
    if (mem === undefined) return { kind: "missing" };
    if (mem && typeof mem === "object" && mem.version === 1 && mem.entries) {
      return { kind: "valid", index: mem };
    }
    return { kind: "unsupported" };
  }

  /**
   * Synchronously persist the index to a sidecar file at
   * `<storageUri>/snapshots/index.json`. Used by `flushSnapshotsSync` during
   * deactivate so the index survives the Memento `update()` cancellation that
   * VS Code raises while the extension host shuts down.
   */
  writeIndexSync(index: SessionSnapshotsIndex): void {
    this.ensureSnapshotsDir();
    this.fs.writeFileSync(this.indexSidecarPath(), JSON.stringify(index));
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

  private async writeIndexFile(index: SessionSnapshotsIndex): Promise<void> {
    await this.fs.promises.mkdir(this.snapshotsDir, { recursive: true });
    await this.fs.promises.writeFile(this.indexSidecarPath(), JSON.stringify(index));
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

  writeBufferFileSync(sessionId: string, data: string): void {
    // Validate before mkdirSync so a poisoned sessionId never even creates the
    // dir or writes a partial path. assertSafeSessionId throws on rejection.
    const file = this.bufferFilePath(sessionId);
    this.ensureSnapshotsDir();
    this.fs.writeFileSync(file, data);
  }

  async writeBufferFileAsync(sessionId: string, data: string): Promise<void> {
    const file = this.bufferFilePath(sessionId);
    await this.fs.promises.mkdir(this.snapshotsDir, { recursive: true });
    await this.fs.promises.writeFile(file, data);
  }

  unlinkBufferFile(sessionId: string): void {
    let file: string;
    try {
      file = this.bufferFilePath(sessionId);
    } catch (err) {
      console.warn("[AnyWhere Terminal] unlinkBufferFile rejected unsafe sessionId:", err);
      return;
    }
    try {
      if (this.fs.existsSync(file)) {
        this.fs.unlinkSync(file);
      }
    } catch {
      // best-effort; partial deletes are tolerated.
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

  scheduleIndexWrite(index: SessionSnapshotsIndex): void {
    this.pendingIndex = index;
    if (this.indexTimer) {
      return;
    }
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      const toWrite = this.pendingIndex;
      this.pendingIndex = null;
      if (!toWrite) {
        return;
      }
      // Fire-and-forget; failure surfaces in dev logs, not a crash.
      void this.writeIndexFile(toWrite).catch((err) => {
        console.error("[AnyWhere Terminal] writeIndexFile failed:", err);
      });
      void this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, toWrite);
    }, INDEX_DEBOUNCE_MS);
  }

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
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    this.pendingIndex = null;
    if (this.livePanelsTimer) {
      clearTimeout(this.livePanelsTimer);
      this.livePanelsTimer = null;
    }
    this.pendingLivePanels = null;
  }

  async writeIndexAwaited(index: SessionSnapshotsIndex): Promise<void> {
    this.cancelPendingIndex();
    await this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, index);
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
    await this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined);
    await this.workspaceState.update(LIVE_EDITOR_PANELS_KEY, undefined);
  }
}
