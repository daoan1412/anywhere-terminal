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

function result(entries: VaultSessionEntry[], unreadable = 0, reasons: string[] = []): VaultListResult {
  return { entries, unreadable: { count: unreadable, reasons } };
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

  it("runs the collapse animation (applying the change) on user toggles but not on the seed", () => {
    const host = createHost();
    let calls = 0;
    const panel = new VaultPanel({
      host,
      postMessage: () => {},
      animateCollapse: (apply) => {
        calls++;
        apply();
      },
    });
    // Constructor seed (persist:false) applies directly — not animated.
    expect(calls).toBe(0);
    expect(panel.isCollapsed()).toBe(true);

    panel.toggleCollapsed(); // collapsed -> expanded (user)
    expect(calls).toBe(1);
    expect(panel.isCollapsed()).toBe(false);
    expect(host.classList.contains("vault-collapsed")).toBe(false); // apply() ran

    panel.toggleCollapsed(); // expanded -> collapsed (user)
    expect(calls).toBe(2);

    panel.expand(); // collapsed -> expanded
    panel.expand(); // already expanded — no-op, no animation
    expect(calls).toBe(3);
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

describe("VaultPanel row rendering (redesign 4_1)", () => {
  it("marks each row with an accent-colored agent dot (no brand icon on rows)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a", agent: "claude" })]));
    const dot = host.querySelector(".vault-row .vault-row-dot");
    expect(dot?.classList.contains("vault-row-dot--claude")).toBe(true);
    // The real brand icon stays on the group/preview headers, not on rows.
    expect(host.querySelector(".vault-row .vault-badge")).toBeNull();
  });

  it("never turns an unknown/session-derived agent into a CSS class (W6)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "ghost:a", agent: "ghost is-maximized" })]));
    const dot = host.querySelector<HTMLElement>(".vault-row .vault-row-dot");
    // Only the closed accent set may add a class; an unknown agent adds none.
    expect(dot?.className).toBe("vault-row-dot");
    expect(Array.from(dot?.classList ?? []).some((c) => c.startsWith("vault-row-dot--"))).toBe(false);
  });

  it("never renders a fork button and never posts vaultFork", () => {
    const host = createHost();
    const posted: { type: string }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    // canFork:true would have produced a fork button under the old UI.
    panel.render(result([entry({ id: "claude:a", canFork: true })]));
    expect(host.querySelector(".vault-action--fork")).toBeNull();
    expect(host.querySelectorAll(".vault-action--resume")).toHaveLength(1);
    expect(posted.some((m) => m.type === "vaultFork")).toBe(false);
  });

  it("writes the (untrusted) title via textContent, not innerHTML", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a", title: "<img src=x onerror=alert(1)>" })]));
    const titleEl = host.querySelector(".vault-row-title");
    expect(titleEl?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(titleEl?.querySelector("img")).toBeNull();
  });

  it("posts vaultResume with the entry id when the icon-only Resume is clicked", () => {
    const host = createHost();
    const posted: { type: string; entryId?: string }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "codex:x1", agent: "codex" })]));
    host.querySelector<HTMLButtonElement>(".vault-action--resume")?.click();
    expect(posted).toContainEqual({ type: "vaultResume", entryId: "codex:x1" });
  });
});

