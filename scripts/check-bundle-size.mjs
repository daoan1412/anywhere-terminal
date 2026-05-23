#!/usr/bin/env node
// scripts/check-bundle-size.mjs — Webview bundle-size gate.
//
// Asserts `media/webview.js` does not exceed CEILING_BYTES. Used to keep
// the curated Shiki + grammars bundle within budget.
//
// See: asimov/changes/add-hover-file-preview/design.md D11, Risk Map "Shiki bundle size"

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(__dirname, "..", "media", "webview.js");

const CEILING_BYTES = Math.round(3.6 * 1024 * 1024); // 3.6 MB
//
// Run against PRODUCTION builds only (esbuild --production). Dev builds skip
// minification entirely and run ~10-15% larger; gating dev builds at the
// shipping ceiling causes false failures during the inner compile loop.
//
// Why 3.6 MB (was 3 MB, originally 1.6 MB):
//   - The webview build keeps `minifyIdentifiers: false` and `minifySyntax: false`
//     for xterm.js v6 compatibility (see esbuild.js:95-103). This roughly doubles
//     the Shiki grammar payload because TextMate grammars contain many long
//     identifier-like property names that an identifier-minifier would otherwise
//     mangle.
//   - The webview loads from local disk, not network, so the size impact at runtime
//     is a one-time parse cost.
//   - VSCode itself ships several hundred MB; 3.6 MB for an enhanced terminal is well
//     within the budget for a local extension webview.
//   - Bumped from 3 MB → 3.6 MB by change `port-vscode-async-data-tree` to absorb
//     the vendored `vs/base/browser/ui/list/` + transitive closure (~500 KB delta).
//     Oracle-measured pre-vendor baseline was 3,089,435 bytes (55 KB headroom against
//     3 MB). The actual delta is gated separately by `scripts/measure-vendor-delta.mjs`
//     (≤ 450 KB).
//
// See: design.md D11, Risk Map "Shiki bundle size"

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

let stat;
try {
  stat = statSync(TARGET);
} catch (err) {
  console.error(`[bundle-size] FAIL: ${TARGET} not found — run the build first. (${err.message})`);
  process.exit(1);
}

const size = stat.size;
const ceiling = CEILING_BYTES;
const ratio = ((size / ceiling) * 100).toFixed(1);

console.log(`[bundle-size] ${path.relative(process.cwd(), TARGET)}: ${formatBytes(size)} / ${formatBytes(ceiling)} (${ratio}%)`);

if (size > ceiling) {
  console.error(`[bundle-size] FAIL: bundle exceeds ${formatBytes(ceiling)} ceiling.`);
  process.exit(1);
}

console.log("[bundle-size] OK");
process.exit(0);
