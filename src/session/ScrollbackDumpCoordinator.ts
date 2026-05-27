// src/session/ScrollbackDumpCoordinator.ts — Owns the in-flight scrollback-
// dump request map and the request/reply/abort/timeout state machine.
//
// Extracted from SessionManager so the central registry stays focused on
// session lifecycle. Mirrors the SnapshotPersistence pattern. See:
//   asimov/changes/export-terminal-session/specs/webview-scrollback-dump/spec.md
//   asimov/changes/export-terminal-session/design.md D4
//   asimov/changes/export-terminal-session/.reviews/round-1.md [W1]

import * as crypto from "node:crypto";
import { ScrollbackDumpAbortedError, ScrollbackDumpFailedError, ScrollbackDumpTimeoutError } from "../types/errors";
import type { RequestScrollbackDumpMessage } from "../types/messages";
import type { MessageSender } from "./OutputBuffer";

/** Reply payload the webview sends back via `ScrollbackDumpMessage`. */
export interface ScrollbackDumpPayload {
  data: string;
  lineCount: number;
  truncated: boolean;
  /** When set, the webview handler failed and the coordinator rejects. */
  error?: string;
}

/** Dependencies injected from SessionManager. */
export interface ScrollbackDumpCoordinatorDeps {
  /** Post a message to a session's webview, isolating sync throws + async rejections. */
  postMessage: (webview: MessageSender, message: RequestScrollbackDumpMessage) => void;
  /** UUID factory for new requestIds. Injectable for tests. */
  idFactory?: () => string;
  /** Timeout override (ms). Default 15_000 — see design D4. */
  timeoutMs?: number;
}

interface PendingDump {
  sessionId: string;
  resolve: (value: ScrollbackDumpPayload) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Promise-backed scrollback-dump request map. One instance lives on
 * SessionManager.
 *
 * Three safeguards (design D4):
 *   - Session-dispose cancellation → abortForSession()
 *   - 15-second timeout backstop  → registered per request
 *   - Webview-side dedupe by tabId → handled inside the webview handler
 */
export class ScrollbackDumpCoordinator {
  private readonly pending = new Map<string, PendingDump>();
  private readonly timeoutMs: number;
  private readonly idFactory: () => string;

  constructor(private readonly deps: ScrollbackDumpCoordinatorDeps) {
    this.timeoutMs = deps.timeoutMs ?? 15_000;
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID());
  }

  /**
   * Post a `requestScrollbackDump` to the given webview and return a Promise
   * that resolves when the matching reply arrives, rejects with
   * `ScrollbackDumpAbortedError` on `abortForSession`, or rejects with
   * `ScrollbackDumpTimeoutError` after `timeoutMs`.
   */
  request(sessionId: string, webview: MessageSender): Promise<ScrollbackDumpPayload> {
    const requestId = this.idFactory();
    return new Promise<ScrollbackDumpPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new ScrollbackDumpTimeoutError(sessionId, requestId));
        }
      }, this.timeoutMs);
      this.pending.set(requestId, { sessionId, resolve, reject, timer });
      this.deps.postMessage(webview, {
        type: "requestScrollbackDump",
        tabId: sessionId,
        requestId,
      });
    });
  }

  /**
   * Resolve a pending request with the webview's reply. Silently ignores
   * unknown / already-settled `requestId`s (defensive against double-fires +
   * late replies after timeout).
   *
   * `senderSessionId` is the `tabId` echoed back by the webview in the reply
   * payload. Pre-fix, the coordinator authenticated replies on `requestId`
   * unguessability alone. Now we also reject any reply whose echoed sender
   * does not match the original request target — defense in depth against a
   * future bug that leaks a requestId across webviews. See:
   * .reviews/round-2.md [S3].
   */
  handleReply(requestId: string, senderSessionId: string, payload: ScrollbackDumpPayload): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    if (pending.sessionId !== senderSessionId) {
      // Sender mismatch — could be a buggy webview echoing the wrong tabId
      // or a cross-webview leak. Leave the pending entry intact so the
      // legitimate reply or the 15s timeout still gets a chance to settle it.
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (payload.error !== undefined) {
      // Webview handler failed (serialize threw, addon ctor threw, etc).
      // Reject so `exportBuffer` surfaces a toast instead of writing an
      // empty file. See: external-review W2.
      pending.reject(new ScrollbackDumpFailedError(senderSessionId, requestId, payload.error));
      return;
    }
    pending.resolve(payload);
  }

  /**
   * Reject every pending request targeting `sessionId` with
   * `ScrollbackDumpAbortedError`. Called from `cleanupSession` and `dispose`.
   */
  abortForSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new ScrollbackDumpAbortedError(sessionId, requestId));
      }
    }
  }

  /**
   * Reject every still-pending request — called from `SessionManager.dispose`
   * when every webview is going away. Uses sessionId from the pending entry.
   */
  abortAll(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ScrollbackDumpAbortedError(pending.sessionId, requestId));
    }
    this.pending.clear();
  }
}
