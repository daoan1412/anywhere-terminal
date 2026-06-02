import { describe, expect, it } from "vitest";
import { parseImagePlaceholders } from "./imagePlaceholderParser";

describe("parseImagePlaceholders", () => {
  it("matches the [Image #N] form (Claude / Codex) with inclusive columns", () => {
    const m = parseImagePlaceholders("look at [Image #3] here");
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ num: 3, startCol: 8, endCol: 17, raw: "[Image #3]" });
  });

  it("matches the [Image N] form without # (OpenCode)", () => {
    const m = parseImagePlaceholders("[Image 12]");
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ num: 12, startCol: 0, endCol: 9, raw: "[Image 12]" });
  });

  it("matches multiple placeholders on one row in order", () => {
    const m = parseImagePlaceholders("[Image #1] and [Image 2]");
    expect(m.map((x) => x.num)).toEqual([1, 2]);
  });

  it("returns nothing for non-placeholder text or malformed forms", () => {
    expect(parseImagePlaceholders("just some text")).toHaveLength(0);
    expect(parseImagePlaceholders("[Image] [Imagex 1] [Image #]")).toHaveLength(0);
  });
});
