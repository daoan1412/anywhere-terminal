// src/webview/TabBarUtils.ts — Tab bar rendering utility
//
// Extracted for testability. Pure DOM rendering function with dependency injection.
// See: docs/design/flow-multi-tab.md#Data-Routing-Architecture

import type { SplitNode } from "./SplitModel";
import type { TerminalInstance } from "./state/WebviewStateStore";

/** Minimal terminal info needed for tab bar rendering. */
export interface TabInfo {
  /** Auto-derived name (default "Terminal N"; mutated by OSC title events). */
  name: string;
  /** User-supplied name; when non-null wins over `name` in the rendered label. */
  customName?: string | null;
  /** Whether the terminal process has exited. */
  exited?: boolean;
}

/** Minimal store interface for buildTabBarData — avoids importing full WebviewStateStore. */
export interface TabBarDataSource {
  tabLayouts: Map<string, SplitNode>;
  tabActivePaneIds: Map<string, string>;
  terminals: Map<string, TerminalInstance>;
}

/**
 * Build a filtered terminals map for tab bar rendering.
 * Only includes "root" tabs (those with a tabLayout entry).
 * For split tabs, uses the active pane's name.
 */
export function buildTabBarData(store: TabBarDataSource): Map<string, TabInfo> {
  const tabTerminals = new Map<string, TabInfo>();
  for (const [tabId, layout] of store.tabLayouts) {
    if (layout.type === "branch") {
      // Split tab — show active pane's name and exited state. Custom name lives
      // on the root tab and wins over per-pane process names (see add-tab-rename
      // design.md D5 + split-focus-management spec).
      const activePaneId = store.tabActivePaneIds.get(tabId) ?? tabId;
      const activeInstance = store.terminals.get(activePaneId);
      const rootInstance = store.terminals.get(tabId);
      tabTerminals.set(tabId, {
        name: activeInstance?.name ?? rootInstance?.name ?? tabId,
        customName: rootInstance?.customName ?? null,
        exited: (activeInstance ?? rootInstance)?.exited,
      });
    } else {
      // Single pane tab
      const instance = store.terminals.get(tabId);
      if (instance) {
        tabTerminals.set(tabId, { name: instance.name, customName: instance.customName, exited: instance.exited });
      }
    }
  }
  return tabTerminals;
}

/**
 * Manual double-click detection state. Browser native `dblclick` requires both
 * clicks on the SAME element, but `renderTabBar()` does `innerHTML = ""` and
 * recreates tab DOM on every render (including tab-switch re-renders), so the
 * second click lands on a different element and `dblclick` never fires.
 *
 * We track the last click epoch + tabId at module scope. A second click within
 * `DBLCLICK_MS` on the SAME tabId triggers `onTabRename` instead of `onTabClick`.
 */
const DBLCLICK_MS = 350;
let lastTabClick: { tabId: string; time: number } | null = null;

/** Test-only hook: reset the module-level double-click tracker between tests. */
export function _resetTabClickTracker(): void {
  lastTabClick = null;
}

/** Dependencies for renderTabBar — injected for testability. */
export interface RenderTabBarDeps {
  tabBarEl: HTMLElement;
  terminals: Map<string, TabInfo>;
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onAddClick: () => void;
  /**
   * Double-click on a tab triggers inline rename. Receives the tab id and the
   * tab element so the caller can spawn an overlay anchored to it.
   * Optional so tests not exercising rename can omit it.
   */
  onTabRename?: (tabId: string, tabEl: HTMLElement) => void;
  /**
   * Hook called at the tail of renderTabBar — used by callers to reposition
   * an active inline-rename overlay over the (possibly re-rendered) tab DOM.
   */
  onAfterRender?: () => void;
}

/**
 * Render the tab bar UI inside the given element.
 *
 * - Clears existing content
 * - Creates tab elements with name + close button
 * - Appends "+" add button
 * - Hides tab bar when <= 1 tab (clean single-tab UX)
 * - Shows tab bar when 2+ tabs
 */
