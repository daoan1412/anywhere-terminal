// src/providers/previewValidation.test.ts — IPC guard tests.
//
// See: asimov/changes/add-hover-file-preview/.reviews/round-1.md W3

import { describe, expect, it } from "vitest";
import { isValidPreviewRequest, MAX_ID_LENGTH, MAX_PREVIEW_PATH_LENGTH } from "./previewValidation";

describe("isValidPreviewRequest", () => {
  it("accepts a well-formed request", () => {
    expect(isValidPreviewRequest({ path: "src/foo.ts", sessionId: "s1", requestId: "r1" })).toBe(true);
  });

  it("rejects when path is not a string", () => {
    expect(isValidPreviewRequest({ path: 42, sessionId: "s1", requestId: "r1" })).toBe(false);
  });

  it("rejects when path is empty", () => {
    expect(isValidPreviewRequest({ path: "", sessionId: "s1", requestId: "r1" })).toBe(false);
  });

  it("rejects when path exceeds PATH_MAX-ish", () => {
    const long = "a".repeat(MAX_PREVIEW_PATH_LENGTH + 1);
    expect(isValidPreviewRequest({ path: long, sessionId: "s1", requestId: "r1" })).toBe(false);
  });

  it("rejects when path contains NUL byte", () => {
    expect(isValidPreviewRequest({ path: "src/\x00.ts", sessionId: "s1", requestId: "r1" })).toBe(false);
  });

  it("rejects when sessionId exceeds MAX_ID_LENGTH", () => {
    const long = "s".repeat(MAX_ID_LENGTH + 1);
    expect(isValidPreviewRequest({ path: "src/foo.ts", sessionId: long, requestId: "r1" })).toBe(false);
  });

  it("rejects when requestId exceeds MAX_ID_LENGTH", () => {
    const long = "r".repeat(MAX_ID_LENGTH + 1);
    expect(isValidPreviewRequest({ path: "src/foo.ts", sessionId: "s1", requestId: long })).toBe(false);
  });

  it("rejects when fields are missing", () => {
    expect(isValidPreviewRequest({})).toBe(false);
    expect(isValidPreviewRequest({ path: "src/foo.ts" })).toBe(false);
  });

  it("accepts exactly at the boundaries", () => {
    const path = "a".repeat(MAX_PREVIEW_PATH_LENGTH);
    const id = "x".repeat(MAX_ID_LENGTH);
    expect(isValidPreviewRequest({ path, sessionId: id, requestId: id })).toBe(true);
  });
});
