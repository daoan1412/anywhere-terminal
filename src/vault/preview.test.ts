// src/vault/preview.test.ts — Unit tests for the D4 title-preview bound.

import { describe, expect, it } from "vitest";
import { boundedPreview } from "./preview";

describe("boundedPreview (D4)", () => {
  it("strips newlines and collapses whitespace to single spaces", () => {
    expect(boundedPreview("hello\nworld\t\tagain")).toBe("hello world again");
    expect(boundedPreview("  padded  ")).toBe("padded");
  });

  it("truncates to 120 characters", () => {
    const long = "x".repeat(300);
    const out = boundedPreview(long);
    expect(out).toHaveLength(120);
  });

  it("never emits a newline even when the source is multi-line and long", () => {
    const src = `${"a".repeat(80)}\n${"b".repeat(80)}`;
    const out = boundedPreview(src);
    expect(out).toHaveLength(120);
    expect(out).not.toContain("\n");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(boundedPreview("")).toBe("");
    expect(boundedPreview("   \n  ")).toBe("");
  });

  it("leaves short single-line titles unchanged", () => {
    expect(boundedPreview("fix the bug")).toBe("fix the bug");
  });
});
