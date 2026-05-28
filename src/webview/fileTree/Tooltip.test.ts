// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachTooltip, resetTooltipForTests } from "./Tooltip";

function makeTarget(title: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = title;
  document.body.appendChild(btn);
  return btn;
}

function widget(): HTMLDivElement | null {
  return document.body.querySelector<HTMLDivElement>(".file-tree-tooltip");
}

describe("attachTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetTooltipForTests();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("strips native title to avoid double-tooltip", () => {
    const btn = makeTarget("Search files");
    expect(btn.getAttribute("title")).toBe("Search files");
    attachTooltip(btn);
    expect(btn.hasAttribute("title")).toBe(false);
  });

  it("shows after 300ms hover and hides on mouseleave", () => {
    const btn = makeTarget("Open Folder");
    attachTooltip(btn);
    // Widget is created eagerly at attach time (so aria-describedby resolves
    // immediately for screen readers), but stays display:none until shown.
    expect(widget()?.style.display ?? "none").toBe("none");
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    expect(widget()?.style.display ?? "none").toBe("none");
    vi.advanceTimersByTime(300);
    const tip = widget();
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toBe("Open Folder");
    expect(tip?.style.display).toBe("block");
    btn.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tip?.style.display).toBe("none");
  });

  it("cancels pending show if mouse leaves before delay elapses", () => {
    const btn = makeTarget("Move tree");
    attachTooltip(btn);
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(100);
    btn.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(500);
    expect(widget()?.style.display ?? "none").toBe("none");
  });

  it("hides on mousedown (click suppresses tooltip while menu opens)", () => {
    const btn = makeTarget("Move tree");
    attachTooltip(btn);
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(widget()?.style.display).toBe("block");
    btn.dispatchEvent(new MouseEvent("mousedown"));
    expect(widget()?.style.display).toBe("none");
  });

  it("disposer removes listeners so later hovers do nothing", () => {
    const btn = makeTarget("Search");
    const dispose = attachTooltip(btn);
    dispose();
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(500);
    expect(widget()?.style.display ?? "none").toBe("none");
  });

  it("uses opts.text when provided and leaves explicit-text targets without prior title alone", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    attachTooltip(btn, { text: "Custom" });
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(widget()?.textContent).toBe("Custom");
  });

  it("is a no-op when neither title nor opts.text provided (no listeners attached)", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    attachTooltip(btn);
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(500);
    // The singleton widget may exist from a prior call in this test file but
    // it must NOT have been shown for this hover. Check display state, not
    // presence in the DOM.
    expect(widget()?.style.display ?? "none").toBe("none");
  });

  it("Escape key hides the visible tooltip", () => {
    const btn = makeTarget("Search");
    attachTooltip(btn);
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(widget()?.style.display).toBe("block");
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(widget()?.style.display).toBe("none");
  });

  it("dynamic getText is re-read on every show so state changes are reflected", () => {
    const btn = makeTarget("ignored");
    let label = "First";
    attachTooltip(btn, { getText: () => label });
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(widget()?.textContent).toBe("First");
    btn.dispatchEvent(new MouseEvent("mouseleave"));
    label = "Second";
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(widget()?.textContent).toBe("Second");
  });

  it("attaches aria-describedby to target on attach and removes it on dispose (WCAG 1.4.13 / F3)", () => {
    const btn = makeTarget("Search");
    const dispose = attachTooltip(btn);
    expect(btn.getAttribute("aria-describedby")).toBe("file-tree-tooltip-widget");
    dispose();
    expect(btn.hasAttribute("aria-describedby")).toBe(false);
  });

  it("focus triggers show (keyboard-only users get the hint — WCAG 1.4.13)", () => {
    const btn = makeTarget("Move tree");
    attachTooltip(btn);
    btn.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(300);
    expect(widget()?.style.display).toBe("block");
    expect(widget()?.textContent).toBe("Move tree");
    btn.dispatchEvent(new Event("blur"));
    expect(widget()?.style.display).toBe("none");
  });
});
