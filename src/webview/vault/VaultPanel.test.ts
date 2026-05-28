// @vitest-environment jsdom

// VaultPanel collapse behaviour: default-collapsed, toggle/expand persistence,
// header-click toggle, and the session-count badge. The vault is now a
// collapsible section stacked above the file tree (no panel exclusivity).

import { describe, expect, it } from "vitest";
import type { VaultListResult, VaultSessionEntry } from "../../vault/types";
import { VaultPanel } from "./VaultPanel";

function createHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function entry(over: Partial<VaultSessionEntry> = {}): VaultSessionEntry {
  return {
    id: "claude:abc",
    agent: "claude",
    sessionId: "abc",
    title: "hello",
    cwd: "/work/repo",
    modified: Date.now(),
    flags: {},
    canFork: false,
    ...over,
  };
}

function result(entries: VaultSessionEntry[], unreadable = 0): VaultListResult {
  return { entries, unreadable };
}

describe("VaultPanel collapse", () => {
  it("defaults to collapsed when no initial state is given", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    expect(panel.isCollapsed()).toBe(true);
    expect(host.classList.contains("vault-collapsed")).toBe(true);
    expect(host.querySelector(".vault-header")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("honours getInitialCollapsed=false (expanded)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    expect(panel.isCollapsed()).toBe(false);
    expect(host.classList.contains("vault-collapsed")).toBe(false);
    expect(host.querySelector(".vault-header")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("does NOT persist the initial seed (persist:false)", () => {
    const host = createHost();
    const persisted: boolean[] = [];
    new VaultPanel({ host, postMessage: () => {}, persistCollapsed: (c) => persisted.push(c) });
    expect(persisted).toEqual([]);
  });

  it("toggleCollapsed flips state and persists", () => {
    const host = createHost();
    const persisted: boolean[] = [];
    const panel = new VaultPanel({ host, postMessage: () => {}, persistCollapsed: (c) => persisted.push(c) });

    panel.toggleCollapsed(); // collapsed -> expanded
    expect(panel.isCollapsed()).toBe(false);
    expect(host.classList.contains("vault-collapsed")).toBe(false);

    panel.toggleCollapsed(); // expanded -> collapsed
    expect(panel.isCollapsed()).toBe(true);
    expect(persisted).toEqual([false, true]);
  });

  it("expand() opens a collapsed panel and is a no-op when already open", () => {
    const host = createHost();
    const persisted: boolean[] = [];
    const panel = new VaultPanel({ host, postMessage: () => {}, persistCollapsed: (c) => persisted.push(c) });

    panel.expand();
    expect(panel.isCollapsed()).toBe(false);
    panel.expand(); // already expanded — no further persist
    expect(persisted).toEqual([false]);
  });

  it("clicking the header toggles collapse", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    const header = host.querySelector<HTMLElement>(".vault-header");
    expect(panel.isCollapsed()).toBe(true);
    header?.click();
    expect(panel.isCollapsed()).toBe(false);
    header?.click();
    expect(panel.isCollapsed()).toBe(true);
  });

  it("render updates the session-count badge", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    const count = host.querySelector(".vault-header__count");
    expect(count?.textContent).toBe("");

    panel.render(result([entry({ id: "claude:a" }), entry({ id: "codex:b", agent: "codex" })]));
    expect(count?.textContent).toBe("2");

    panel.render(result([]));
    expect(count?.textContent).toBe("");
  });

  it("count badge reflects the filtered (visible) count, not the total", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    const count = host.querySelector(".vault-header__count");

    panel.render(
      result([
        entry({ id: "a", cwd: "/work/repo" }),
        entry({ id: "b", cwd: "/work/repo/src" }),
        entry({ id: "c", cwd: "/other/proj" }),
      ]),
    );
    expect(count?.textContent).toBe("3");

    panel.setContextCwd("/work/repo");
    panel.setFolderOnly(true);
    // 2 of 3 sit within /work/repo → the badge tracks what the list shows.
    expect(count?.textContent).toBe("2");
  });

  it("requests the session list when expanding (refresh on open)", () => {
    const host = createHost();
    const posted: { type: string }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m) });
    const refreshes = () => posted.filter((m) => m.type === "requestVaultSessions").length;

    // Default collapsed → nothing fetched yet.
    expect(refreshes()).toBe(0);

    panel.toggleCollapsed(); // expand → fetch
    expect(refreshes()).toBe(1);

    panel.toggleCollapsed(); // collapse → no fetch
    expect(refreshes()).toBe(1);

    panel.toggleCollapsed(); // expand again → fetch
    expect(refreshes()).toBe(2);
  });

  it("fetches on mount when restored expanded", () => {
    const host = createHost();
    const posted: { type: string }[] = [];
    new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    expect(posted.filter((m) => m.type === "requestVaultSessions")).toHaveLength(1);
  });
});