describe("VaultPanel grouping + states (redesign 4_2)", () => {
  it("Recent mode renders a flat list with no group headers", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" }), entry({ id: "codex:b", agent: "codex" })]));
    expect(host.querySelectorAll(".vault-group-header")).toHaveLength(0);
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
  });

  it("Agent mode renders a group header per agent with the real brand icon + count", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a", agent: "claude" }), entry({ id: "codex:b", agent: "codex" })]));
    panel.setGroupMode("agent");
    const headers = host.querySelectorAll(".vault-group-header");
    expect(headers).toHaveLength(2);
    // The agent header carries the brand badge SVG (not a plain colored dot).
    const badge = host.querySelector(".vault-group-header .vault-group-badge");
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(host.querySelector(".vault-group-dot")).toBeNull();
  });

  it("Folder mode collapses a group on header click, hiding its rows", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "a", cwd: "/work/repo" }), entry({ id: "b", cwd: "/work/repo" })]));
    panel.setGroupMode("folder");
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
    host.querySelector<HTMLElement>(".vault-group-header--folder")?.click();
    expect(host.querySelectorAll(".vault-row")).toHaveLength(0);
    expect(host.querySelector(".vault-group-header--folder.is-collapsed")).not.toBeNull();
  });

  it("seeds + persists the grouping mode", () => {
    const host = createHost();
    const persisted: string[] = [];
    const panel = new VaultPanel({
      host,
      postMessage: () => {},
      getInitialCollapsed: () => false,
      getInitialGroupMode: () => "agent",
      persistGroupMode: (m) => persisted.push(m),
    });
    expect(host.querySelector('.vault-segmented button[data-mode="agent"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    panel.render(result([entry({ id: "claude:a" })]));
    expect(host.querySelectorAll(".vault-group-header")).toHaveLength(1); // grouped on seed
    panel.setGroupMode("folder");
    expect(persisted).toEqual(["folder"]);
  });

  it("shows a distinct no-match state (not the empty state) when a search filters everything out", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "a", title: "hello world" })]));
    const input = host.querySelector<HTMLInputElement>(".vault-search-input");
    if (input) {
      input.value = "zzzznomatch";
      input.dispatchEvent(new Event("input"));
    }
    const empty = host.querySelector(".vault-empty-title");
    expect(empty?.textContent).toBe("No matching sessions");
  });

  it("never renders the unreadable notice, even when the result reports skips", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "a" })], 2, ["Codex: 1 session couldn't be read", "OpenCode: reader failed"]));
    expect(host.querySelector(".vault-notice")).toBeNull();
    expect(host.textContent).not.toContain("couldn't be read");
  });

  it("caps a group at 10 rows behind a 'Show N more' that expands on click", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    const many = Array.from({ length: 14 }, (_, i) => entry({ id: `claude:s${i}`, modified: 1000 + i }));
    panel.render(result(many));
    // Recent mode (flat group) — only the first 10 of 14 show, plus the button.
    expect(host.querySelectorAll(".vault-row")).toHaveLength(10);
    const more = host.querySelector<HTMLButtonElement>(".vault-show-more");
    expect(more?.textContent).toBe("Show 4 more");
    more?.click();
    expect(host.querySelectorAll(".vault-row")).toHaveLength(14);
    expect(host.querySelector(".vault-show-more")).toBeNull();
  });
});

describe("VaultPanel header search toggle", () => {
  const searchBar = (host: HTMLElement) => host.querySelector<HTMLElement>(".vault-header__search");
  const searchBtn = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".vault-header__search-btn");

  it("hides the inline search by default and there is no standalone search strip", () => {
    const host = createHost();
    new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    // The old always-visible strip is gone; the input lives in a hidden header bar.
    expect(host.querySelector(".vault-search")).toBeNull();
    expect(searchBar(host)?.style.display).toBe("none");
    expect(searchBtn(host)).not.toBeNull();
  });

  it("reveals + focuses the input on button click, and auto-expands when collapsed", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} }); // default collapsed
    expect(panel.isCollapsed()).toBe(true);
    searchBtn(host)?.click();
    expect(panel.isCollapsed()).toBe(false); // auto-expanded by entering search
    expect(searchBar(host)?.style.display).toBe("flex");
    expect(host.querySelector(".vault-header")?.classList.contains("is-searching")).toBe(true);
    expect(document.activeElement).toBe(host.querySelector(".vault-search-input"));
    expect(searchBtn(host)?.getAttribute("aria-label")).toBe("Close search");
  });

  it("clicking the search button does not toggle the panel collapse", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    searchBtn(host)?.click(); // opens search, must NOT collapse
    expect(panel.isCollapsed()).toBe(false);
    expect(host.querySelector(".vault-header")?.classList.contains("is-searching")).toBe(true);
  });

  it("closing search (button) clears the query and restores the full list", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "a", title: "alpha" }), entry({ id: "b", title: "beta" })]));

    searchBtn(host)?.click(); // enter search
    const input = host.querySelector<HTMLInputElement>(".vault-search-input");
    if (input) {
      input.value = "alpha";
      input.dispatchEvent(new Event("input"));
    }
    expect(host.querySelectorAll(".vault-row")).toHaveLength(1);

    searchBtn(host)?.click(); // close search → clears filter
    expect(searchBar(host)?.style.display).toBe("none");
    expect(host.querySelector(".vault-header__main")?.getAttribute("style") ?? "").not.toContain("display: none");
    expect(host.querySelectorAll(".vault-row")).toHaveLength(2);
    expect(searchBtn(host)?.getAttribute("aria-label")).toBe("Search sessions");
  });

  it("Escape in the input exits search", () => {
    const host = createHost();
    new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    searchBtn(host)?.click();
    const input = host.querySelector<HTMLInputElement>(".vault-search-input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(searchBar(host)?.style.display).toBe("none");
    expect(host.querySelector(".vault-header")?.classList.contains("is-searching")).toBe(false);
  });
});