export function renderTabBar(deps: RenderTabBarDeps): void {
  const { tabBarEl, terminals, activeTabId, onTabClick, onTabClose, onAddClick, onTabRename, onAfterRender } = deps;

  // 1. Clear existing content
  tabBarEl.innerHTML = "";

  // 2. Create tab elements
  for (const [id, instance] of terminals) {
    const tab = document.createElement("div");
    tab.className = `tab-item${id === activeTabId ? " active" : ""}${instance.exited ? " tab-exited" : ""}`;
    tab.dataset.tabId = id;
    // VS Code native context menu support — `webviewSection == 'terminalTab'`
    // gates the `Rename Tab…` entry. The tabId is read by the command handler.
    tab.dataset.vscodeContext = JSON.stringify({ webviewSection: "terminalTab", tabId: id });

    // Custom name takes priority over the auto-derived (OSC-mutated) `name`.
    // See add-tab-rename design.md D1.
    const displayName = instance.customName ?? instance.name;
    const nameSpan = document.createElement("span");
    nameSpan.className = "tab-name";
    nameSpan.textContent = instance.exited ? `${displayName} (exited)` : displayName;
    tab.appendChild(nameSpan);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "\u00d7"; // ×
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onTabClose(id);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener("click", () => {
      if (onTabRename) {
        const now = Date.now();
        if (lastTabClick && lastTabClick.tabId === id && now - lastTabClick.time < DBLCLICK_MS) {
          // Second click on same tab within window → rename. Note: the first
          // click already fired onTabClick (which may have switched tabs and
          // re-rendered — that's why we can't rely on native `dblclick`).
          lastTabClick = null;
          onTabRename(id, tab);
          return;
        }
        lastTabClick = { tabId: id, time: now };
      }
      onTabClick(id);
    });

    tabBarEl.appendChild(tab);
  }

  // 3. Append "+" add button
  const addBtn = document.createElement("button");
  addBtn.className = "tab-add";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    onAddClick();
  });
  tabBarEl.appendChild(addBtn);

  // 4. Toggle visibility: hide when <= 1 tab, show when 2+
  if (terminals.size >= 2) {
    tabBarEl.classList.add("visible");
  } else {
    tabBarEl.classList.remove("visible");
  }

  // 5. After-render hook (e.g. reposition the inline-rename overlay so it stays
  // anchored to the target tab across re-renders). See add-tab-rename D4.
  if (onAfterRender) {
    onAfterRender();
  }
}

/** Dependencies for tab keyboard shortcut handler. */
export interface TabKeyboardDeps {
  terminals: Map<string, TabInfo>;
  activeTabId: string | null;
  switchTab: (tabId: string) => void;
}

/**
 * Handle Ctrl+Tab / Ctrl+Shift+Tab keyboard events for tab cycling.
 * Returns true if the event was handled (caller should preventDefault).
 *
 * See: docs/design/flow-multi-tab.md#Keyboard-Shortcut
 */
export function handleTabKeyboardShortcut(
  e: { ctrlKey: boolean; shiftKey: boolean; key: string },
  deps: TabKeyboardDeps,
): boolean {
  if (!e.ctrlKey || e.key !== "Tab") {
    return false;
  }

  const tabIds = Array.from(deps.terminals.keys());
  if (tabIds.length <= 1) {
    return true; // Handled but no-op (single tab)
  }

  const currentIndex = deps.activeTabId ? tabIds.indexOf(deps.activeTabId) : -1;
  if (currentIndex === -1) {
    return true;
  }

  let nextIndex: number;
  if (e.shiftKey) {
    // Ctrl+Shift+Tab: cycle backward with wrap-around
    nextIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
  } else {
    // Ctrl+Tab: cycle forward with wrap-around
    nextIndex = (currentIndex + 1) % tabIds.length;
  }

  deps.switchTab(tabIds[nextIndex]);
  return true;
}
