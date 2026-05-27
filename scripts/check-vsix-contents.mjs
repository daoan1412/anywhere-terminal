#!/usr/bin/env node
// scripts/check-vsix-contents.mjs — Sanity check on what `vsce package` will ship.
//
// Runs `vsce ls` (dry-run file list) and asserts every required runtime asset
// is in the include set. Catches `.vscodeignore` regressions like the 0.14.0
// bug where `resources/shell-integration/*` were silently excluded, breaking
// shell-integration injection in the published extension. See:
//   asimov/changes/archive/260527-0804-export-terminal-session/

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Files (relative to repo root) that MUST be inside the VSIX for the
// extension to function at runtime. Add to this list whenever a new vendored
// resource gets wired into the runtime code path.
const REQUIRED_FILES = [
  "dist/extension.js",
  "media/webview.js",
  "media/xterm.css",
  "resources/shell-integration/shellIntegration-bash.sh",
  "resources/shell-integration/shellIntegration-env.zsh",
  "resources/shell-integration/shellIntegration-profile.zsh",
  "resources/shell-integration/shellIntegration-rc.zsh",
  "resources/shell-integration/shellIntegration-login.zsh",
  "resources/shell-integration/shellIntegration.fish",
  "resources/shell-integration/shellIntegration.ps1",
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
];

const result = spawnSync("vsce", ["ls", "--no-dependencies"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});

if (result.status !== 0) {
  console.error("[check-vsix-contents] `vsce ls` failed:");
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

const includedFiles = new Set(
  result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);

const missing = REQUIRED_FILES.filter((f) => !includedFiles.has(f));

if (missing.length > 0) {
  console.error("[check-vsix-contents] FAIL — these files would NOT be in the VSIX:");
  for (const f of missing) {
    console.error(`  - ${f}`);
  }
  console.error("");
  console.error("Likely cause: `.vscodeignore` is missing an `!<path>` un-ignore rule.");
  console.error("Edit `.vscodeignore`, add the missing allowlist line, then re-run.");
  process.exit(1);
}

console.log(`[check-vsix-contents] OK: ${REQUIRED_FILES.length} required files present in VSIX manifest`);