describe("VaultPanel 'This folder only' filter", () => {
  it("shows all entries when the filter is off", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    panel.render(result([entry({ id: "a", cwd: "/work/repo" }), entry({ id: "b", cwd: "/other/proj" })]));
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
  });

  it("scopes to the active pane's folder subtree when on", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    panel.render(
      result([
        entry({ id: "a", cwd: "/work/repo" }),
        entry({ id: "b", cwd: "/work/repo/src" }),
        entry({ id: "c", cwd: "/other/proj" }),
      ]),
    );

    panel.setContextCwd("/work/repo");
    panel.setFolderOnly(true);
    // /work/repo (equal) + /work/repo/src (inside) match; /other/proj does not.
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);

    panel.setFolderOnly(false);
    expect(host.querySelectorAll(".vault-row")).toHaveLength(3);
  });

  it("re-filters when the active pane cwd changes", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialFolderOnly: () => true });
    panel.render(result([entry({ id: "a", cwd: "/work/repo" }), entry({ id: "b", cwd: "/other" })]));

    panel.setContextCwd("/work/repo");
    expect(host.querySelectorAll(".vault-row")).toHaveLength(1);
    panel.setContextCwd("/other");
    expect(host.querySelectorAll(".vault-row")).toHaveLength(1);
    // No cwd → can't scope → show all.
    panel.setContextCwd(null);
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
  });

  it("matches descendants of a trailing-slash parent without the sibling-prefix trap", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    panel.render(
      result([
        entry({ id: "a", cwd: "/work/repo" }),
        entry({ id: "b", cwd: "/work/repo/src" }),
        entry({ id: "c", cwd: "/work/repository" }), // sibling-prefix — must NOT match
      ]),
    );

    panel.setContextCwd("/work/repo/");
    panel.setFolderOnly(true);
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
  });

  it("treats a root cwd ('/') as containing every absolute session path", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialFolderOnly: () => true });
    panel.render(result([entry({ id: "a", cwd: "/work/repo" }), entry({ id: "b", cwd: "/other" })]));

    panel.setContextCwd("/");
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
  });

  it("pulls the live context cwd via getContextCwd on render (not just pushed setContextCwd)", () => {
    const host = createHost();
    let cwd: string | null = null; // OSC 7 hasn't fired yet
    const panel = new VaultPanel({
      host,
      postMessage: () => {},
      getInitialFolderOnly: () => true,
      getContextCwd: () => cwd,
    });

    const data = result([entry({ id: "a", cwd: "/work/repo" }), entry({ id: "b", cwd: "/other" })]);
    panel.render(data);
    // No cwd resolvable → filter falls through to show all (the old no-op bug).
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);

    // OSC 7 lands; the next render pulls the live value and scopes the list —
    // without any explicit setContextCwd push.
    cwd = "/work/repo";
    panel.render(data);
    expect(host.querySelectorAll(".vault-row")).toHaveLength(1);
  });

  it("seeds + persists the folder-only toggle", () => {
    const host = createHost();
    const persisted: boolean[] = [];
    const panel = new VaultPanel({
      host,
      postMessage: () => {},
      getInitialFolderOnly: () => true,
      persistFolderOnly: (v) => persisted.push(v),
    });
    const toggle = host.querySelector(".vault-folder-toggle");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.classList.contains("is-active")).toBe(true);
    expect(persisted).toEqual([]); // seed does not persist

    panel.toggleFolderOnly();
    panel.toggleFolderOnly();
    expect(persisted).toEqual([false, true]);
  });
});
