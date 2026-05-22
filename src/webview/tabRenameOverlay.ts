// src/webview/tabRenameOverlay.ts — Inline-edit overlay for tab rename.
//
// The overlay is an absolutely-positioned `<input>` element that lives OUTSIDE
// the `#tab-bar` container. This sidesteps `renderTabBar()`'s destructive
// `innerHTML = ""` reset — every OSC title update, tabCreated/tabRemoved, or
// split focus change would otherwise dismount an input nested inside a tab.
//
// One rename is active at a time. Starting a new rename while one is open
// commits the prior one first.
//
// Keyboard contract (see add-tab-rename design.md D4):
//   - Enter  → commit (onCommit), hide, stopPropagation.
//   - Escape → cancel (onCancel), hide, stopPropagation.
//   - blur   → commit. Idempotency-guarded so Enter+blur fires once.
//   - During IME composition (between compositionstart/compositionend), commit
//     triggers are suppressed.
//
// Repositioning: a ResizeObserver on the tab bar plus a window resize listener
// call repositionRenameOverlay(). renderTabBar() also calls it at its tail when
// a rename is active. If the target tab disappears from the DOM, the overlay
// silently cancels.

/** Public callbacks the host wires up (e.g. send `renameTab` IPC, end rename state). */
export interface RenameOverlayCallbacks {
  /** Called once when the user commits (Enter or blur outside IME composition). `value` is the RAW input string — the host normalizes. */
  onCommit: (value: string) => void;
  /** Called once when the user cancels (Escape) or the target tab disappears. */
  onCancel: () => void;
}

export interface ShowRenameOverlayOptions {
  /** The `#tab-bar` container — used to scope the ResizeObserver. */
  tabBarEl: HTMLElement;
  /** The tab `<div>` to overlay (must contain a `.tab-name` span). */
  targetTabEl: HTMLElement;
  /** Initial value (the currently displayed label). */
  initialValue: string;
  /** Host callbacks. */
  callbacks: RenameOverlayCallbacks;
}

interface OverlayState {
  input: HTMLInputElement;
  targetTab: HTMLElement;
  tabBarEl: HTMLElement;
  callbacks: RenameOverlayCallbacks;
  /** Idempotency guard: once committed or cancelled, further triggers are no-ops. */
  finalized: boolean;
  /** True while the user is mid-IME composition; suppress commits. */
  composing: boolean;
  resizeObs: ResizeObserver | null;
  onWindowResize: () => void;
  /** Defers DOM cleanup until next tick to avoid double-firing within one event loop. */
  removeListeners: () => void;
}

let state: OverlayState | null = null;

/** Open the overlay over `targetTabEl`. Commits the prior overlay (if any) first. */
export function showRenameOverlay(opts: ShowRenameOverlayOptions): void {
  // Commit any prior overlay so its callbacks fire (no double-rename in flight).
  if (state) {
    commit();
  }

  const { tabBarEl, targetTabEl, initialValue, callbacks } = opts;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-rename-overlay";
  input.value = initialValue;
  input.setAttribute("aria-label", "Rename tab");
  // Set positioning inline (in addition to the CSS class) so the overlay works
  // even when CSS hasn't loaded — and so tests can assert positioning behavior.
  input.style.position = "absolute";
  // Mount as a child of <body> so it floats over the tab bar without inheriting
  // any tab-internal CSS (overflow:hidden, etc.).
  document.body.appendChild(input);

  const newState: OverlayState = {
    input,
    targetTab: targetTabEl,
    tabBarEl,
    callbacks,
    finalized: false,
    composing: false,
    resizeObs: null,
    onWindowResize: () => repositionRenameOverlay(),
    removeListeners: () => {},
  };
  state = newState;

  // Listeners — store the cleanup so hideRenameOverlay can detach them.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.stopPropagation();
      e.preventDefault();
      if (!newState.composing) {
        commit();
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      cancel();
    } else {
      // Stop other keys from leaking to xterm / global handlers while editing.
      e.stopPropagation();
    }
  };
  const onBlur = (): void => {
    // Defer to allow Enter's stopPropagation/preventDefault to run first.
    if (!newState.composing) {
      commit();
    }
  };
  const onCompositionStart = (): void => {
    newState.composing = true;
  };
  const onCompositionEnd = (): void => {
    newState.composing = false;
  };

  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", onBlur);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);

  newState.removeListeners = () => {
    input.removeEventListener("keydown", onKeyDown);
    input.removeEventListener("blur", onBlur);
    input.removeEventListener("compositionstart", onCompositionStart);
    input.removeEventListener("compositionend", onCompositionEnd);
  };

  // Reposition observers.
  if (typeof ResizeObserver !== "undefined") {
    newState.resizeObs = new ResizeObserver(() => repositionRenameOverlay());
    newState.resizeObs.observe(tabBarEl);
  }
  window.addEventListener("resize", newState.onWindowResize);

  // Initial position + focus + select-all.
  repositionRenameOverlay();
  // Focus on next microtask so the click that triggered dblclick doesn't immediately blur.
  queueMicrotask(() => {
    if (state === newState) {
      input.focus();
      input.select();
    }
  });
}

/** Reposition the overlay over its target tab's `.tab-name` rectangle. Silent no-op if no overlay. */
export function repositionRenameOverlay(): void {
  if (!state) {
    return;
  }
  // If target tab is gone (close + reflow), cancel silently.
  if (!document.contains(state.targetTab)) {
    cancel();
    return;
  }
  const nameEl = state.targetTab.querySelector<HTMLElement>(".tab-name") ?? state.targetTab;
  const rect = nameEl.getBoundingClientRect();
  state.input.style.left = `${rect.left}px`;
  state.input.style.top = `${rect.top}px`;
  state.input.style.width = `${Math.max(rect.width, 60)}px`;
  state.input.style.height = `${rect.height}px`;
}

/** Hide and dispose the overlay. Does not fire callbacks. */
export function hideRenameOverlay(): void {
  if (!state) {
    return;
  }
  const s = state;
  state = null;
  s.finalized = true;
  s.removeListeners();
  if (s.resizeObs) {
    s.resizeObs.disconnect();
  }
  window.removeEventListener("resize", s.onWindowResize);
  if (s.input.parentNode) {
    s.input.parentNode.removeChild(s.input);
  }
}

/** Whether an overlay is currently mounted. Used by callers for state tracking. */
export function isRenameOverlayOpen(): boolean {
  return state !== null;
}

// ─── Internal: commit / cancel are idempotent ───────────────────────

function commit(): void {
  if (!state || state.finalized) {
    return;
  }
  const s = state;
  const value = s.input.value;
  s.finalized = true;
  hideRenameOverlay();
  s.callbacks.onCommit(value);
}

function cancel(): void {
  if (!state || state.finalized) {
    return;
  }
  const s = state;
  s.finalized = true;
  hideRenameOverlay();
  s.callbacks.onCancel();
}
