// @vitest-environment jsdom
// workflowBoard — the single-layer master-detail board renderer
// (render-vault-workflow-board 2_1, redesigned). Covers header/tree structure,
// leaf→transcript selection (reusing bag.populateNested), the no-entryId no-op,
// phase toggle isolation from the right pane, the splitter drag, and selection
// persistence across a re-render (issue 4: "Show N more steps" must not reset).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultTimelineItem } from "../../vault/types";
import { type BoardSelection, type PreviewTimelineBag, renderTimelineInto } from "./previewTimeline";
import { renderWorkflowBoard } from "./workflowBoard";

type WorkflowBoardItem = Extract<VaultTimelineItem, { kind: "workflowBoard" }>;
type Mock = ReturnType<typeof vi.fn>;

afterEach(() => {
  document.body.innerHTML = "";
});

const SCOUT_ID = "claude:wfboard:wfagent:wf_board1:agent-aaa111";

function makeItem(over: Partial<WorkflowBoardItem> = {}): WorkflowBoardItem {
  return {
    kind: "workflowBoard",
    wfId: "wf_board1",
    workflowName: "design-board",
    summary: "Audit and build the board",
    status: "completed",
    agentCount: 2,
    durationMs: 5000,
    totalTokens: 12345,
    totalToolCalls: 7,
    model: "claude-opus-4-8[1m]",
    phases: [
      { index: 1, title: "Plan", detail: "plan phase detail" },
      { index: 2, title: "Build", detail: "build phase detail" },
    ],
    agents: [
      {
        label: "scout",
        phaseIndex: 1,
        entryId: SCOUT_ID,
        model: "claude-opus-4-8[1m]",
        tokens: 5000,
        toolCalls: 3,
        durationMs: 2000,
      },
      { label: "writer", phaseIndex: 2, model: "claude-sonnet-4-6", tokens: 7345, toolCalls: 4, durationMs: 3000 },
    ],
    ...over,
  };
}

/** A bag with a real selection store so persistence behaves like the controller. */
function makeBag(over: Partial<PreviewTimelineBag> = {}): PreviewTimelineBag {
  const store = new Map<string, BoardSelection>();
  return {
    isRunExpanded: () => false,
    onExpandRun: () => {},
    isNestedExpanded: () => false,
    setNestedExpanded: () => {},
    populateNested: vi.fn(),
    getBoardSelection: (key) => store.get(key),
    setBoardSelection: (key, sel) => {
      store.set(key, sel);
    },
    ...over,
  };
}

function mount(item = makeItem(), bag = makeBag()): { board: HTMLElement; bag: PreviewTimelineBag } {
  const board = renderWorkflowBoard(item, bag);
  document.body.appendChild(board);
  return { board, bag };
}

const leafByLabel = (board: HTMLElement, label: string): HTMLElement | undefined =>
  [...board.querySelectorAll<HTMLElement>(".vault-wfboard-leaf")].find((l) => l.textContent === label);

const headByTitle = (board: HTMLElement, title: string): HTMLButtonElement | undefined =>
  [...board.querySelectorAll<HTMLButtonElement>(".vault-wfboard-phase-head")].find(
    (h) => h.querySelector(".vault-wfboard-phase-title")?.textContent === title,
  );

