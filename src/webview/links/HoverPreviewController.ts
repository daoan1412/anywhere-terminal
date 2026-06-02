// src/webview/links/HoverPreviewController.ts — Hover state machine for the
// file-link preview popup. Owns the 300ms debounce timer, the activeRequestId,
// and the lifecycle of the single visible popup.
//
// See: asimov/changes/add-hover-file-preview/design.md D2, D3, D9, D10
// See: asimov/changes/add-hover-file-preview/specs/file-link-hover-preview/spec.md
//   #requirement-hover-trigger-and-debounce
//   #requirement-webview-side-stale-response-invalidation
//   #requirement-lifecycle--disposal

import type { ILink, Terminal } from "@xterm/xterm";
import type {
  FilePreviewResultMessage,
  RequestFilePreviewMessage,
  ThemeChangedMessage,
  WebViewToExtensionMessage,
} from "../../types/messages";
import type { PastedImagePreview } from "./PastedImageStore";

/** Default debounce — VSCode's editor hover uses 300 ms (`HoverOperation`). */
export const HOVER_DEBOUNCE_MS = 300;

/**
 * Grace period (ms) between the cursor leaving the link's character range
 * and the popup actually being dismissed. The popup is positioned with a
 * ~12px gap below the link; without a grace period, `link.leave` fires the
 * instant the cursor leaves the link's buffer cells and dismiss() runs
 * BEFORE the cursor can reach the popup to scroll/interact. 150 ms matches
 * VSCode's editor hover "stickiness" window.
 */
export const HOVER_LEAVE_GRACE_MS = 150;

/** Theme kind union from the IPC. */
export type HoverPreviewThemeKind = ThemeChangedMessage["kind"];

/**
 * Minimal interface the controller calls into to show/hide the popup. The
 * actual implementation lives in `HoverPreviewPopup.ts` (task 3_2). Kept as
 * an interface so the controller is unit-testable with a fake.
 */
export interface HoverPreviewPopupHost {
  /** Render / re-render the popup for `result` at `anchor`. */
  show(anchor: MouseEvent, result: FilePreviewResultMessage, theme: HoverPreviewThemeKind): void;
  /** Render a pasted-image preview at `anchor` (webview-local, no IPC). */
  showImage(anchor: MouseEvent, image: PastedImagePreview): void;
  /** Remove the popup if visible; idempotent. */
  hide(): void;
  /** Tear down DOM + listeners; idempotent. */
  dispose(): void;
}

