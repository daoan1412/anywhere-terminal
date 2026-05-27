// src/webview/messaging/scrollbackDumpHandler.ts — Webview-side responder
// for the extension's `requestScrollbackDump` message.
//
// Serialises the xterm.js scrollback via @xterm/addon-serialize and replies
// with the typed `scrollbackDump` payload. Concurrent requests for the same
// `tabId` are deduplicated via an in-flight Promise map: while a serialize
// is in progress for a tab, additional `requestId`s queue onto the same
// pending result and all receive the same data when it lands. See
// external-review [W2] for why a microtask boundary alone wasn't enough —
// real postMessage events arrive as separate tasks, not microtasks, so the
// prior coalescing only deduped synchronous spam, never user spam-clicks.
//
// See:
//   asimov/changes/export-terminal-session/specs/webview-scrollback-dump/spec.md
//   asimov/changes/export-terminal-session/design.md D4

import type { Terminal } from "@xterm/xterm";
import type { RequestScrollbackDumpMessage, ScrollbackDumpMessage } from "../../types/messages";

/**
 * Minimal subset of `@xterm/addon-serialize`'s SerializeAddon used here.
 * Matches the shape used by extension-side `SnapshotPersistence` so a
 * single shim suits both directions.
 */
export interface SerializeAddonLike {
  serialize(options?: { scrollback?: number; excludeAltBuffer?: boolean; excludeModes?: boolean }): string;
  dispose(): void;
}

export interface ScrollbackDumpDeps {
  /** Look up a terminal by `tabId`. Returns undefined for unknown tabs. */
  getTerminal(tabId: string): Terminal | undefined;
  /**
   * Post a `ScrollbackDumpMessage` back to the extension. Mirrors the
   * existing webview → extension message dispatch (whatever wraps
   * `acquireVsCodeApi().postMessage`).
   */
  postMessage(msg: ScrollbackDumpMessage): void;
  /**
   * Create a fresh `SerializeAddon` instance. May be synchronous OR async —
   * production wires this to a `await import("@xterm/addon-serialize")` so
   * the addon module is pulled into the webview bundle only on first export
   * (S1 lazy load). The addon's `serialize()` reads the Terminal's buffer
   * without attaching to it; we create one per dump and dispose immediately.
   */
  createSerializeAddon(): SerializeAddonLike | Promise<SerializeAddonLike>;
}

interface DumpPayload {
  data: string;
  lineCount: number;
  truncated: boolean;
}

interface InFlightEntry {
  ready: Promise<DumpPayload>;
  /** Request IDs that have queued onto this in-flight serialize. */
  requestIds: string[];
}

/**
 * Construct a handler closure. The returned function is wired into the
 * webview's MessageRouter for the `requestScrollbackDump` message type.
 */
export function createScrollbackDumpHandler(deps: ScrollbackDumpDeps): (msg: RequestScrollbackDumpMessage) => void {
  const inFlightByTab = new Map<string, InFlightEntry>();

  return (msg: RequestScrollbackDumpMessage): void => {
    const existing = inFlightByTab.get(msg.tabId);
    if (existing) {
      existing.requestIds.push(msg.requestId);
      return;
    }
    const requestIds: string[] = [msg.requestId];
    const ready = computeDump(deps, msg.tabId);
    inFlightByTab.set(msg.tabId, { ready, requestIds });
    ready.then(
      (payload) => {
        // Snapshot + clear BEFORE posting so any re-entrant request landing
        // during postMessage starts a fresh serialize, not piggybacks onto a
        // result we've already drained.
        inFlightByTab.delete(msg.tabId);
        for (const requestId of requestIds) {
          deps.postMessage({
            type: "scrollbackDump",
            tabId: msg.tabId,
            requestId,
            data: payload.data,
            lineCount: payload.lineCount,
            truncated: payload.truncated,
          });
        }
      },
      (err) => {
        // Reply with empty payload so the extension's request-correlated
        // Promise resolves — the dump coordinator awaits this and would
        // otherwise hang. Logged for diagnosis but not user-surfaced.
        inFlightByTab.delete(msg.tabId);
        console.error("[AnyWhere Terminal] scrollback dump failed:", err);
        for (const requestId of requestIds) {
          deps.postMessage({
            type: "scrollbackDump",
            tabId: msg.tabId,
            requestId,
            data: "",
            lineCount: 0,
            truncated: false,
          });
        }
      },
    );
  };
}

async function computeDump(deps: ScrollbackDumpDeps, tabId: string): Promise<DumpPayload> {
  const terminal = deps.getTerminal(tabId);
  if (!terminal) {
    // Unknown tab → empty payload per spec scenario "Unknown tabId".
    return { data: "", lineCount: 0, truncated: false };
  }
  const addon = await deps.createSerializeAddon();
  try {
    terminal.loadAddon(addon as unknown as { activate(t: Terminal): void; dispose(): void });
    const data = addon.serialize();
    const lineCount = terminal.buffer.normal.length;
    // `terminal.buffer.normal.length` returns the total line count INCLUDING
    // the visible viewport rows. The `scrollback` option caps only the
    // scrollback portion ABOVE the viewport, so the effective cap on
    // `buffer.normal.length` is `scrollback + rows`. Without the viewport
    // offset, a terminal at exactly `rows` lines below cap would report
    // `truncated: true` falsely. See: .reviews/round-2.md [W2].
    const scrollbackCap = (terminal.options.scrollback ?? 1000) + terminal.rows;
    const truncated = lineCount >= scrollbackCap;
    return { data, lineCount, truncated };
  } finally {
    try {
      addon.dispose();
    } catch {
      /* best-effort */
    }
  }
}