describe("renderWorkflowBoard: header + structure", () => {
  it("the header is a 'Workflow: <name>' collapse toggle (+ status); summary/meta live in the body", () => {
    const { board } = mount();
    expect(board.querySelector(".vault-wfboard-name")?.textContent).toBe("Workflow: design-board");
    expect(board.querySelector(".vault-wfboard-status")?.textContent).toBe("completed");
    expect(board.querySelector(".vault-wfboard-summary")?.textContent).toBe("Audit and build the board");
    const meta = board.querySelector(".vault-wfboard-meta")?.textContent ?? "";
    expect(meta).toContain("2 agents");
    expect(meta).toContain("12.3k tok");
    expect(meta).toContain("7 tool calls");
  });

  it("folds itself (one layer): starts collapsed, the header toggles the body", () => {
    const { board } = mount();
    const header = board.querySelector<HTMLButtonElement>(".vault-wfboard-header");
    expect(board.classList.contains("is-collapsed")).toBe(true);
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    header?.click();
    expect(board.classList.contains("is-collapsed")).toBe(false);
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    header?.click();
    expect(board.classList.contains("is-collapsed")).toBe(true);
  });

  it("frames the description (summary + meta) in a box, and peeks the summary in the collapsed header", () => {
    const { board } = mount();
    // Framed description box holds BOTH the summary and the run meta.
    const desc = board.querySelector(".vault-wfboard-desc");
    expect(desc).not.toBeNull();
    expect(desc?.querySelector(".vault-wfboard-summary")?.textContent).toBe("Audit and build the board");
    expect(desc?.querySelector(".vault-wfboard-meta")?.textContent ?? "").toContain("2 agents");
    // Collapsed peek lives in the header (the session-view description beyond the name).
    expect(board.querySelector(".vault-wfboard-header .vault-wfboard-subtitle")?.textContent).toBe(
      "Audit and build the board",
    );
  });

  it("renders one phase row per phase (title + agent count) with its agent leaves — agents listed ONCE", () => {
    const { board } = mount();
    const phases = board.querySelectorAll(".vault-wfboard-phase");
    expect(phases).toHaveLength(2);
    expect([...board.querySelectorAll(".vault-wfboard-phase-title")].map((e) => e.textContent)).toEqual([
      "Plan",
      "Build",
    ]);
    expect([...board.querySelectorAll(".vault-wfboard-phase-count")].map((e) => e.textContent)).toEqual(["1", "1"]);
    // The tree is the sole place agents appear — no separate card list.
    expect([...board.querySelectorAll(".vault-wfboard-leaf")].map((e) => e.textContent)).toEqual(["scout", "writer"]);
    expect(board.querySelector(".vault-wfboard-agent-card")).toBeNull();
  });

  it("reflects each phase's open/closed state via aria-expanded on its head", () => {
    const { board } = mount();
    const plan = headByTitle(board, "Plan");
    expect(plan?.getAttribute("aria-expanded")).toBe("false");
    plan?.click();
    expect(plan?.getAttribute("aria-expanded")).toBe("true");
    plan?.click();
    expect(plan?.getAttribute("aria-expanded")).toBe("false");
  });

  it("has a two-pane layout with a splitter; phases start collapsed with a neutral hint", () => {
    const { board } = mount();
    expect(board.querySelector(".vault-wfboard-left")).not.toBeNull();
    expect(board.querySelector(".vault-wfboard-split")).not.toBeNull();
    expect(board.querySelector(".vault-wfboard-right")).not.toBeNull();
    expect(board.querySelector(".vault-wfboard-phase.is-open")).toBeNull();
    expect(board.querySelector(".vault-wfboard-empty")?.textContent).toContain("Select an agent");
  });

  it("selecting an agent auto-expands a collapsed board so its transcript is visible", () => {
    const { board, bag } = mount();
    expect(board.classList.contains("is-collapsed")).toBe(true);
    leafByLabel(board, "scout")?.click();
    expect(board.classList.contains("is-collapsed")).toBe(false);
    expect(bag.populateNested).toHaveBeenCalledTimes(1);
  });
});

