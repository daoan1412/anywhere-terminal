// src/pty/ShellIntegrationInjector.test.ts
// Unit tests for the per-shell shell-integration injector. Stubs the
// filesystem so we can snapshot args/env without writing real files.

import { describe, expect, it } from "vitest";
import { type InjectionContext, type InjectorFs, injectShellIntegration } from "./ShellIntegrationInjector";

interface FsCall {
  op: "mkdir" | "copy" | "rm";
  path: string;
  opts?: unknown;
}

function fakeFs(calls: FsCall[]): InjectorFs {
  return {
    mkdirSync(p, opts) {
      calls.push({ op: "mkdir", path: p, opts });
    },
    copyFileSync(src, dst) {
      calls.push({ op: "copy", path: `${src} -> ${dst}` });
    },
    rmSync(p, opts) {
      calls.push({ op: "rm", path: p, opts });
    },
  };
}

function fakeCtx(opts?: Partial<InjectionContext>): { ctx: InjectionContext; calls: FsCall[]; ids: string[] } {
  const calls: FsCall[] = [];
  const ids: string[] = [];
  let counter = 0;
  return {
    calls,
    ids,
    ctx: {
      scriptsDir: "/ext/resources/shell-integration",
      tmpRoot: "/tmp",
      generateId: () => {
        counter++;
        const id = `uuid-${counter}`;
        ids.push(id);
        return id;
      },
      fs: fakeFs(calls),
      ...opts,
    },
  };
}

describe("ShellIntegrationInjector: bash", () => {
  it("prepends --init-file with a per-session temp script", () => {
    const { ctx, calls, ids } = fakeCtx();
    const result = injectShellIntegration("/bin/bash", ["-l"], { HOME: "/u/h" }, ctx);
    expect(result).not.toBeNull();
    // First generateId is the nonce; second is the temp-dir suffix.
    expect(result!.nonce).toBe(ids[0]);
    const expectedDir = `/tmp/at-bash-${ids[1]}`;
    const expectedInit = `${expectedDir}/shellIntegration.bash`;
    expect(result!.args).toEqual(["--init-file", expectedInit, "-l"]);
    expect(result!.env).toEqual({ HOME: "/u/h", VSCODE_NONCE: ids[0], VSCODE_INJECTION: "1" });
    expect(calls).toContainEqual({ op: "mkdir", path: expectedDir, opts: { recursive: true, mode: 0o700 } });
    expect(calls).toContainEqual({
      op: "copy",
      path: `/ext/resources/shell-integration/shellIntegration-bash.sh -> ${expectedInit}`,
    });
  });

  it("cleanup removes the temp dir (idempotent)", () => {
    const { ctx, calls, ids } = fakeCtx();
    const result = injectShellIntegration("/bin/bash", [], {}, ctx);
    expect(result).not.toBeNull();
    const tempDir = `/tmp/at-bash-${ids[1]}`;
    result!.cleanup();
    expect(calls).toContainEqual({ op: "rm", path: tempDir, opts: { recursive: true, force: true } });
    const rmCountBefore = calls.filter((c) => c.op === "rm").length;
    result!.cleanup();
    const rmCountAfter = calls.filter((c) => c.op === "rm").length;
    expect(rmCountAfter).toBe(rmCountBefore); // Second call is a no-op
  });

  it("skips when both --noprofile AND --norc are passed", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("/bin/bash", ["--noprofile", "--norc"], {}, ctx)).toBeNull();
  });

  it("does NOT skip with only --norc", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("/bin/bash", ["--norc"], {}, ctx)).not.toBeNull();
  });
});

