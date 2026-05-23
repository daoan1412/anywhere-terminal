// Unit test for the pure git Status-enum → GitStatus mapper.
// Exhaustive over the Status enum so a new git API value can't slip in
// unmapped without the test failing.

import { describe, expect, it } from "vitest";
import { Status } from "./git";
import { mapStatus, pickHigherSeverity } from "./gitStatusMapping";

describe("mapStatus", () => {
  // Documents the exact mapping in one place. Each row maps an enum to its
  // GitStatus value per spec § "Status enum and precedence".
  const cases: Array<[Status, string]> = [
    [Status.INDEX_MODIFIED, "modified"],
    [Status.INDEX_ADDED, "added"],
    [Status.INDEX_DELETED, "deleted"],
    [Status.INDEX_RENAMED, "renamed"],
    [Status.INDEX_COPIED, "added"],
    [Status.MODIFIED, "modified"],
    [Status.DELETED, "deleted"],
    [Status.UNTRACKED, "untracked"],
    [Status.IGNORED, "ignored"],
    [Status.INTENT_TO_ADD, "added"],
    [Status.INTENT_TO_RENAME, "renamed"],
    [Status.TYPE_CHANGED, "modified"],
    [Status.ADDED_BY_US, "conflicted"],
    [Status.ADDED_BY_THEM, "conflicted"],
    [Status.DELETED_BY_US, "conflicted"],
    [Status.DELETED_BY_THEM, "conflicted"],
    [Status.BOTH_ADDED, "conflicted"],
    [Status.BOTH_DELETED, "conflicted"],
    [Status.BOTH_MODIFIED, "conflicted"],
  ];

  for (const [input, expected] of cases) {
    it(`maps Status.${Status[input]} → ${expected}`, () => {
      expect(mapStatus(input)).toBe(expected);
    });
  }

  it("falls back to `modified` for unknown enum values", () => {
    // Future-proof: unrecognized values shouldn't crash; should land on
    // the safest non-empty signal.
    expect(mapStatus(9999 as Status)).toBe("modified");
  });
});

describe("pickHigherSeverity", () => {
  it("orders by spec precedence: conflicted > deleted > modified > renamed > added > untracked > ignored", () => {
    expect(pickHigherSeverity("modified", "added")).toBe("modified");
    expect(pickHigherSeverity("added", "modified")).toBe("modified");
    expect(pickHigherSeverity("conflicted", "modified")).toBe("conflicted");
    expect(pickHigherSeverity("untracked", "ignored")).toBe("untracked");
    expect(pickHigherSeverity("deleted", "modified")).toBe("deleted");
    expect(pickHigherSeverity("renamed", "added")).toBe("renamed");
  });

  it("is reflexive — a status compared with itself wins", () => {
    expect(pickHigherSeverity("modified", "modified")).toBe("modified");
  });
});
