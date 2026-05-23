#!/usr/bin/env node
// scripts/measure-vendor-delta.mjs — Post-vendor bundle delta gate.
//
// Compares the current `media/webview.js` size against the pre-vendor baseline
// recorded in `asimov/changes/port-vscode-async-data-tree/notes/bundle-baseline.txt`.
// Fails (non-zero exit) if the delta exceeds DELTA_CEILING_BYTES, signalling
// that the vendored `vs/base/browser/ui/list/` closure has grown beyond budget
// and the change owner should re-scope (consider lazy-loading Shiki grammars,
// pruning vendor peripherals, or compressing the on-disk bundle).
//
// See: asimov/changes/port-vscode-async-data-tree/specs/vscode-list-widget-vendor/spec.md#requirement-bundle-size-budget
//      asimov/changes/port-vscode-async-data-tree/design.md Risk Map (bundle ceiling)

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(REPO_ROOT, "media", "webview.js");
const BASELINE_FILE = path.join(
  REPO_ROOT,
  "asimov",
  "changes",
  "port-vscode-async-data-tree",
  "notes",
  "bundle-baseline.txt",
);

// 650 KB — Post-build polish (smoke test feedback) vendored the Seti file-icon
// theme so file rows match the VS Code default explorer (seti.woff ~37 KB
// inlined as a data URL ~50 KB base64 + vs-seti-icon-theme.json ~53 KB JSON).
// Total delta jumped from 484 KB to 575 KB. Bumped to 650 KB to keep ~75 KB
// headroom for theme/light-variant data + any future seti tweaks. The
// absolute bundle ceiling (3.6 MB) is the real "no runaway growth" gate.
//
// History:
//   - 450 KB (original) — built from listWidget alone
//   - 550 KB (Wave 9)   — list closure with observableInternal/
//   - 650 KB (Seti pop) — adds vendored Seti icon font + theme JSON
const DELTA_CEILING_BYTES = 650 * 1024;

function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

let baseline;
try {
  const raw = readFileSync(BASELINE_FILE, "utf8").trim();
  baseline = Number.parseInt(raw, 10);
  if (!Number.isFinite(baseline) || baseline <= 0) {
    throw new Error(`baseline file does not contain a positive integer: ${JSON.stringify(raw)}`);
  }
} catch (err) {
  console.error(`[vendor-delta] FAIL: cannot read baseline at ${BASELINE_FILE} — ${err.message}`);
  process.exit(1);
}

let stat;
try {
  stat = statSync(TARGET);
} catch (err) {
  console.error(`[vendor-delta] FAIL: ${TARGET} not found — run the build first. (${err.message})`);
  process.exit(1);
}

const size = stat.size;
const delta = size - baseline;
const ratio = ((delta / DELTA_CEILING_BYTES) * 100).toFixed(1);

console.log(
  `[vendor-delta] webview.js: ${formatBytes(size)} | baseline: ${formatBytes(baseline)} | delta: ${formatBytes(delta)} (${ratio}% of ${formatBytes(DELTA_CEILING_BYTES)} ceiling)`,
);

if (delta > DELTA_CEILING_BYTES) {
  console.error(
    `[vendor-delta] FAIL: vendor delta ${formatBytes(delta)} exceeds ${formatBytes(DELTA_CEILING_BYTES)} ceiling.`,
  );
  console.error("[vendor-delta]   Halt and re-scope. Options: lazy-load Shiki grammars,");
  console.error("[vendor-delta]   prune vendored peripherals, or compress the bundle.");
  process.exit(1);
}

console.log("[vendor-delta] OK");
process.exit(0);
