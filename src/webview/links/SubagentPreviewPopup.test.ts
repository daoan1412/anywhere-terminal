// @vitest-environment jsdom
// src/webview/links/SubagentPreviewPopup.test.ts — DOM-level coverage: open /
// loading / fill / error / replace / dispose + Escape/outside-click dismissal.
// The popup reuses the vault `.vault-preview` shell (FloatingWindow + header +
// scroll nav), so assertions key off those classes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultSessionDetail } from "../../vault/types";
import { SubagentPreviewPopup } from "./SubagentPreviewPopup";

function makeDetail(entryId = "claude:parent:subagent:agent-x"): VaultSessionDetail {
  return {
    entryId,
    recentActivity: [],
    timeline: [
      { kind: "message", role: "user", text: "Find the auth middleware" },
      { kind: "message", role: "assistant", text: "It lives in src/auth/mw.ts" },
    ],
    stats: { messageCount: 2, toolCount: 1, subagentCount: 0 },
  };
}

let popup: SubagentPreviewPopup;

beforeEach(() => {
  popup = new SubagentPreviewPopup();
});

afterEach(() => {
  // jsdom isolation: dispose + scrub any leftover node so document/listeners
  // don't leak into the rest of the suite (see project memory on jsdom flake).
  popup.dispose();
  document.body.innerHTML = "";
});

function popupEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.vault-preview[aria-label="Subagent transcript preview"]');
}

function open(requestId = "req-1", agentType = "Explore", description = "Find the auth middleware"): void {
  popup.open(requestId, agentType, description, 100, 120);
}

describe("SubagentPreviewPopup: open + loading", () => {
  it("mounts the vault-preview card (claude accent) open in a loading state", () => {
    open();
    const el = popupEl();
    expect(el).not.toBeNull();
    expect(el?.classList.contains("is-open")).toBe(true);
    expect(el?.classList.contains("vault-preview--claude")).toBe(true);
    expect(el?.getAttribute("role")).toBe("dialog");
    expect(el?.querySelector(".vault-preview-loading")?.textContent).toBe("Loading…");
    expect(popup.isOpen()).toBe(true);
  });

  it("builds a session-style header: agent badge, @agentType chip, description title, maximize+close", () => {
    open("req-1", "Explore", "Find session preview rendering code");
    const el = popupEl();
    expect(el?.querySelector(".vault-badge")).not.toBeNull();
    expect(el?.querySelector(".vault-preview-subagent-agent")?.textContent).toBe("@Explore");
    expect(el?.querySelector(".vault-preview-title")?.textContent).toBe("Find session preview rendering code");
    expect(el?.querySelector(".vault-preview-maximize")).not.toBeNull();
    expect(el?.querySelector(".vault-preview-close")).not.toBeNull();
    // No Resume action (a subagent is not independently launchable).
    expect(el?.querySelector(".vault-preview-resume")).toBeNull();
  });
});

describe("SubagentPreviewPopup: setContent", () => {
  it("renders the transcript flat + an Activity meta row on a matching requestId", () => {
    open("req-1");
    popup.setContent("req-1", makeDetail());
    const el = popupEl();
    expect(el?.querySelector(".vault-preview-loading")).toBeNull();
    expect(el?.querySelector(".vault-preview-body")?.textContent).toContain("Find the auth middleware");
    expect(el?.querySelector(".vault-preview-body")?.textContent).toContain("It lives in src/auth/mw.ts");
    expect(el?.querySelector(".vault-preview-meta")?.textContent).toContain("Activity");
  });

  it("ignores a response for a stale requestId", () => {
    open("req-2");
    popup.setContent("req-1", makeDetail()); // stale → dropped
    expect(popupEl()?.querySelector(".vault-preview-loading")).not.toBeNull();
  });

  it("renders an error/empty state when no detail is returned", () => {
    open("req-3");
    popup.setContent("req-3", undefined, "notFound");
    const el = popupEl();
    expect(el?.querySelector(".vault-empty")).not.toBeNull();
    expect(el?.textContent).toContain("Subagent not found");
  });

  it("does nothing after the popup is disposed", () => {
    open("req-4");
    popup.dispose();
    popup.setContent("req-4", makeDetail());
    expect(popupEl()).toBeNull();
  });
});

describe("SubagentPreviewPopup: single instance + dispose", () => {
  it("replaces a prior popup on re-open (at most one in the DOM)", () => {
    open("req-a", "Explore", "first");
    open("req-b", "Plan", "second");
    expect(document.body.querySelectorAll('.vault-preview[aria-label="Subagent transcript preview"]')).toHaveLength(1);
    expect(popupEl()?.querySelector(".vault-preview-subagent-agent")?.textContent).toBe("@Plan");
  });

  it("dispose removes the node and is idempotent", () => {
    open("req-5");
    popup.dispose();
    expect(popupEl()).toBeNull();
    expect(popup.isOpen()).toBe(false);
    expect(() => popup.dispose()).not.toThrow();
  });
});

describe("SubagentPreviewPopup: dismissal", () => {
  it("dismisses on Escape", () => {
    open("req-6");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popupEl()).toBeNull();
  });

  it("dismisses on an outside mousedown but NOT an inside one", () => {
    open("req-7");
    popup.setContent("req-7", makeDetail());
    const el = popupEl() as HTMLElement;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(popupEl()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(popupEl()).toBeNull();
  });
});
