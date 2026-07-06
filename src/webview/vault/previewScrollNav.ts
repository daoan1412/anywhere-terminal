// Floating scroll-to-top / scroll-to-bottom FAB cluster for the preview body.
// Owns its own hover/active/idle-timer state and the body scroll listener. The
// top button delegates to `onScrollTop` (the owner, which may load older windows
// first); the bottom button just smooth-scrolls. Pagination state stays in the owner.

import { ICON_SCROLL_BOTTOM, ICON_SCROLL_TOP } from "./icons";

export interface PreviewScrollNavDeps {
  /** The preview element; the live `.vault-preview-body` is re-queried from it each render. */
  el: HTMLElement;
  /** Top-FAB click — owner-driven so it can walk older windows before scrolling. */
  onScrollTop: () => void;
}

export class PreviewScrollNav {
  readonly element: HTMLElement;
  private readonly el: HTMLElement;
  private readonly topBtn: HTMLButtonElement;
  private readonly bottomBtn: HTMLButtonElement;
  /** Live-follow "N new messages" pill (enhance-vault-sessions D5) — shown while
   *  scrolled up and newer content has arrived; always visible when armed (it
   *  does NOT fade with the idle FABs). */
  private readonly pillBtn: HTMLButtonElement;
  private pillOnClick: (() => void) | null = null;
  private active = false;
  private hovering = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PreviewScrollNavDeps) {
    this.el = deps.el;
    const nav = document.createElement("div");
    nav.className = "vault-preview-scroll-nav";
    // Keep the cluster alive while hovered so a fading FAB doesn't slip the click.
    nav.addEventListener("pointerenter", () => {
      this.hovering = true;
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    });
    nav.addEventListener("pointerleave", () => {
      this.hovering = false;
      this.scheduleHide();
    });
    const make = (cls: string, label: string, svg: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `vault-preview-scroll-btn ${cls}`;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.innerHTML = svg;
      // stopPropagation so the FAB press isn't treated as an outside-click dismiss.
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", onClick);
      return btn;
    };
    this.topBtn = make("vault-preview-scroll-top", "Scroll to first message", ICON_SCROLL_TOP, () =>
      deps.onScrollTop(),
    );
    this.bottomBtn = make("vault-preview-scroll-bottom", "Scroll to latest message", ICON_SCROLL_BOTTOM, () =>
      this.scrollBody("end"),
    );
    this.pillBtn = document.createElement("button");
    this.pillBtn.type = "button";
    this.pillBtn.className = "vault-preview-newmsg-pill";
    this.pillBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    this.pillBtn.addEventListener("click", () => this.pillOnClick?.());
    nav.append(this.pillBtn, this.topBtn, this.bottomBtn);
    this.element = nav;
  }

  /** Arm the live-follow pill with a new-message count + jump handler (D5). */
  setNewMessages(count: number, onClick: () => void): void {
    this.pillOnClick = onClick;
    const label = count > 1 ? `${count} new messages` : "New message";
    this.pillBtn.textContent = `↓ ${label}`;
    this.pillBtn.title = "Jump to the latest message";
    this.pillBtn.setAttribute("aria-label", label);
    this.pillBtn.classList.add("is-visible");
  }

  /** Dismiss the live-follow pill (caught up / preview closed). */
  clearNewMessages(): void {
    this.pillOnClick = null;
    this.pillBtn.classList.remove("is-visible");
  }

  private body(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(".vault-preview-body");
  }

  /** (Re)bind the scroll listener to the freshly rendered body. The old body (and
   *  its listener) is discarded by replaceChildren, so there is no leak/double-bind. */
  wire(): void {
    const body = this.body();
    if (!body) {
      this.element.classList.add("is-empty");
      return;
    }
    this.element.classList.remove("is-empty");
    this.active = false;
    body.addEventListener("scroll", () => this.reveal(body), { passive: true });
    this.updateVisibility(body);
  }

  /** Clear transient state (timer + flags + the follow pill). Called on reopen/close. */
  reset(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.active = false;
    this.hovering = false;
    this.clearNewMessages();
  }

  /** Smooth-scroll the body to top (0) or end. */
  scrollBody(target: 0 | "end"): void {
    const body = this.body();
    if (!body) {
      return;
    }
    body.scrollTo({ top: target === "end" ? body.scrollHeight : 0, behavior: "smooth" });
  }

  /** Jump (instant) to the latest message — used on initial open. */
  scrollToEnd(): void {
    const body = this.body();
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }

  /** Scroll to the next (+1) / previous (-1) user message, excluding the current one. */
  scrollToAdjacentUser(dir: 1 | -1): void {
    const body = this.body();
    if (!body) {
      return;
    }
    const users = Array.from(body.querySelectorAll<HTMLElement>(".vault-preview-message-user"));
    if (users.length === 0) {
      return;
    }
    const bodyTop = body.getBoundingClientRect().top;
    const positions = users.map((u) => u.getBoundingClientRect().top - bodyTop + body.scrollTop);
    const margin = 8;
    const cur = body.scrollTop;
    let target: number | undefined;
    if (dir === 1) {
      target = positions.find((p) => p > cur + margin);
    } else {
      const before = positions.filter((p) => p < cur - margin);
      target = before.length > 0 ? before[before.length - 1] : undefined;
    }
    if (target === undefined) {
      return;
    }
    body.scrollTo?.({ top: Math.max(0, target - margin), behavior: "smooth" });
  }

  private reveal(body: HTMLElement): void {
    this.active = true;
    this.updateVisibility(body);
    this.scheduleHide();
  }

  private scheduleHide(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.hovering) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.active = false;
      const body = this.body();
      if (body) {
        this.updateVisibility(body);
      }
    }, 1100);
  }

  private updateVisibility(body: HTMLElement): void {
    const EDGE = 8;
    const show = this.active && body.scrollHeight - body.clientHeight > EDGE;
    const atTop = body.scrollTop <= EDGE;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= EDGE;
    this.topBtn.classList.toggle("is-visible", show && !atTop);
    this.bottomBtn.classList.toggle("is-visible", show && !atBottom);
  }
}
