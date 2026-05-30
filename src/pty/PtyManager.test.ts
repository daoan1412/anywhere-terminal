// src/pty/PtyManager.test.ts — Unit tests for PtyManager functions
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setExtension, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import { PtyLoadError } from "../types/errors";
import {
  _resetCache,
  buildEnvironment,
  detectShell,
  loadNodePty,
  resolveWorkingDirectory,
  validateShell,
} from "./PtyManager";

// Mock node:fs at module level so PtyManager's import resolves to the mock
vi.mock("node:fs", () => {
  return {
    default: {
      statSync: vi.fn(),
    },
    statSync: vi.fn(),
  };
});

// Import the mocked fs AFTER vi.mock declaration
import * as fs from "node:fs";

const mockedStatSync = vi.mocked(fs.statSync);

// ─── Test Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  __resetAll();
  _resetCache();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── validateShell ──────────────────────────────────────────────────

describe("validateShell", () => {
  it("returns true for an existing executable file (posix)", () => {
    mockedStatSync.mockReturnValue({
      isFile: () => true,
      mode: 0o755,
    } as unknown as fs.Stats);

    expect(validateShell("/bin/zsh", "darwin")).toBe(true);
  });

  it("returns false for a non-existent path", () => {
    mockedStatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(validateShell("/nonexistent/shell", "darwin")).toBe(false);
  });

  it("returns false for a directory", () => {
    mockedStatSync.mockReturnValue({
      isFile: () => false,
      mode: 0o755,
    } as unknown as fs.Stats);

    expect(validateShell("/usr/bin", "darwin")).toBe(false);
  });

  it("returns false for a posix file without execute permission", () => {
    mockedStatSync.mockReturnValue({
      isFile: () => true,
      mode: 0o644,
    } as unknown as fs.Stats);

    expect(validateShell("/bin/noexec", "darwin")).toBe(false);
  });

  it("returns true on Windows for an existing file without an execute bit", () => {
    mockedStatSync.mockReturnValue({
      isFile: () => true,
      mode: 0o666,
    } as unknown as fs.Stats);

    expect(validateShell("C:\\Windows\\System32\\cmd.exe", "win32")).toBe(true);
  });

  it("returns false on Windows for a directory", () => {
    mockedStatSync.mockReturnValue({
      isFile: () => false,
      mode: 0o666,
    } as unknown as fs.Stats);

    expect(validateShell("C:\\Windows\\System32", "win32")).toBe(false);
  });
});

// ─── detectShell ────────────────────────────────────────────────────

describe("detectShell", () => {
  function mockShellExists(validPaths: Set<string>) {
    mockedStatSync.mockImplementation((p) => {
      const pathStr = typeof p === "string" ? p : p.toString();
      if (validPaths.has(pathStr)) {
        return { isFile: () => true, mode: 0o755 } as unknown as fs.Stats;
      }
      throw new Error("ENOENT");
    });
  }

  // ─── macOS ───
  it("returns $SHELL when valid (macOS)", () => {
    mockShellExists(new Set(["/bin/zsh"]));
    const result = detectShell("darwin", { SHELL: "/bin/zsh" }, "");
    expect(result.shell).toBe("/bin/zsh");
    expect(result.args).toEqual(["--login"]);
  });

  it("falls back to /bin/bash when $SHELL is unset and /bin/zsh is missing (macOS)", () => {
    mockShellExists(new Set(["/bin/bash"]));
    const result = detectShell("darwin", {}, "");
    expect(result.shell).toBe("/bin/bash");
    expect(result.args).toEqual(["--login"]);
  });

  it("falls back to /bin/sh with no --login arg (macOS)", () => {
    mockShellExists(new Set(["/bin/sh"]));
    const result = detectShell("darwin", {}, "");
    expect(result.shell).toBe("/bin/sh");
    expect(result.args).toEqual([]);
  });

  it("returns --login for /usr/local/bin/bash (basename check)", () => {
    mockShellExists(new Set(["/usr/local/bin/bash"]));
    const result = detectShell("darwin", { SHELL: "/usr/local/bin/bash" }, "");
    expect(result.shell).toBe("/usr/local/bin/bash");
    expect(result.args).toEqual(["--login"]);
  });

  it("returns /bin/sh unconditionally when no shell validates (macOS) — does not throw", () => {
    mockShellExists(new Set());
    const result = detectShell("darwin", {}, "");
    expect(result.shell).toBe("/bin/sh");
    expect(result.args).toEqual([]);
  });

  // ─── vscode.env.shell priority ───
  it("prefers vscode.env.shell when it validates", () => {
    mockShellExists(new Set(["/opt/homebrew/bin/fish", "/bin/zsh"]));
    const result = detectShell("darwin", { SHELL: "/bin/zsh" }, "/opt/homebrew/bin/fish");
    expect(result.shell).toBe("/opt/homebrew/bin/fish");
    expect(result.args).toEqual([]);
  });

  it("ignores empty vscode.env.shell and falls through to $SHELL", () => {
    mockShellExists(new Set(["/bin/zsh"]));
    const result = detectShell("darwin", { SHELL: "/bin/zsh" }, "");
    expect(result.shell).toBe("/bin/zsh");
  });

  it("ignores whitespace-only vscode.env.shell and falls through to $SHELL", () => {
    mockShellExists(new Set(["/bin/zsh"]));
    const result = detectShell("darwin", { SHELL: "/bin/zsh" }, "   ");
    expect(result.shell).toBe("/bin/zsh");
  });

  // ─── Linux ───
  it("uses the linux chain ($SHELL → /bin/bash → /bin/sh)", () => {
    mockShellExists(new Set(["/bin/bash"]));
    const result = detectShell("linux", {}, "");
    expect(result.shell).toBe("/bin/bash");
    expect(result.args).toEqual(["--login"]);
  });

  // ─── Windows ───
  it("resolves %ComSpec% on Windows without throwing", () => {
    mockShellExists(new Set(["C:\\Windows\\System32\\cmd.exe"]));
    const result = detectShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "");
    expect(result.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(result.args).toEqual([]);
  });

  it("trims %ComSpec% before validating and returning it", () => {
    mockShellExists(new Set(["C:\\Windows\\System32\\cmd.exe"]));
    const result = detectShell("win32", { ComSpec: "  C:\\Windows\\System32\\cmd.exe  " }, "");
    expect(result.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(result.args).toEqual([]);
  });

  it("returns cmd.exe as the unconditional Windows fallback when %ComSpec% is empty", () => {
    mockShellExists(new Set());
    const result = detectShell("win32", { ComSpec: "   ", COMSPEC: "" }, "");
    expect(result.shell).toBe("cmd.exe");
    expect(result.args).toEqual([]);
  });

  it("returns cmd.exe as the unconditional Windows fallback when nothing validates", () => {
    mockShellExists(new Set());
    const result = detectShell("win32", {}, "");
    expect(result.shell).toBe("cmd.exe");
    expect(result.args).toEqual([]);
  });

  it("prefers vscode.env.shell (pwsh) over %ComSpec% on Windows", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    mockShellExists(new Set([pwsh, "C:\\Windows\\System32\\cmd.exe"]));
    const result = detectShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, pwsh);
    expect(result.shell).toBe(pwsh);
    expect(result.args).toEqual([]);
  });

  it("returns --login for Windows bash.exe paths", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    mockShellExists(new Set([bash]));
    const result = detectShell("win32", {}, bash);
    expect(result.shell).toBe(bash);
    expect(result.args).toEqual(["--login"]);
  });
});

