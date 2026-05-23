#!/usr/bin/env node
// scripts/check-vendor-headers.mjs — Vendored-source attribution audit.
//
// Walks every `.ts` / `.d.ts` file under `src/vendor/vscode/` and confirms
// the upstream Microsoft Corporation copyright header is present in the first
// 5 lines. Skips files we wrote ourselves (the `nls.ts` stub and any
// `*-stub.d.ts`).
//
// See: asimov/changes/port-vscode-async-data-tree/specs/vscode-list-widget-vendor/spec.md#requirement-license-attribution

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, "..", "src", "vendor", "vscode");

const SKIP_BASENAMES = new Set(["nls.ts"]);
const SKIP_SUFFIXES = ["-stub.d.ts"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && /\.(ts|d\.ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let stat;
try {
  stat = statSync(VENDOR_DIR);
} catch (err) {
  console.error(`[vendor-headers] FAIL: ${VENDOR_DIR} not found. (${err.message})`);
  process.exit(1);
}
if (!stat.isDirectory()) {
  console.error(`[vendor-headers] FAIL: ${VENDOR_DIR} is not a directory.`);
  process.exit(1);
}

const files = walk(VENDOR_DIR);
const missing = [];
let checked = 0;

for (const f of files) {
  const base = path.basename(f);
  if (SKIP_BASENAMES.has(base)) {
    continue;
  }
  if (SKIP_SUFFIXES.some((s) => base.endsWith(s))) {
    continue;
  }
  const head = readFileSync(f, "utf8").split("\n", 6).join("\n");
  if (!head.includes("Microsoft Corporation")) {
    missing.push(path.relative(VENDOR_DIR, f));
  }
  checked++;
}

if (missing.length > 0) {
  console.error(`[vendor-headers] FAIL: ${missing.length} vendored files missing Microsoft Corporation header:`);
  for (const m of missing) {
    console.error(`  ${m}`);
  }
  process.exit(1);
}

console.log(`[vendor-headers] OK: ${checked} files checked`);
process.exit(0);