describe("renderWorkflowBoard: selection (single layer)", () => {
  it("selecting an agent leaf fills the right pane via populateNested — no cards, no back button", () => {
    const { board, bag } = mount();
    headByTitle(board, "Plan")?.click(); // expand
    leafByLabel(board, "scout")?.click();
    expect(bag.populateNested).toHaveBeenCalledTimes(1);
    const [entryId, container] = (bag.populateNested as Mock).mock.calls[0];
    expect(entryId).toBe(SCOUT_ID);
    expect(container).toBeInstanceOf(HTMLElement);
    expect(container.classList.contains("vault-wfboard-detail-body")).toBe(true);
    expect(board.querySelector(".vault-wfboard-detail-head")?.textContent).toBe("scout");
    // model · tokens · tools · duration migrates into the detail header (no card meta).
    expect(board.querySelector(".vault-wfboard-detail-meta")?.textContent ?? "").toContain("5.0k tok");
    // single layer: there is no intermediate card view and no back affordance.
    expect(board.querySelector(".vault-wfboard-back")).toBeNull();
    expect(board.querySelector(".vault-wfboard-leaf.sel")?.textContent).toBe("scout");
  });

  it("an agent with no entryId renders a non-interactive leaf that never populates", () => {
    const { board, bag } = mount();
    headByTitle(board, "Build")?.click();
    const writer = leafByLabel(board, "writer");
    expect(writer?.tagName).toBe("DIV");
    expect(writer?.classList.contains("is-disabled")).toBe(true);
    writer?.click();
    expect(bag.populateNested).not.toHaveBeenCalled();
  });

  it("switching agents swaps the transcript and moves the highlight to exactly one leaf", () => {
    const item = makeItem({
      phases: [
        { index: 1, title: "Plan" },
        { index: 2, title: "Build" },
      ],
      agents: [
        { label: "scout", phaseIndex: 1, entryId: SCOUT_ID },
        { label: "builder", phaseIndex: 2, entryId: "claude:wfboard:wfagent:wf_board1:agent-bbb" },
      ],
    });
    const { board, bag } = mount(item);
    headByTitle(board, "Plan")?.click();
    headByTitle(board, "Build")?.click();
    leafByLabel(board, "scout")?.click();
    expect(board.querySelector(".vault-wfboard-leaf.sel")?.textContent).toBe("scout");
    leafByLabel(board, "builder")?.click();
    expect(board.querySelectorAll(".vault-wfboard-leaf.sel")).toHaveLength(1);
    expect(board.querySelector(".vault-wfboard-leaf.sel")?.textContent).toBe("builder");
    expect(board.querySelector(".vault-wfboard-detail-head")?.textContent).toBe("builder");
    expect(bag.populateNested).toHaveBeenCalledTimes(2);
  });

  it("toggling a phase expands/collapses its subtree WITHOUT disturbing the right pane", () => {
    const { board, bag } = mount();
    headByTitle(board, "Plan")?.click(); // open
    leafByLabel(board, "scout")?.click(); // show scout transcript
    expect(board.querySelector(".vault-wfboard-detail-head")?.textContent).toBe("scout");
    // Collapsing the phase must not clear the open transcript (master-detail, not card nav).
    headByTitle(board, "Plan")?.click(); // collapse
    expect(board.querySelector(".vault-wfboard-phase.is-open")).toBeNull();
    expect(board.querySelector(".vault-wfboard-detail-head")?.textContent).toBe("scout");
    expect(board.querySelector(".vault-wfboard-empty")).toBeNull();
    expect(bag.populateNested).toHaveBeenCalledTimes(1); // no extra render from the toggle
  });

  it("an agent whose phaseIndex matches no phase is shown under a trailing 'Other' phase", () => {
    const item = makeItem({
      phases: [{ index: 1, title: "Plan" }],
      agents: [{ label: "stray", phaseIndex: 99, entryId: SCOUT_ID }],
    });
    const { board, bag } = mount(item);
    expect([...board.querySelectorAll(".vault-wfboard-phase-title")].map((e) => e.textContent)).toContain("Other");
    headByTitle(board, "Other")?.click();
    leafByLabel(board, "stray")?.click();
    expect(bag.populateNested).toHaveBeenCalledTimes(1);
    expect(board.querySelector(".vault-wfboard-detail-head")?.textContent).toBe("stray");
  });
});