describe("ShellIntegrationInjector: zsh", () => {
  it("creates per-session temp ZDOTDIR with 4 vendored files", () => {
    const { ctx, calls, ids } = fakeCtx();
    const result = injectShellIntegration("/bin/zsh", [], { HOME: "/u/h" }, ctx);
    expect(result).not.toBeNull();
    const tempDir = `/tmp/at-zsh-${ids[1]}`;
    expect(result!.args).toEqual([]); // args unchanged for zsh
    expect(result!.env).toEqual({
      HOME: "/u/h",
      ZDOTDIR: tempDir,
      USER_ZDOTDIR: "/u/h", // ← Falls back to HOME (zsh's default) when ZDOTDIR unset
      VSCODE_NONCE: ids[0],
      VSCODE_INJECTION: "1",
    });
    const copyOps = calls.filter((c) => c.op === "copy").map((c) => c.path);
    expect(copyOps).toEqual([
      `/ext/resources/shell-integration/shellIntegration-env.zsh -> ${tempDir}/.zshenv`,
      `/ext/resources/shell-integration/shellIntegration-profile.zsh -> ${tempDir}/.zprofile`,
      `/ext/resources/shell-integration/shellIntegration-rc.zsh -> ${tempDir}/.zshrc`,
      `/ext/resources/shell-integration/shellIntegration-login.zsh -> ${tempDir}/.zlogin`,
    ]);
  });

  it("preserves the user's existing ZDOTDIR as USER_ZDOTDIR", () => {
    const { ctx } = fakeCtx();
    const result = injectShellIntegration("/bin/zsh", [], { ZDOTDIR: "/u/h/.config/zsh" }, ctx);
    expect(result!.env.USER_ZDOTDIR).toBe("/u/h/.config/zsh");
    expect(result!.env.ZDOTDIR).toMatch(/^\/tmp\/at-zsh-/);
  });

  it("[B1] USER_ZDOTDIR falls back to HOME when ZDOTDIR is unset (not empty string)", () => {
    // Vendored .zshenv/.zprofile/.zshrc/.zlogin ALL source $USER_ZDOTDIR/<file>.
    // Empty fallback would make every source `/<file>` (path doesn't exist) →
    // user config silently skipped. zsh's default for ZDOTDIR when unset is $HOME.
    const { ctx } = fakeCtx();
    const result = injectShellIntegration("/bin/zsh", [], { HOME: "/u/h" }, ctx);
    expect(result!.env.USER_ZDOTDIR).toBe("/u/h");
  });

  it("[B1] USER_ZDOTDIR is '' only when neither ZDOTDIR nor HOME is set", () => {
    const { ctx } = fakeCtx();
    const result = injectShellIntegration("/bin/zsh", [], {}, ctx);
    expect(result!.env.USER_ZDOTDIR).toBe("");
  });
});

describe("ShellIntegrationInjector: fish", () => {
  it("prepends --init-command sourcing the vendored fish script", () => {
    const { ctx, ids } = fakeCtx();
    const result = injectShellIntegration("/opt/homebrew/bin/fish", [], { HOME: "/u/h" }, ctx);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["--init-command", "source '/ext/resources/shell-integration/shellIntegration.fish'"]);
    // fish doesn't need VSCODE_INJECTION (no rc-source gate in shellIntegration.fish).
    expect(result!.env).toEqual({ HOME: "/u/h", VSCODE_NONCE: ids[0] });
    expect(result!.cleanup).toBeInstanceOf(Function); // no-op but callable
  });

  it("escapes single-quotes inside the script path", () => {
    const { ctx } = fakeCtx({ scriptsDir: "/path/with'quote" });
    const result = injectShellIntegration("/usr/bin/fish", [], {}, ctx);
    expect(result!.args[1]).toBe("source '/path/with'\\''quote/shellIntegration.fish'");
  });
});

describe("ShellIntegrationInjector: pwsh", () => {
  it("prepends -noexit -command dot-sourcing the ps1", () => {
    const { ctx, ids } = fakeCtx();
    const result = injectShellIntegration("/usr/local/bin/pwsh", [], { PATH: "/usr/bin" }, ctx);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["-noexit", "-command", ". '/ext/resources/shell-integration/shellIntegration.ps1'"]);
    // pwsh's shellIntegration.ps1 has no VSCODE_INJECTION gate (PowerShell profile loading is opt-out via -NoProfile).
    expect(result!.env).toEqual({ PATH: "/usr/bin", VSCODE_NONCE: ids[0] });
  });

  it("recognises pwsh.exe (Windows)", () => {
    const { ctx } = fakeCtx();
    const result = injectShellIntegration("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [], {}, ctx);
    expect(result).not.toBeNull();
  });

  it("skips when -NoProfile (case-insensitive) is present", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("/usr/local/bin/pwsh", ["-NoProfile"], {}, ctx)).toBeNull();
    expect(injectShellIntegration("/usr/local/bin/pwsh", ["-noprofile"], {}, ctx)).toBeNull();
    expect(injectShellIntegration("/usr/local/bin/pwsh", ["-NOPROFILE"], {}, ctx)).toBeNull();
  });

  it("escapes single-quotes in the PowerShell single-quoted string", () => {
    // Use forward-slash path so path.join behaves identically on every host.
    const { ctx } = fakeCtx({ scriptsDir: "/path/with'apostrophe" });
    const result = injectShellIntegration("pwsh", [], {}, ctx);
    // PS single-quote escape doubles the apostrophe (' → '').
    expect(result!.args[2]).toBe(". '/path/with''apostrophe/shellIntegration.ps1'");
  });
});

