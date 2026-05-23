// src/webview/fileTree/IFileSystemProvider.ts — File-system provider contract.
//
// Mirrors the surface of VS Code's `vscode.FileSystemProvider` (see
// vs/platform/files/common/files.ts) but trimmed to the operations the
// async-file-tree port actually needs. Implementations communicate with the
// extension host over `postMessage` RPC (see design D4).
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D4, D10
//      asimov/changes/port-vscode-async-data-tree/specs/file-tree-rpc/spec.md
//        #requirement-file-system-provider-interface-webview-side

/**
 * Tree-shaped, absolute-path-keyed node consumed by `Tree<FileNode>` and its
 * renderers. Construct by mapping `FileEntry` rows returned by
 * `IFileSystemProvider.readDirectory`.
 */
export interface FileNode {
  /** Basename — the label rendered in the row. */
  name: string;
  /** Absolute path on disk (host-side). Stable identity key for the tree. */
  path: string;
  /** Discriminator for renderer / expand-chevron decisions. */
  kind: "file" | "directory";
  /**
   * True when git considers this entry ignored. Propagated from
   * `FileEntry.ignored` in the RPC response. The renderer applies an
   * `is-ignored` class so the row renders dimmed (mirrors VS Code's
   * Explorer behaviour for gitignored files).
   */
  ignored?: boolean;
}

/**
 * Minimal `stat` projection — currently unused by Wave 3 but reserved for
 * future renderers (mtime-based sort, size badge). Implementations may throw
 * `Error` if not yet supported.
 */
export interface FileStat {
  /** Last-modified epoch milliseconds. */
  mtime: number;
  /** Size in bytes. `0` for directories. */
  size: number;
  /** Discriminator matching `FileNode.kind`. */
  kind: "file" | "directory";
}

/**
 * Re-export so consumers of this module don't have to reach into the
 * cross-cutting `messages.ts` barrel just to spell a directory listing row.
 */
export type { FileEntry } from "../../types/messages";

/**
 * File-system access surface used by tree data sources. The webview-side
 * implementation (`FileSystemDataSource`) forwards each call to the extension
 * host via correlated `postMessage` RPC.
 */
export interface IFileSystemProvider {
  /**
   * List the immediate children of `path`. Rejects with a `CancellationError`
   * if the provider is disposed or the request is abandoned (e.g. workspace
   * root changed mid-flight — see design D10).
   */
  readDirectory(path: string): Promise<import("../../types/messages").FileEntry[]>;

  /**
   * Resolve a single entry's metadata. Not yet wired by Wave 3 — implementations
   * may throw until a renderer needs it.
   */
  stat(path: string): Promise<FileStat>;
}