describe("renderWorkflowBoard: selection persists across re-render (issue 4)", () => {
  it("a fresh board built from the same bag reopens the selected agent + its phase", () => {
    const item = makeItem();
    const bag = makeBag();
    const board1 = renderWorkflowBoard(item, bag);
    document.body.appendChild(board1);
    headByTitle(board1, "Plan")?.click();
    leafByLabel(board1, "scout")?.click();
    expect(bag.populateNested).toHaveBeenCalledTimes(1);

    // Simulate the preview re-render that "Show N more steps" triggers: the board is
    // rebuilt from scratch by the SAME owner (same bag/selection store).
    const board2 = renderWorkflowBoard(item, bag);
    document.body.replaceChildren(board2);

    // Without a click, the rebuilt board reopens scout's transcript (so the now-
    // expanded run renders) instead of resetting to the hint.
    expect(bag.populateNested).toHaveBeenCalledTimes(2);
    expect((bag.populateNested as Mock).mock.calls[1][0]).toBe(SCOUT_ID);
    expect(board2.classList.contains("is-collapsed")).toBe(false); // re-expanded so the agent shows
    expect(board2.querySelector(".vault-wfboard-leaf.sel")?.textContent).toBe("scout");
    expect(board2.querySelector(".vault-wfboard-phase.is-open")).not.toBeNull();
    expect(board2.querySelector(".vault-wfboard-detail-head")?.textContent).toBe("scout");
    expect(board2.querySelector(".vault-wfboard-empty")).toBeNull();
  });

  it("a manually expanded phase stays open across the re-render even with no agent selected", () => {
    const item = makeItem();
    const bag = makeBag();
    const board1 = renderWorkflowBoard(item, bag);
    document.body.appendChild(board1);
    headByTitle(board1, "Build")?.click(); // open Build, select nothing

    const board2 = renderWorkflowBoard(item, bag);
    document.body.replaceChildren(board2);
    expect(headByTitle(board2, "Build")?.closest(".vault-wfboard-phase")?.classList.contains("is-open")).toBe(true);
    expect(headByTitle(board2, "Plan")?.closest(".vault-wfboard-phase")?.classList.contains("is-open")).toBe(false);
    expect(board2.querySelector(".vault-wfboard-empty")).not.toBeNull(); // still no agent → hint
  });
});

describe("dispatch + breaksRun (2_2)", () => {
  it("renders a workflowBoard standalone, splitting surrounding tools into two capped runs", () => {
    const tool = (n: number): VaultTimelineItem => ({ kind: "tool", tool: "Bash", detail: `cmd ${n}` });
    const timeline: VaultTimelineItem[] = [
      { kind: "message", role: "user", text: "go", timestamp: 1 },
      tool(1),
      tool(2),
      tool(3),
      tool(4),
      makeItem(),
      tool(5),
      tool(6),
      tool(7),
      tool(8),
    ];
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderTimelineInto(container, timeline, "root", makeBag());

    expect(container.querySelector(".vault-wfboard")).not.toBeNull();
    // breaksRun: the two 4-tool groups become two INDEPENDENT runs, each capped at
    // 3 → two "Show N more" buttons. A single un-split run would show only one.
    expect(container.querySelectorAll(".vault-preview-expand")).toHaveLength(2);
  });
});

describe("renderWorkflowBoard: splitter", () => {
  it("dragging the splitter adjusts the left pane's flex-basis within bounds", () => {
    const { board } = mount();
    const panes = board.querySelector<HTMLElement>(".vault-wfboard-panes");
    const left = board.querySelector<HTMLElement>(".vault-wfboard-left");
    const split = board.querySelector<HTMLElement>(".vault-wfboard-split");
    if (!panes || !left || !split) {
      throw new Error("missing board structure");
    }
    panes.getBoundingClientRect = () =>
      ({ left: 0, width: 600, top: 0, right: 600, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;

    split.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, bubbles: true }));
    expect(left.style.flexBasis).toBe("300px");
    // Past the min bound it clamps, not collapses.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, bubbles: true }));
    expect(left.style.flexBasis).toBe("160px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // After release, moves no longer resize.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, bubbles: true }));
    expect(left.style.flexBasis).toBe("160px");
  });

  it("force-releases the splitter drag if the board is detached mid-drag (B2)", () => {
    const { board } = mount();
    const panes = board.querySelector<HTMLElement>(".vault-wfboard-panes");
    const left = board.querySelector<HTMLElement>(".vault-wfboard-left");
    const split = board.querySelector<HTMLElement>(".vault-wfboard-split");
    if (!panes || !left || !split) {
      throw new Error("missing board structure");
    }
    panes.getBoundingClientRect = () =>
      ({ left: 0, width: 600, top: 0, right: 600, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    split.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, bubbles: true }));
    expect(left.style.flexBasis).toBe("300px");
    board.remove(); // overlay closes mid-drag
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 250, bubbles: true })); // releases (board not connected)
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, bubbles: true })); // listener now gone → inert
    expect(left.style.flexBasis).toBe("300px"); // no further resize after detach
  });
});
