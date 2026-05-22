// src/webview/tabRenameOverlay.test.ts — Unit tests for the inline-rename
// overlay module. See add-tab-rename design.md D4 + specs/tab-rename/spec.md
// "Inline Edit Affordance".

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideRenameOverlay, isRenameOverlayOpen, repositionRenameOverlay, showRenameOverlay } from "./tabRenameOverlay";

// ─── Helpers ────────────────────────────────────────────────────────

function setupTabBar(): { tabBarEl: HTMLElement; tabEl: HTMLElement; nameSpan: HTMLElement } {
  const tabBarEl = document.createElement("div");
  tabBarEl.id = "tab-bar";
  document.body.appendChild(tabBarEl);

  const tabEl = document.createElement("div");
  tabEl.className = "tab-item";
  tabBarEl.appendChild(tabEl);

  const nameSpan = document.createElement("span");
  nameSpan.className = "tab-name";
  nameSpan.textContent = "Terminal 1";
  tabEl.appendChild(nameSpan);

  return { tabBarEl, tabEl, nameSpan };
}

function showOverlayHelper(
  initialValue = "Terminal 1",
  callbacks: { onCommit?: (v: string) => void; onCancel?: () => void } = {},
): {
  input: HTMLInputElement;
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  tabEl: HTMLElement;
  tabBarEl: HTMLElement;
} {
  const { tabBarEl, tabEl } = setupTabBar();
  const onCommit = vi.fn(callbacks.onCommit ?? (() => {}));
  const onCancel = vi.fn(callbacks.onCancel ?? (() => {}));
  showRenameOverlay({
    tabBarEl,
    targetTabEl: tabEl,
    initialValue,
    callbacks: { onCommit, onCancel },
  });
  const input = document.querySelector<HTMLInputElement>(".tab-rename-overlay");
  if (!input) {
    throw new Error("overlay input not mounted");
  }
  return { input, onCommit, onCancel, tabEl, tabBarEl };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom doesn't ship ResizeObserver — provide a no-op stub.
  if (typeof globalThis.ResizeObserver === "undefined") {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

afterEach(() => {
  // Defensive: dismount any leftover overlay between tests.
  hideRenameOverlay();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("tabRenameOverlay: mount + dismount", () => {
  it("mounts an absolutely-positioned input pre-filled with initialValue", () => {
    const { input } = showOverlayHelper("build");
    expect(input.value).toBe("build");
    expect(input.classList.contains("tab-rename-overlay")).toBe(true);
    expect(input.style.position).toBe("absolute");
    expect(isRenameOverlayOpen()).toBe(true);
  });

  it("mounts as a child of <body>, NOT inside the tab", () => {
    const { input, tabEl } = showOverlayHelper();
    expect(input.parentElement).toBe(document.body);
    expect(tabEl.contains(input)).toBe(false);
  });

  it("hideRenameOverlay removes the input and clears open state", () => {
    showOverlayHelper();
    hideRenameOverlay();
    expect(document.querySelector(".tab-rename-overlay")).toBeNull();
    expect(isRenameOverlayOpen()).toBe(false);
  });

  it("starting a new overlay while one is open commits the prior", () => {
    const { onCommit: firstCommit } = showOverlayHelper("first");
    // Open a second overlay over the same tab — first must commit.
    const { input: secondInput } = showOverlayHelper("second");
    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(firstCommit).toHaveBeenCalledWith("first");
    expect(secondInput.value).toBe("second");
  });
});

describe("tabRenameOverlay: Enter / Escape / blur", () => {
  it("Enter commits with the current input value and stops propagation", () => {
    const { input, onCommit, onCancel } = showOverlayHelper("Terminal 1");
    input.value = "build";
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    const stopSpy = vi.spyOn(ev, "stopPropagation");
    input.dispatchEvent(ev);
    expect(stopSpy).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("build");
    expect(onCancel).not.toHaveBeenCalled();
    expect(isRenameOverlayOpen()).toBe(false);
  });

  it("Escape cancels (no commit), stops propagation, and dismounts", () => {
    const { input, onCommit, onCancel } = showOverlayHelper("Terminal 1");
    input.value = "build"; // user typed something
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    const stopSpy = vi.spyOn(ev, "stopPropagation");
    input.dispatchEvent(ev);
    expect(stopSpy).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(isRenameOverlayOpen()).toBe(false);
  });

  it("blur commits", () => {
    const { input, onCommit } = showOverlayHelper("Terminal 1");
    input.value = "build";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("build");
  });

  it("idempotency: Enter then blur commits exactly once", () => {
    const { input, onCommit } = showOverlayHelper("Terminal 1");
    input.value = "build";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("idempotency: Escape then blur does not commit", () => {
    const { input, onCommit, onCancel } = showOverlayHelper("Terminal 1");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("tabRenameOverlay: IME composition suppression", () => {
  it("blur during composition does NOT commit; commit fires after compositionend + blur", () => {
    const { input, onCommit } = showOverlayHelper("Terminal 1");
    input.value = "ら";
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onCommit).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent("compositionend"));
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("ら");
  });

  it("Enter during composition does NOT commit", () => {
    const { input, onCommit } = showOverlayHelper("Terminal 1");
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onCommit).not.toHaveBeenCalled();
    // After compositionend, an Enter commits normally.
    input.dispatchEvent(new CompositionEvent("compositionend"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("tabRenameOverlay: target removal", () => {
  it("repositionRenameOverlay silently cancels when the target tab is gone from DOM", () => {
    const { tabEl, onCancel } = showOverlayHelper();
    tabEl.remove();
    repositionRenameOverlay();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(isRenameOverlayOpen()).toBe(false);
  });

  it("repositionRenameOverlay is a no-op when no overlay is open", () => {
    expect(() => repositionRenameOverlay()).not.toThrow();
  });
});