/** UUID v4 polyfill via `crypto.randomUUID` (available in webview Electron). */
function newRequestId(): string {
  // Webviews under engines.vscode ^1.105.0 ship Electron with crypto.randomUUID.
  // If absent (e.g. unit tests in some JSDOM versions), fall back to a quick
  // hex string — non-cryptographic, but the only requirement is uniqueness
  // within the session.
  const c: { randomUUID?: () => string } | undefined = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build the link identity used by the controller to detect "same-link hovers". */
function linkKey(link: ILink): string {
  const r = link.range;
  return `${r.start.y}:${r.start.x}-${r.end.y}:${r.end.x}|${link.text}`;
}

export interface HoverPreviewControllerDeps {
  terminal: Terminal;
  sessionId: string;
  postMessage: (msg: WebViewToExtensionMessage) => void;
  /** Latest theme from the host's `themeChanged` bridge. */
  getTheme: () => HoverPreviewThemeKind;
  /** The popup renderer (task 3_2). Injected so the controller is testable. */
  popup: HoverPreviewPopupHost;
  /** Debounce override for tests. Defaults to HOVER_DEBOUNCE_MS. */
  debounceMs?: number;
}

/**
 * One controller per terminal. Holds at most one in-flight requestId; any
 * leave/scroll/mousedown/wheel/new-hover invalidates it so a late response
 * is dropped (see D9).
 */
export class HoverPreviewController {
  private readonly terminal: Terminal;
  private readonly sessionId: string;
  private readonly postMessage: (msg: WebViewToExtensionMessage) => void;
  private readonly getTheme: () => HoverPreviewThemeKind;
  private readonly popup: HoverPreviewPopupHost;
  private debounceMs: number;

  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Grace timer between `link.leave` and actual dismissal. Cleared when the
   * cursor enters the popup OR a new hover starts. See HOVER_LEAVE_GRACE_MS.
   */
  private leaveGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the cursor is over the popup itself — keeps dismissal at bay. */
  private cursorOverPopup = false;
  private activeRequestId: string | null = null;
  private activeLinkKey: string | null = null;
  /** Last anchor mouse event — used when the result arrives to position the popup. */
  private activeAnchor: MouseEvent | null = null;
  /**
   * The path of the in-flight or last-shown link — used to re-issue the
   * request with `override: true` when the user holds Cmd/Ctrl while a
   * `requires-confirmation` placeholder is showing.
   */
  private activePath: string | null = null;
  /** The line number parsed from the active link's suffix, if any. */
  private activeLine: number | undefined = undefined;
  /**
   * Set to true once the user has explicitly requested override for the
   * active link. Cleared on dismiss / new hover so the override doesn't
   * carry across distinct hovers.
   */
  private overrideRequested = false;
  /**
   * True only after the host returned a `requires-confirmation` result for
   * the current hover. The Cmd/Ctrl override gesture is ONLY meaningful in
   * that state — without this gate, any modifier-key press (Cmd+C copy,
   * Cmd+Tab, held Cmd while moving the mouse) would re-issue the request
   * with `override:true` and bypass the trust policy. See: round-2 BLOCK B1.
   */
  private activeRequiresConfirmation = false;
  private disposed = false;

  /** Window-level listeners we install on first hover so terminal events can dismiss. */
  private windowListenersAttached = false;
  private readonly onWindowMouseDown = (event: MouseEvent) => {
    // Any mousedown anywhere in the terminal area dismisses the popup. The
    // popup itself stops propagation in HoverPreviewPopup so inner clicks
    // don't trigger this.
    void event;
    this.dismiss();
  };
  private readonly onWindowWheel = () => {
    // Wheel inside the popup is the user scrolling the preview itself — the
    // popup root has `overflow: auto` and handles its own scroll. Only
    // dismiss when the wheel happens OUTSIDE the popup (terminal scrollback).
    if (this.cursorOverPopup) {
      return;
    }
    this.dismiss();
  };
  private readonly onWindowBlur = () => {
    this.dismiss();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.dismiss();
      return;
    }
    // Cmd (macOS) / Ctrl (Win/Linux) PRESSED while a requires-confirmation
    // popup is showing → re-issue the request with override=true. The gating
    // here is deliberately strict to avoid the round-2 B1 exploit: previously
    // any keystroke with `metaKey` / `ctrlKey` held (e.g. Cmd+C copy) would
    // trigger override even outside the requires-confirmation state.
    if (this.shouldTriggerOverride(event)) {
      this.requestOverride();
    }
  };

  constructor(deps: HoverPreviewControllerDeps) {
    this.terminal = deps.terminal;
    this.sessionId = deps.sessionId;
    this.postMessage = deps.postMessage;
    this.getTheme = deps.getTheme;
    this.popup = deps.popup;
    this.debounceMs = deps.debounceMs ?? HOVER_DEBOUNCE_MS;
  }

  /**
   * Install hover/leave callbacks on a single xterm `ILink`. Idempotent — if
   * the link already has its own hover/leave (e.g. our own from a prior
   * provideLinks call), we wrap them so existing behaviour is preserved.
   *
   * @param link The xterm `ILink` to attach hover/leave to.
   * @param path The RAW path (without any line/col suffix) to send in the
   *   `requestFilePreview` payload. The host resolver expects the clean path.
   *   When omitted, `link.text` is used as a fallback — but callers should
   *   always pass this explicitly because `link.text` may include suffixes
   *   like `:42:7` that the resolver can't consume.
   * @param line Optional 1-based line number parsed from the suffix
   *   (`foo.ts:42`, `foo.ts(42)`, `foo.ts#L42`). Forwarded into the
   *   `requestFilePreview` payload so the popup can scroll-to-line.
   */
  attachHover(link: ILink, path?: string, line?: number): void {
    if (this.disposed) {
      return;
    }
    const priorHover = link.hover?.bind(link);
    const priorLeave = link.leave?.bind(link);
    const resolvedPath = path ?? link.text;
    link.hover = (event, text) => {
      try {
        priorHover?.(event, text);
      } catch {
        // Defensive — other addons may attach hover callbacks too.
      }
      this.onLinkHover(event, link, resolvedPath, line);
    };
    link.leave = (event, text) => {
      try {
        priorLeave?.(event, text);
      } catch {
        // Defensive.
      }
      this.onLinkLeave();
    };
  }

  /**
   * Install hover/leave callbacks for a pasted-image placeholder link. On hover
   * the cached image is resolved locally (no IPC) and rendered via
   * `popup.showImage` after the shared debounce; leave/scroll/Escape dismiss
   * reuse the same machinery as file previews. See preview-pasted-images D4.
   */
  attachImageHover(link: ILink, resolve: () => PastedImagePreview | null): void {
    if (this.disposed) {
      return;
    }
    const priorHover = link.hover?.bind(link);
    const priorLeave = link.leave?.bind(link);
    link.hover = (event, text) => {
      try {
        priorHover?.(event, text);
      } catch {
        // Defensive — other addons may attach hover callbacks too.
      }
      this.onImageLinkHover(event, link, resolve);
    };
    link.leave = (event, text) => {
      try {
        priorLeave?.(event, text);
      } catch {
        // Defensive.
      }
      this.onLinkLeave();
    };
  }

  /** Called by main.ts when a `filePreviewResult` message arrives. */
  onMessage(result: FilePreviewResultMessage): void {
    if (this.disposed) {
      return;
    }
    if (result.requestId !== this.activeRequestId) {
      // Stale response — silently drop (D9, spec "stale-response invalidation").
      return;
    }
    if (!this.activeAnchor) {
      // Anchor lost (e.g. dismissed between request + response).
      return;
    }
    // Latch the requires-confirmation state so the Cmd/Ctrl override gesture
    // is meaningful (and ONLY meaningful) for this exact hover. Any other
    // status clears it — otherwise a stale latch could allow an override key
    // press to apply to an already-`ok` preview.
    this.activeRequiresConfirmation = result.status === "requires-confirmation";
    try {
      this.popup.show(this.activeAnchor, result, this.getTheme());
    } catch (err) {
      console.warn("[AnyWhere Terminal] HoverPreviewController.popup.show threw:", err);
    }
  }

  /**
   * Update the hover debounce in milliseconds. Called by main.ts when the
   * host posts a `hoverPreviewSettings` message with a new `delay` value.
   * Affects subsequent hovers — in-flight timers run to completion.
   */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }

  /** Programmatic dismiss — clears timer + invalidates requestId + unmounts popup. */
  dismiss(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.leaveGraceTimer) {
      clearTimeout(this.leaveGraceTimer);
      this.leaveGraceTimer = null;
    }
    this.activeRequestId = null;
    this.activeLinkKey = null;
    this.activeAnchor = null;
    this.activePath = null;
    this.activeLine = undefined;
    this.overrideRequested = false;
    this.activeRequiresConfirmation = false;
    this.cursorOverPopup = false;
    try {
      this.popup.hide();
    } catch {
      // Best-effort.
    }
  }

  /** Tear down — call from FilePathLinkProvider.dispose() / terminal disposal. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.leaveGraceTimer) {
      clearTimeout(this.leaveGraceTimer);
      this.leaveGraceTimer = null;
    }
    this.activeRequestId = null;
    this.activeLinkKey = null;
    this.activeAnchor = null;
    this.activePath = null;
    this.activeLine = undefined;
    this.overrideRequested = false;
    this.activeRequiresConfirmation = false;
    this.cursorOverPopup = false;
    if (this.windowListenersAttached) {
      this.detachWindowListeners();
    }
    try {
      this.popup.dispose();
    } catch {
      // Best-effort.
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /**
   * Generic hover→debounce→`fire` skeleton shared by the file-preview and the
   * pasted-image hover paths (preview-pasted-images D4). Handles the window
   * listeners, leave-grace cancel, the same-link guard, and the debounce timer.
   * `opts.beforeSchedule` runs synchronously after the guard passes (the file
   * path resets its request state there); `opts.isInFlight` lets a caller treat
   * post-debounce work as "still busy" for the same-link guard.
   */
  private scheduleHover(
    event: MouseEvent,
    link: ILink,
    fire: () => void,
    opts?: { beforeSchedule?: () => void; isInFlight?: () => boolean },
  ): void {
    if (this.disposed) {
      return;
    }
    this.ensureWindowListeners();
    // Re-entering the link cancels any pending leave-grace dismissal.
    if (this.leaveGraceTimer) {
      clearTimeout(this.leaveGraceTimer);
      this.leaveGraceTimer = null;
    }
    const key = linkKey(link);
    if (this.activeLinkKey === key && (this.pendingTimer || (opts?.isInFlight?.() ?? false))) {
      // Same link, work already pending/in-flight — nothing to do.
      return;
    }
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.activeLinkKey = key;
    this.activeAnchor = event;
    // Every fresh hover — file OR image — starts from a clean file-preview
    // gating slate: invalidate any in-flight request (so a late response is
    // dropped) and clear the requires-confirmation/override latch so a prior
    // file hover can't bleed into this one (e.g. a stale Cmd/Ctrl override
    // firing while an image popup is showing). The file path re-populates
    // activePath/activeLine in beforeSchedule.
    this.activeRequestId = null;
    this.activePath = null;
    this.activeLine = undefined;
    this.overrideRequested = false;
    this.activeRequiresConfirmation = false;
    opts?.beforeSchedule?.();
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (this.disposed) {
        return;
      }
      fire();
    }, this.debounceMs);
  }

  private onLinkHover(event: MouseEvent, link: ILink, path: string, line: number | undefined): void {
    this.scheduleHover(
      event,
      link,
      () => {
        const requestId = newRequestId();
        this.activeRequestId = requestId;
        const request: RequestFilePreviewMessage = {
          type: "requestFilePreview",
          requestId,
          sessionId: this.sessionId,
          path,
          ...(line !== undefined ? { line } : {}),
        };
        try {
          this.postMessage(request);
        } catch (err) {
          console.warn("[AnyWhere Terminal] postMessage(requestFilePreview) failed:", err);
          this.activeRequestId = null;
        }
      },
      {
        isInFlight: () => this.activeRequestId !== null,
        // scheduleHover already cleared the gating state; the file path only
        // needs to record which path/line this hover will request.
        beforeSchedule: () => {
          this.activePath = path;
          this.activeLine = line;
        },
      },
    );
  }

  private onImageLinkHover(event: MouseEvent, link: ILink, resolve: () => PastedImagePreview | null): void {
    this.scheduleHover(event, link, () => {
      const image = resolve();
      if (!image || !this.activeAnchor) {
        return;
      }
      try {
        this.popup.showImage(this.activeAnchor, image);
      } catch (err) {
        console.warn("[AnyWhere Terminal] HoverPreviewController.popup.showImage threw:", err);
      }
    });
  }

  private onLinkLeave(): void {
    if (this.disposed) {
      return;
    }
    // Cancel any pre-result work immediately — no popup is visible yet, so a
    // grace period would just keep us doing work the user no longer wants.
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      // No popup was shown — clear state and exit. Don't start grace timer.
      this.activeRequestId = null;
      this.activeLinkKey = null;
      this.activeAnchor = null;
      this.activePath = null;
      this.activeLine = undefined;
      return;
    }
    // Popup is (or will shortly be) showing — defer dismiss so the cursor can
    // travel into the popup to scroll/interact. Cancelled by `onPopupEnter`.
    this.scheduleLeaveDismiss();
  }

  /**
   * Called by the popup when the cursor enters its DOM. Cancels any pending
   * leave-grace timer so the popup stays alive while the user interacts.
   */
  onPopupEnter(): void {
    if (this.disposed) {
      return;
    }
    this.cursorOverPopup = true;
    if (this.leaveGraceTimer) {
      clearTimeout(this.leaveGraceTimer);
      this.leaveGraceTimer = null;
    }
  }

  /**
   * Called by the popup when the cursor leaves its DOM. Starts a fresh grace
   * timer — the user may be heading back to the link or away to dismiss.
   */
  onPopupLeave(): void {
    if (this.disposed) {
      return;
    }
    this.cursorOverPopup = false;
    this.scheduleLeaveDismiss();
  }

  /**
   * Schedule a dismissal after HOVER_LEAVE_GRACE_MS unless something
   * cancels it (popup enter, new hover, etc). Idempotent — restarting an
   * existing timer just resets the deadline.
   */
  private scheduleLeaveDismiss(): void {
    if (this.leaveGraceTimer) {
      clearTimeout(this.leaveGraceTimer);
    }
    this.leaveGraceTimer = setTimeout(() => {
      this.leaveGraceTimer = null;
      if (!this.cursorOverPopup) {
        this.dismiss();
      }
    }, HOVER_LEAVE_GRACE_MS);
  }

  /**
   * True when the user pressed the platform modifier key as a FRESH keypress
   * (not held during an unrelated keystroke) AND a `requires-confirmation`
   * popup is currently showing for the active hover. The strict gating
   * defeats round-2 BLOCK B1: previously any keystroke with `metaKey` /
   * `ctrlKey` held (Cmd+C, Cmd+Tab, etc.) would trigger override, and the
   * absence of a state check meant override could fire even for already-OK
   * previews.
   *
   * Conditions (all required):
   *   1. We haven't already overridden this hover (`!overrideRequested`).
   *   2. The popup currently shows `requires-confirmation` (the only state
   *      where override is meaningful).
   *   3. There IS an active link (`activePath !== null`).
   *   4. `event.key` is exactly `"Meta"` (macOS) or `"Control"` (Win/Linux) —
   *      a fresh modifier-key press, NOT any other key with the modifier
   *      held. `event.metaKey` / `ctrlKey` are explicitly NOT checked here.
   */
  private shouldTriggerOverride(event: KeyboardEvent): boolean {
    if (this.overrideRequested) {
      return false;
    }
    if (!this.activeRequiresConfirmation) {
      return false;
    }
    if (this.activePath === null) {
      return false;
    }
    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    const isMac = /Mac|iPhone|iPod|iPad/i.test(platform);
    return isMac ? event.key === "Meta" : event.key === "Control";
  }

  /**
   * Re-issue the in-flight (or just-completed) request with `override: true`.
   * No-op when there's no active link OR the override has already been
   * requested for this hover. Bumps `activeRequestId` so any pre-override
   * `filePreviewResult` is dropped as stale.
   */
  private requestOverride(): void {
    if (this.disposed || this.overrideRequested || this.activePath === null || this.activeAnchor === null) {
      return;
    }
    this.overrideRequested = true;
    // Cancel any in-flight non-override request — without this, the original
    // pending timer can still fire alongside the override and produce two
    // parallel requests for the same hover (race noted in round-2 B1).
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const requestId = newRequestId();
    this.activeRequestId = requestId;
    // Override request supersedes — clear the latch so a subsequent press of
    // Cmd/Ctrl can't double-fire (the gate also requires
    // `activeRequiresConfirmation`, which the override response will reset to
    // false because it returns `ok`).
    this.activeRequiresConfirmation = false;
    const request: RequestFilePreviewMessage = {
      type: "requestFilePreview",
      requestId,
      sessionId: this.sessionId,
      path: this.activePath,
      override: true,
      ...(this.activeLine !== undefined ? { line: this.activeLine } : {}),
    };
    try {
      this.postMessage(request);
    } catch (err) {
      console.warn("[AnyWhere Terminal] postMessage(requestFilePreview override) failed:", err);
      this.activeRequestId = null;
    }
  }

  private ensureWindowListeners(): void {
    if (this.windowListenersAttached) {
      return;
    }
    const root = this.terminal.element;
    if (!root) {
      return;
    }
    // Wheel + mousedown on the terminal area dismiss the popup. We install on
    // the terminal element (not window) so we don't fight other webview UI.
    root.addEventListener("wheel", this.onWindowWheel, { passive: true });
    root.addEventListener("mousedown", this.onWindowMouseDown);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("keydown", this.onKeyDown);
    this.windowListenersAttached = true;
  }

  private detachWindowListeners(): void {
    const root = this.terminal.element;
    if (root) {
      root.removeEventListener("wheel", this.onWindowWheel);
      root.removeEventListener("mousedown", this.onWindowMouseDown);
    }
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("keydown", this.onKeyDown);
    this.windowListenersAttached = false;
  }
}