describe("ShellIntegrationInjector: unrecognised shells", () => {
  it("returns null for /bin/sh", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("/bin/sh", [], {}, ctx)).toBeNull();
  });

  it("returns null for cmd.exe", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("C:\\Windows\\System32\\cmd.exe", [], {}, ctx)).toBeNull();
  });

  it("returns null for nu / nushell / custom binary", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("/usr/local/bin/nu", [], {}, ctx)).toBeNull();
    expect(injectShellIntegration("/usr/local/bin/nushell", [], {}, ctx)).toBeNull();
    expect(injectShellIntegration("/opt/custom-shell", [], {}, ctx)).toBeNull();
  });

  it("returns null for dash", () => {
    const { ctx } = fakeCtx();
    expect(injectShellIntegration("/bin/dash", [], {}, ctx)).toBeNull();
  });
});

describe("ShellIntegrationInjector: environment hygiene", () => {
  it("never overwrites TERM_PROGRAM", () => {
    const { ctx } = fakeCtx();
    const result = injectShellIntegration("/bin/bash", [], { TERM_PROGRAM: "AnyWhereTerminal" }, ctx);
    expect(result!.env.TERM_PROGRAM).toBe("AnyWhereTerminal");
  });

  it("[B1] sets VSCODE_INJECTION=1 for bash + zsh so vendored scripts source user rc", () => {
    // Vendored bash + zsh scripts gate sourcing user .bashrc / .zshrc / etc.
    // on $VSCODE_INJECTION=="1". Without it set the shell starts with NO user
    // PATH, aliases, prompt, hooks — a hard regression. The script's own
    // VSCODE_SHELL_INTEGRATION re-entry guard prevents double-source from
    // dotfiles that auto-source the integration script.
    const { ctx: bashCtx } = fakeCtx();
    expect(injectShellIntegration("/bin/bash", [], { HOME: "/u/h" }, bashCtx)!.env.VSCODE_INJECTION).toBe("1");
    const { ctx: zshCtx } = fakeCtx();
    expect(injectShellIntegration("/bin/zsh", [], { HOME: "/u/h" }, zshCtx)!.env.VSCODE_INJECTION).toBe("1");
  });

  it("[B1] fish + pwsh do NOT need VSCODE_INJECTION (their scripts have no rc-source gate)", () => {
    const { ctx: fishCtx } = fakeCtx();
    expect(injectShellIntegration("/opt/fish", [], {}, fishCtx)!.env).not.toHaveProperty("VSCODE_INJECTION");
    const { ctx: pwshCtx } = fakeCtx();
    expect(injectShellIntegration("/usr/local/bin/pwsh", [], {}, pwshCtx)!.env).not.toHaveProperty("VSCODE_INJECTION");
  });

  it("[B3] scrubs VSCODE_SHELL_INTEGRATION from inherited env so vendored scripts don't early-return", () => {
    // Both bash + zsh scripts check `if [[ -n "$VSCODE_SHELL_INTEGRATION" ]]; then return; fi`
    // at the top. Inheriting this var from a parent shell (e.g. extension host
    // launched from a terminal whose shell sourced VS Code's integration) would
    // make the injection a silent no-op.
    const dirtyEnv = { HOME: "/u/h", VSCODE_SHELL_INTEGRATION: "1" };
    for (const shell of ["/bin/bash", "/bin/zsh", "/opt/fish", "/usr/local/bin/pwsh"]) {
      const { ctx } = fakeCtx();
      const result = injectShellIntegration(shell, [], dirtyEnv, ctx);
      expect(result!.env).not.toHaveProperty("VSCODE_SHELL_INTEGRATION");
    }
  });

  it("[B3] scrubs VSCODE_ZDOTDIR (zsh-script internal state) from inherited env", () => {
    const { ctx } = fakeCtx();
    const result = injectShellIntegration(
      "/bin/zsh",
      [],
      { HOME: "/u/h", VSCODE_ZDOTDIR: "/stale/path/from/parent" },
      ctx,
    );
    expect(result!.env).not.toHaveProperty("VSCODE_ZDOTDIR");
  });

  it("nonce is unique per call", () => {
    const { ctx } = fakeCtx();
    const a = injectShellIntegration("/bin/bash", [], {}, ctx);
    const b = injectShellIntegration("/bin/bash", [], {}, ctx);
    expect(a!.nonce).not.toBe(b!.nonce);
  });
});