// ─── buildEnvironment ───────────────────────────────────────────────

describe("buildEnvironment", () => {
  it("sets TERM and COLORTERM", () => {
    const env = buildEnvironment();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("sets TERM_PROGRAM to AnyWhereTerminal", () => {
    const env = buildEnvironment();
    expect(env.TERM_PROGRAM).toBe("AnyWhereTerminal");
  });

  it("sets LANG to en_US.UTF-8 when LANG is not set", () => {
    const origLang = process.env.LANG;
    delete process.env.LANG;

    try {
      const env = buildEnvironment();
      expect(env.LANG).toBe("en_US.UTF-8");
    } finally {
      if (origLang !== undefined) {
        process.env.LANG = origLang;
      }
    }
  });

  it("preserves existing LANG when already set", () => {
    const origLang = process.env.LANG;
    process.env.LANG = "ja_JP.UTF-8";

    try {
      const env = buildEnvironment();
      expect(env.LANG).toBe("ja_JP.UTF-8");
    } finally {
      if (origLang !== undefined) {
        process.env.LANG = origLang;
      } else {
        delete process.env.LANG;
      }
    }
  });

  it("returns TERM_PROGRAM_VERSION from extension metadata", () => {
    __setExtension({ packageJSON: { version: "1.2.3" } });
    const env = buildEnvironment();
    expect(env.TERM_PROGRAM_VERSION).toBe("1.2.3");
  });

  it("falls back to 0.0.0 when extension is not found", () => {
    __setExtension(undefined);
    const env = buildEnvironment();
    expect(env.TERM_PROGRAM_VERSION).toBe("0.0.0");
  });

  it("filters out undefined values from process.env", () => {
    const env = buildEnvironment();
    for (const value of Object.values(env)) {
      expect(value).not.toBeUndefined();
    }
  });
});

// ─── resolveWorkingDirectory ────────────────────────────────────────

describe("resolveWorkingDirectory", () => {
  it("returns first workspace folder when available", () => {
    __setWorkspaceFolders([{ uri: { fsPath: "/projects/my-app" } }]);
    expect(resolveWorkingDirectory()).toBe("/projects/my-app");
  });

  it("returns first folder when multiple workspace folders exist", () => {
    __setWorkspaceFolders([{ uri: { fsPath: "/projects/first" } }, { uri: { fsPath: "/projects/second" } }]);
    expect(resolveWorkingDirectory()).toBe("/projects/first");
  });

  it("falls back to os.homedir() when no workspace folders", () => {
    __setWorkspaceFolders(undefined);
    expect(resolveWorkingDirectory()).toBe(os.homedir());
  });

  it("falls back to os.homedir() when workspace folders is empty array", () => {
    __setWorkspaceFolders([]);
    expect(resolveWorkingDirectory()).toBe(os.homedir());
  });
});

// ─── loadNodePty ────────────────────────────────────────────────────

describe("loadNodePty", () => {
  beforeEach(() => {
    _resetCache();
    __setAppRoot("/mock/vscode/app");
  });

  it("throws PtyLoadError when all candidate paths fail", () => {
    expect(() => loadNodePty()).toThrow(PtyLoadError);
  });

  it("includes attempted paths in PtyLoadError", () => {
    try {
      loadNodePty();
    } catch (err) {
      expect(err).toBeInstanceOf(PtyLoadError);
      const ptyErr = err as PtyLoadError;
      expect(ptyErr.attemptedPaths).toHaveLength(2);
      expect(ptyErr.attemptedPaths[0]).toContain("node_modules.asar/node-pty");
      expect(ptyErr.attemptedPaths[1]).toContain("node_modules/node-pty");
    }
  });

  it("_resetCache allows re-attempting load", () => {
    // First call fails
    expect(() => loadNodePty()).toThrow(PtyLoadError);
    // Reset and try again — should throw again (not return stale cache)
    _resetCache();
    expect(() => loadNodePty()).toThrow(PtyLoadError);
  });
});
