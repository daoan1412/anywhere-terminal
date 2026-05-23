// src/settings/FileTreeSettingsReader.test.ts — Unit tests for FileTreeSettingsReader

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setConfigValues } from "../test/__mocks__/vscode";
import { __resetFileTreeSettingsWarnings, readFileTreeSettings } from "./FileTreeSettingsReader";

beforeEach(() => {
  __resetAll();
  __resetFileTreeSettingsWarnings();
});

describe("readFileTreeSettings — autoReveal mode normalization", () => {
  it("defaults to 'reveal' when setting is absent (matches VSCode autoReveal default)", () => {
    const result = readFileTreeSettings();
    expect(result.mode).toBe("reveal");
  });

  it("returns 'reveal' for boolean true", () => {
    __setConfigValues({ "anywhereTerminal.fileTree.autoReveal": true });
    expect(readFileTreeSettings().mode).toBe("reveal");
  });

  it("returns 'reveal' for string 'true'", () => {
    __setConfigValues({ "anywhereTerminal.fileTree.autoReveal": "true" });
    expect(readFileTreeSettings().mode).toBe("reveal");
  });

  it("returns 'none' for boolean false", () => {
    __setConfigValues({ "anywhereTerminal.fileTree.autoReveal": false });
    expect(readFileTreeSettings().mode).toBe("none");
  });

  it("returns 'none' for string 'false'", () => {
    __setConfigValues({ "anywhereTerminal.fileTree.autoReveal": "false" });
    expect(readFileTreeSettings().mode).toBe("none");
  });

  it("returns 'focusNoScroll' for the named string", () => {
    __setConfigValues({ "anywhereTerminal.fileTree.autoReveal": "focusNoScroll" });
    expect(readFileTreeSettings().mode).toBe("focusNoScroll");
  });

  it("falls back to 'reveal' for unknown values (defensive)", () => {
    __setConfigValues({ "anywhereTerminal.fileTree.autoReveal": "garbage" });
    expect(readFileTreeSettings().mode).toBe("reveal");
  });
});

describe("readFileTreeSettings — autoRevealExclude normalization", () => {
  it("returns default exclude (node_modules + bower_components) when setting is absent", () => {
    const { excludePatterns } = readFileTreeSettings();
    expect(excludePatterns).toContain("**/node_modules");
    expect(excludePatterns).toContain("**/bower_components");
  });

  it("keeps user-provided patterns whose value is true", () => {
    __setConfigValues({
      "anywhereTerminal.fileTree.autoRevealExclude": {
        "**/dist": true,
        "**/.git": true,
      },
    });
    const { excludePatterns } = readFileTreeSettings();
    expect(excludePatterns).toEqual(expect.arrayContaining(["**/dist", "**/.git"]));
    expect(excludePatterns).toHaveLength(2);
  });

  it("drops patterns explicitly set to false", () => {
    __setConfigValues({
      "anywhereTerminal.fileTree.autoRevealExclude": {
        "**/node_modules": false,
        "**/dist": true,
      },
    });
    const { excludePatterns } = readFileTreeSettings();
    expect(excludePatterns).not.toContain("**/node_modules");
    expect(excludePatterns).toContain("**/dist");
  });

  it("warns once and keeps the pattern when the value is a when-condition object", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setConfigValues({
      "anywhereTerminal.fileTree.autoRevealExclude": {
        "**/foo": { when: "$(basename).js" },
        "**/bar": { when: "$(basename).ts" },
      },
    });
    const { excludePatterns } = readFileTreeSettings();
    expect(excludePatterns).toEqual(expect.arrayContaining(["**/foo", "**/bar"]));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