describe("VaultPanel context menu (redesign 5_1)", () => {
  function openMenu(host: HTMLElement): HTMLElement | null {
    const row = host.querySelector<HTMLElement>(".vault-row");
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    return host.querySelector(".vault-context-menu");
  }

  function _mount(entryOver: Partial<VaultSessionEntry>, posted: { type: string; entryId?: string }[]): VaultPanel {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a", ...entryOver })]));
    return panel;
  }

  it("has no menu until a row is right-clicked (no ⋯ trigger)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    expect(host.querySelector(".vault-context-menu")).toBeNull();
    openMenu(host);
    expect(host.querySelector(".vault-context-menu")).not.toBeNull();
  });

  it("shows all six items for a file-backed session", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a", sessionPath: "/store/a.jsonl" })]));
    const menu = openMenu(host);
    const labels = Array.from(menu?.querySelectorAll("button") ?? []).map((b) => b.textContent);
    expect(labels).toEqual([
      "Resume in New Tab",
      "Open",
      "Reveal in Finder",
      "Copy File Path",
      "Copy Resume Command",
      "Open Working Directory",
    ]);
  });

  it("hides the file-targeting items for a DB-backed session (no sessionPath)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "opencode:a", agent: "opencode", sessionPath: undefined })]));
    const menu = openMenu(host);
    const labels = Array.from(menu?.querySelectorAll("button") ?? []).map((b) => b.textContent);
    expect(labels).toEqual(["Resume in New Tab", "Copy Resume Command", "Open Working Directory"]);
    expect(labels).not.toContain("Open");
    expect(labels).not.toContain("Copy File Path");
  });

  it("each item posts the matching entryId-only message", () => {
    const posted: { type: string; entryId?: string }[] = [];
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a", sessionPath: "/store/a.jsonl" })]));
    const menu = openMenu(host);
    const click = (label: string) =>
      Array.from(menu?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent === label)
        ?.click();

    click("Copy File Path");
    // Reopen for each (clicking closes the menu).
    openMenu(host);
    Array.from(host.querySelector(".vault-context-menu")?.querySelectorAll("button") ?? [])
      .find((b) => b.textContent === "Copy Resume Command")
      ?.click();
    openMenu(host);
    Array.from(host.querySelector(".vault-context-menu")?.querySelectorAll("button") ?? [])
      .find((b) => b.textContent === "Open Working Directory")
      ?.click();

    expect(posted).toContainEqual({ type: "vaultCopyFilePath", entryId: "claude:a" });
    expect(posted).toContainEqual({ type: "vaultCopyResumeCommand", entryId: "claude:a" });
    expect(posted).toContainEqual({ type: "vaultOpenWorkingDir", entryId: "claude:a" });
    // No path is ever sent — only entryId.
    expect(posted.every((m) => !("path" in m))).toBe(true);
  });

  it("closes on Esc and on click-outside, clearing is-context-open", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));

    openMenu(host);
    expect(host.querySelector(".vault-row.is-context-open")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host.querySelector(".vault-context-menu")).toBeNull();
    expect(host.querySelector(".vault-row.is-context-open")).toBeNull();

    openMenu(host);
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(host.querySelector(".vault-context-menu")).toBeNull();
  });
});

describe("VaultPanel session preview (redesign 5_2)", () => {
  function detail(over: Partial<import("../../vault/types").VaultSessionDetail> = {}) {
    return {
      entryId: "claude:a",
      recentActivity: [],
      timeline: [],
      stats: { messageCount: 0, toolCount: 0, subagentCount: 0 },
      ...over,
    } as import("../../vault/types").VaultSessionDetail;
  }

  it("activating a row opens the preview (loading) and posts requestVaultSessionDetail", () => {
    const host = createHost();
    const posted: { type: string; entryId?: string }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    expect(host.querySelector(".vault-preview.is-open")).not.toBeNull();
    expect(host.querySelector(".vault-preview-loading")).not.toBeNull();
    expect(posted).toContainEqual({ type: "requestVaultSessionDetail", entryId: "claude:a" });
  });

  it("keeps the active row highlighted across a list re-render (W4)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" }), entry({ id: "codex:b", agent: "codex" })]));
    host.querySelector<HTMLElement>('.vault-row[data-entry-id="claude:a"]')?.click();
    expect(host.querySelector('.vault-row[data-entry-id="claude:a"]')?.getAttribute("aria-selected")).toBe("true");
    // Switching group mode rebuilds every row; the open preview's highlight must
    // re-attach to the fresh row, not vanish with the detached one.
    panel.setGroupMode("agent");
    expect(host.querySelector('.vault-row[data-entry-id="claude:a"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("expanding a capped run reveals its hidden steps in place (UI-2)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    const tools = Array.from({ length: 7 }, (_, i) => ({ kind: "tool", tool: "Read", detail: `/f${i}.ts` }) as const);
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ timeline: [{ kind: "message", role: "user", text: "go", timestamp: 1 }, ...tools] }),
    });
    // The run of 7 tool steps is capped at 3 + a "Show 4 more steps" button (D10).
    expect(host.querySelectorAll(".vault-preview-message-tool")).toHaveLength(3);
    const more = host.querySelector<HTMLButtonElement>(".vault-preview-expand");
    expect(more?.textContent).toBe("Show 4 more steps");
    more?.click();
    // Expanded in place: all 7 shown, button gone (no jump-to-top re-render artifact).
    expect(host.querySelectorAll(".vault-preview-message-tool")).toHaveLength(7);
    expect(host.querySelector(".vault-preview-expand")).toBeNull();
  });

  it("renders a nested sub-session node directly mid-run, never behind the step cap (D10)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    // A team GROUP node buried after 6 tool steps inside ONE run (no intervening
    // user message). Pre-D10 the whole run capped at 5 → the group (run index 6)
    // was sliced off and never entered the DOM. Now it breaks the run.
    const toolsBefore = Array.from(
      { length: 6 },
      (_, i) => ({ kind: "tool", tool: "Read", detail: `/before${i}.ts` }) as const,
    );
    const toolsAfter = Array.from(
      { length: 6 },
      (_, i) => ({ kind: "tool", tool: "Read", detail: `/after${i}.ts` }) as const,
    );
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        timeline: [
          { kind: "message", role: "user", text: "go", timestamp: 1 },
          ...toolsBefore,
          { kind: "subagentSession", entryId: "claude:a:team:arco", title: "Team: arco · 4 members" },
          ...toolsAfter,
        ],
      }),
    });
    // The group node is in the DOM (visible), not hidden behind a "Show N more".
    const group = host.querySelector(".vault-preview-subagent-title");
    expect(group?.textContent).toBe("Team: arco · 4 members");
    // It broke the run into two still-independently-capped halves (6 → 3 + "Show 3 more").
    expect(host.querySelectorAll(".vault-preview-expand")).toHaveLength(2);
  });

  it("renders a teammateTurn as a highlighted node that breaks the run and opens its segment (D13)", () => {
    const host = createHost();
    const posted: { type: string; entryId?: string }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    const before = Array.from({ length: 4 }, (_, i) => ({ kind: "tool", tool: "Read", detail: `/b${i}.ts` }) as const);
    const after = Array.from({ length: 4 }, (_, i) => ({ kind: "tool", tool: "Read", detail: `/a${i}.ts` }) as const);
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        timeline: [
          { kind: "message", role: "user", text: "go", timestamp: 1 },
          ...before,
          {
            kind: "teammateTurn",
            entryId: "claude:m:turn:0",
            agentName: "usdg",
            color: "blue",
            from: "leader",
            preview: "do the USDg estimate",
            timestamp: 2,
          },
          ...after,
        ],
      }),
    });
    // The teammate node is visible (not swept into a capped run) and highlighted.
    const node = host.querySelector<HTMLElement>(".vault-preview-teammate");
    expect(node).not.toBeNull();
    expect(host.querySelector(".vault-preview-teammate-name")?.textContent).toBe("@usdg");
    expect(host.querySelector(".vault-preview-teammate-dir")?.textContent).toBe("⟵ leader");
    expect(host.querySelector(".vault-preview-teammate-preview")?.textContent).toBe("do the USDg estimate");
    // Color sanitized to a concrete CSS value (NOT a theme var that can vanish).
    expect(node?.style.getPropertyValue("--turn-color")).toBe("#4aa3ff");
    // It broke the surrounding 4+4 tool run into two independently-capped halves.
    expect(host.querySelectorAll(".vault-preview-expand")).toHaveLength(2);
    // Clicking lazily fetches THIS turn's segment by its view-only :turn: id.
    host.querySelector<HTMLButtonElement>(".vault-preview-teammate-head")?.click();
    expect(node?.classList.contains("is-open")).toBe(true);
    expect(posted).toContainEqual({ type: "requestVaultSessionDetail", entryId: "claude:m:turn:0" });
  });

  it("renders a peer-DM teammateTurn with the peer name as direction + neutral fallback color", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        timeline: [
          {
            kind: "teammateTurn",
            entryId: "claude:m:turn:1",
            agentName: "reviewer-b",
            from: "reviewer-a",
            preview: "check the auth path",
            timestamp: 3,
          },
        ],
      }),
    });
    expect(host.querySelector(".vault-preview-teammate-dir")?.textContent).toBe("⟵ reviewer-a");
    // No color supplied → neutral fallback, still a concrete value (never a theme var).
    expect(host.querySelector<HTMLElement>(".vault-preview-teammate")?.style.getPropertyValue("--turn-color")).toBe(
      "#8b949e",
    );
  });

  it("renders an inbound teammateMessage as a color-keyed message (clean body, sender label), not a raw USER bubble (D16)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        timeline: [
          {
            kind: "teammateMessage",
            agentName: "reviewer-a",
            color: "blue",
            from: "peer",
            text: "found 2 issues in the auth path",
            timestamp: 6,
          },
        ],
      }),
    });
    const node = host.querySelector<HTMLElement>(".vault-preview-message-teammate");
    expect(node).not.toBeNull();
    // Sender label (an @teammate), never the generic "User" role.
    expect(node?.querySelector(".vault-preview-message-role")?.textContent).toContain("@reviewer-a");
    expect(node?.querySelector(".vault-preview-message-role")?.textContent).not.toContain("User");
    // Clean body — the literal tag never appears in the DOM.
    expect(node?.querySelector("p")?.textContent).toBe("found 2 issues in the auth path");
    expect(host.innerHTML).not.toContain("&lt;teammate-message");
    expect(host.innerHTML).not.toContain("<teammate-message");
    // Color sanitized to a concrete value.
    expect(node?.style.getPropertyValue("--turn-color")).toBe("#4aa3ff");
  });

  it("a leader-sent teammateMessage shows '⟵ leader' rather than @team-lead", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        timeline: [
          { kind: "teammateMessage", agentName: "team-lead", from: "leader", text: "review this", timestamp: 2 },
        ],
      }),
    });
    expect(host.querySelector(".vault-preview-message-teammate .vault-preview-message-role")?.textContent).toContain(
      "⟵ leader",
    );
  });

  it("renders the full conversation timeline in order, via textContent", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        timeline: [
          { kind: "message", role: "user", text: "<b>do</b> the thing", timestamp: Date.now() },
          { kind: "tool", tool: "Read", detail: "/a.ts" },
          { kind: "subagent", name: "asm-finder", prompt: "find" },
          { kind: "message", role: "assistant", text: "all done", timestamp: Date.now() },
        ],
        stats: { messageCount: 5, toolCount: 1, subagentCount: 1, tokenCount: 1650 },
      }),
    });
    // One node per timeline item, in order (2 messages + tool + subagent).
    const items = host.querySelectorAll(".vault-preview-body .vault-preview-message");
    expect(items).toHaveLength(4);
    // Untrusted text is written via textContent (not parsed as HTML).
    const firstP = host.querySelector(".vault-preview-message-user p");
    expect(firstP?.textContent).toBe("<b>do</b> the thing");
    expect(firstP?.querySelector("b")).toBeNull();
    expect(host.querySelector(".vault-preview-message-tool")?.textContent).toContain("/a.ts");
    expect(host.querySelector(".vault-preview-message-assistant p")?.textContent).toBe("all done");
    expect(host.querySelector(".vault-preview-meta")?.textContent).toContain("1.6k tok");
  });

  it("renders an assistant message as rich markdown — line breaks, a table, and a code block (D17)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    const md =
      "Summary:\n- point one\n- point two\n\n| Task | Hours |\n| --- | --- |\n| A | 12 |\n\n```ts\nconst x = 1;\n```";
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ timeline: [{ kind: "message", role: "assistant", text: md, timestamp: Date.now() }] }),
    });
    const body = host.querySelector(".vault-preview-message-assistant .vault-md");
    expect(body).not.toBeNull();
    // Bullet list rendered as a real <ul>.
    expect(body?.querySelectorAll("ul.md-list li")).toHaveLength(2);
    // Markdown table rendered as a real grid.
    expect(Array.from(body?.querySelectorAll("thead th") ?? []).map((th) => th.textContent)).toEqual(["Task", "Hours"]);
    expect(body?.querySelector("tbody td")?.textContent).toBe("A");
    // Fenced code preserved verbatim in a <pre><code>.
    expect(body?.querySelector("pre.md-pre code")?.textContent).toBe("const x = 1;");
  });

  it("renders only what the timeline contains (no empty filler)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ timeline: [{ kind: "message", role: "user", text: "just a prompt" }] }),
    });
    const items = host.querySelectorAll(".vault-preview-body .vault-preview-message");
    expect(items).toHaveLength(1);
    expect(host.querySelector(".vault-preview-message-user p")?.textContent).toBe("just a prompt");
  });

  it("shows a limited-detail notice for a partial detail", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "codex:a", agent: "codex" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "codex:a",
      detail: detail({ entryId: "codex:a", firstPrompt: "p", partial: true, limitedReason: "Index only." }),
    });
    expect(host.querySelector(".vault-preview-notice")?.textContent).toBe("Index only.");
  });

  it("ignores a stale response for a row that is no longer the active preview", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" }), entry({ id: "codex:b", agent: "codex" })]));
    const rows = host.querySelectorAll<HTMLElement>(".vault-row");
    rows[0].click(); // open A
    rows[1].click(); // now B is the active preview
    // A's (slow) response arrives — must be dropped.
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ entryId: "claude:a", timeline: [{ kind: "message", role: "user", text: "STALE-A-PROMPT" }] }),
    });
    expect(host.querySelector(".vault-preview")?.textContent).not.toContain("STALE-A-PROMPT");
    // B's response renders normally.
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "codex:b",
      detail: detail({ entryId: "codex:b", timeline: [{ kind: "message", role: "user", text: "FRESH-B-PROMPT" }] }),
    });
    expect(host.querySelector(".vault-preview")?.textContent).toContain("FRESH-B-PROMPT");
  });

  it("renders an inline error when the response carries one", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({ type: "vaultSessionDetailResponse", entryId: "claude:a", error: "boom" });
    expect(host.querySelector(".vault-preview-error")?.textContent).toBe("boom");
  });

  it("closes on Esc and on the Close button", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    expect(host.querySelector(".vault-preview.is-open")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host.querySelector(".vault-preview.is-open")).toBeNull();

    host.querySelector<HTMLElement>(".vault-row")?.click();
    host.querySelector<HTMLButtonElement>(".vault-preview-close")?.click();
    expect(host.querySelector(".vault-preview.is-open")).toBeNull();
  });

  it("mounts 8 edge/corner resize handles on the open preview", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    expect(host.querySelectorAll(".vault-preview .vault-preview-resize")).toHaveLength(8);
    // Handles survive a content re-render (loading → detail).
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ timeline: [{ kind: "message", role: "user", text: "hi" }] }),
    });
    expect(host.querySelectorAll(".vault-preview .vault-preview-resize")).toHaveLength(8);
  });

  it("toggles maximize, and REMEMBERS it across close → reopen (geometry persistence)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    const preview = host.querySelector(".vault-preview");
    expect(preview?.classList.contains("vault-preview--max")).toBe(false);
    host.querySelector<HTMLButtonElement>(".vault-preview-maximize")?.click();
    expect(preview?.classList.contains("vault-preview--max")).toBe(true);
    // Re-opening keeps the maximized state (size/position are remembered, #1).
    host.querySelector<HTMLButtonElement>(".vault-preview-close")?.click();
    host.querySelector<HTMLElement>(".vault-row")?.click();
    expect(host.querySelector(".vault-preview")?.classList.contains("vault-preview--max")).toBe(true);
    // Restoring returns to the floating size.
    host.querySelector<HTMLButtonElement>(".vault-preview-maximize")?.click();
    expect(host.querySelector(".vault-preview")?.classList.contains("vault-preview--max")).toBe(false);
  });

  it("Escape with the context menu open dismisses only the menu, leaving the preview open (W5)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    const row = host.querySelector<HTMLElement>(".vault-row");
    row?.click(); // open the preview first (registers its Esc listener first)
    expect(host.querySelector(".vault-preview.is-open")).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    expect(host.querySelector(".vault-context-menu")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector(".vault-context-menu")).toBeNull(); // menu dismissed
    expect(host.querySelector(".vault-preview.is-open")).not.toBeNull(); // preview stays open
  });

  it("renders thinking blocks and indents AI output; user messages carry the agent accent", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "codex:a", agent: "codex" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "codex:a",
      detail: detail({
        entryId: "codex:a",
        timeline: [
          { kind: "message", role: "user", text: "do it" },
          { kind: "thinking", text: "let me think" },
          { kind: "message", role: "assistant", text: "done" },
        ],
      }),
    });
    expect(host.querySelector(".vault-preview-message-thinking p")?.textContent).toBe("let me think");
    // Agent accent class is applied so user messages tint per-agent (codex here).
    expect(host.querySelector(".vault-preview")?.classList.contains("vault-preview--codex")).toBe(true);
  });

  it("loads older messages when truncated: the button posts a larger limit; the grown response removes it", () => {
    const host = createHost();
    const posted: { type: string; entryId?: string; limit?: number }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    // Initial (truncated) window.
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ truncated: true, timeline: [{ kind: "message", role: "user", text: "recent" }] }),
    });
    const more = host.querySelector<HTMLButtonElement>(".vault-preview-loadmore");
    expect(more).not.toBeNull();
    more?.click();
    // A load-more request goes out with a larger limit (default 400 + step 400).
    const req = posted.find((m) => m.type === "requestVaultSessionDetail" && typeof m.limit === "number");
    expect(req?.limit).toBe(800);
    // Older window arrives, no longer truncated → button gone, older text shown.
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({
        truncated: false,
        timeline: [
          { kind: "message", role: "user", text: "older" },
          { kind: "message", role: "user", text: "recent" },
        ],
      }),
    });
    expect(host.querySelector(".vault-preview-loadmore")).toBeNull();
    expect(host.querySelector(".vault-preview-body")?.textContent).toContain("older");
  });

  it("caps an AI run at 3 items behind a 'Show N more' that expands in place", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "claude:a" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    const tools = Array.from({ length: 8 }, (_, i) => ({ kind: "tool" as const, tool: "Bash", detail: `cmd ${i}` }));
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "claude:a",
      detail: detail({ timeline: [{ kind: "message", role: "user", text: "go" }, ...tools] }),
    });
    // user message + first 3 tools = 4 messages, plus the expand button.
    expect(host.querySelectorAll(".vault-preview-body .vault-preview-message")).toHaveLength(4);
    const more = host.querySelector<HTMLButtonElement>(".vault-preview-expand");
    expect(more?.textContent).toBe("Show 5 more steps");
    more?.click();
    expect(host.querySelectorAll(".vault-preview-body .vault-preview-message")).toHaveLength(9);
    expect(host.querySelector(".vault-preview-expand")).toBeNull();
  });

  it("renders a subagentSession as a collapsed block with title + first message", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "opencode:a", agent: "opencode" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:a",
      detail: detail({
        entryId: "opencode:a",
        timeline: [
          {
            kind: "subagentSession",
            entryId: "opencode:ses_kid",
            title: "Review the diff",
            firstMessage: "go review",
            agent: "reviewer",
          },
        ],
      }),
    });
    const block = host.querySelector(".vault-preview-subagent");
    expect(block).not.toBeNull();
    expect(host.querySelector(".vault-preview-subagent-title")?.textContent).toBe("@reviewer · Review the diff");
    expect(host.querySelector(".vault-preview-subagent-firstmsg")?.textContent).toBe("go review");
    // Collapsed by default — no nested transcript yet.
    expect(block?.classList.contains("is-open")).toBe(false);
    expect(host.querySelector(".vault-preview-subagent-body .vault-preview-message")).toBeNull();
  });

  it("expanding a subagent block lazily requests the child and renders its transcript nested", () => {
    const host = createHost();
    const posted: { type: string; entryId?: string }[] = [];
    const panel = new VaultPanel({ host, postMessage: (m) => posted.push(m), getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "opencode:a", agent: "opencode" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:a",
      detail: detail({
        entryId: "opencode:a",
        timeline: [{ kind: "subagentSession", entryId: "opencode:ses_kid", title: "Sub", firstMessage: "prompt" }],
      }),
    });
    host.querySelector<HTMLButtonElement>(".vault-preview-subagent-head")?.click();
    // Expanding posts a detail request for the CHILD entry id (lazy fetch).
    expect(posted).toContainEqual({ type: "requestVaultSessionDetail", entryId: "opencode:ses_kid" });
    expect(host.querySelector(".vault-preview-subagent")?.classList.contains("is-open")).toBe(true);
    // The child's response renders into the block (not the root, despite entryId ≠ active).
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:ses_kid",
      detail: detail({
        entryId: "opencode:ses_kid",
        timeline: [
          { kind: "message", role: "user", text: "child prompt" },
          { kind: "message", role: "assistant", text: "child reply" },
        ],
      }),
    });
    const nested = host.querySelectorAll(".vault-preview-subagent-body .vault-preview-message");
    expect(nested).toHaveLength(2);
    expect(host.querySelector(".vault-preview-subagent-body .vault-preview-message-assistant p")?.textContent).toBe(
      "child reply",
    );
  });

  it("collapsing a subagent block clears its nested body", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "opencode:a", agent: "opencode" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:a",
      detail: detail({
        entryId: "opencode:a",
        timeline: [{ kind: "subagentSession", entryId: "opencode:ses_kid", title: "Sub" }],
      }),
    });
    const head = () => host.querySelector<HTMLButtonElement>(".vault-preview-subagent-head");
    head()?.click(); // expand
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:ses_kid",
      detail: detail({ entryId: "opencode:ses_kid", timeline: [{ kind: "message", role: "user", text: "hi" }] }),
    });
    expect(host.querySelector(".vault-preview-subagent-body .vault-preview-message")).not.toBeNull();
    head()?.click(); // collapse
    expect(host.querySelector(".vault-preview-subagent")?.classList.contains("is-open")).toBe(false);
    expect(host.querySelector(".vault-preview-subagent-body .vault-preview-message")).toBeNull();
  });

  it("collapsing mid-load drops the pending request so a late response can't populate the hidden body (R4)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "opencode:a", agent: "opencode" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:a",
      detail: detail({
        entryId: "opencode:a",
        timeline: [{ kind: "subagentSession", entryId: "opencode:ses_kid", title: "Sub" }],
      }),
    });
    const head = () => host.querySelector<HTMLButtonElement>(".vault-preview-subagent-head");
    head()?.click(); // expand → request in flight (no response yet)
    head()?.click(); // collapse BEFORE the response arrives
    // A late nested response must be ignored — the body stays empty, not rehydrated.
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:ses_kid",
      detail: detail({ entryId: "opencode:ses_kid", timeline: [{ kind: "message", role: "user", text: "late" }] }),
    });
    expect(host.querySelector(".vault-preview-subagent-body .vault-preview-message")).toBeNull();
  });

  it("nests multiple tiers: a child's own subagentSession renders as a further block", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {}, getInitialCollapsed: () => false });
    panel.render(result([entry({ id: "opencode:a", agent: "opencode" })]));
    host.querySelector<HTMLElement>(".vault-row")?.click();
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:a",
      detail: detail({
        entryId: "opencode:a",
        timeline: [{ kind: "subagentSession", entryId: "opencode:ses_kid", title: "Parent sub" }],
      }),
    });
    host.querySelector<HTMLButtonElement>(".vault-preview-subagent-head")?.click();
    // The child itself contains a grandchild sub-session.
    panel.handleSessionDetailResponse({
      type: "vaultSessionDetailResponse",
      entryId: "opencode:ses_kid",
      detail: detail({
        entryId: "opencode:ses_kid",
        timeline: [{ kind: "subagentSession", entryId: "opencode:ses_grandkid", title: "Grandchild sub" }],
      }),
    });
    // Two subagent blocks now exist (parent + nested grandchild).
    expect(host.querySelectorAll(".vault-preview-subagent").length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector(".vault-preview-subagent-body .vault-preview-subagent")).not.toBeNull();
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
    const checkbox = host.querySelector<HTMLInputElement>(".vault-folder-toggle-cb");
    expect(checkbox?.checked).toBe(true);
    expect(toggle?.classList.contains("is-active")).toBe(true);
    expect(persisted).toEqual([]); // seed does not persist

    panel.toggleFolderOnly();
    panel.toggleFolderOnly();
    expect(persisted).toEqual([false, true]);
  });

  it("exposes the filter state via isFolderOnly (gates the host cwd re-probe)", () => {
    const host = createHost();
    const panel = new VaultPanel({ host, postMessage: () => {} });
    expect(panel.isFolderOnly()).toBe(false);
    panel.setFolderOnly(true);
    expect(panel.isFolderOnly()).toBe(true);
    panel.setFolderOnly(false);
    expect(panel.isFolderOnly()).toBe(false);
  });
});
