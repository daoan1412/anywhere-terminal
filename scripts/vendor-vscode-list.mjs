#!/usr/bin/env node
// scripts/vendor-vscode-list.mjs
//
// Vendor a transitive closure of upstream VS Code TS files starting at
// `vs/base/browser/ui/list/listWidget.ts` into `src/vendor/vscode/`.
//
// Run with `--dry-run` to print the closure (TS files + CSS side-effect
// imports) without modifying the filesystem. Run without flags to copy
// files and write `MANIFEST.json`.
//
// Refs: asimov/changes/port-vscode-async-data-tree/design.md D1, D9
//       asimov/changes/port-vscode-async-data-tree/tasks.md (task 1_2)
//
// IMPORTANT: copies upstream `.ts` files byte-for-byte. `.js` extensions
// on relative imports are kept as-is; tsc/esbuild (moduleResolution=Bundler)
// map them to `.ts` at build time. Rewriting would diverge from upstream
// and pollute future re-vendoring diffs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UPSTREAM_ROOT = "/Users/huybuidac/Projects/ai-oss/vscode/src/vs";
const UPSTREAM_SHA = "5aefa4caeb76874b77ba5b00075b4f4c37b59cf0";
const UPSTREAM_REPO = "https://github.com/microsoft/vscode";
const VENDOR_ROOT = resolve(REPO_ROOT, "src/vendor/vscode");

// Entry points (relative to UPSTREAM_ROOT, with `.ts` extension).
// Add more here if `pnpm run check-types` reveals missing transitive deps.
const ENTRY_POINTS = ["base/browser/ui/list/listWidget.ts"];

// Files our project owns (NOT vendored — task 1_2 plan step 4):
// `nls.ts` is our own stub; never copy upstream nls.ts.
const PROJECT_OWNED = new Set(["nls.ts"]);

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Regex matches both `import ... from '...'` and `import '...';` and
 * `export ... from '...';`. Quotes single or double.
 */
const IMPORT_RE =
  /^\s*(?:import|export)(?:\s+type)?(?:[^'"`;]*?from\s+)?\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

/** @param {string} p path inside UPSTREAM_ROOT (no leading slash) */
function upstreamPath(p) {
  return join(UPSTREAM_ROOT, p);
}

/** @param {string} p path inside UPSTREAM_ROOT */
function vendorPath(p) {
  return join(VENDOR_ROOT, p);
}

/**
 * Resolve an import specifier from a containing file to a file-path
 * relative to UPSTREAM_ROOT (e.g. "base/browser/dom.ts").
 *
 * @param {string} spec import specifier, e.g. "./foo.js", "vs/base/common/arrays.js"
 * @param {string} fromRel path of containing file relative to UPSTREAM_ROOT
 * @returns {{ rel: string, kind: "ts" | "css" } | null} null = unsupported / external
 */
function resolveImport(spec, fromRel) {
  // CSS side-effect imports.
  if (spec.endsWith(".css")) {
    // Resolve relative to containing file directory.
    if (spec.startsWith(".")) {
      const fromDir = dirname(fromRel);
      const rel = normalize(join(fromDir, spec));
      return { rel, kind: "css" };
    }
    // Absolute vs/... CSS (rare).
    if (spec.startsWith("vs/")) {
      return { rel: spec.slice("vs/".length), kind: "css" };
    }
    return null;
  }

  // Strip optional `.js` extension (TS source uses .js for ESM).
  let body = spec;
  if (body.endsWith(".js")) body = body.slice(0, -3);

  if (body.startsWith(".")) {
    const fromDir = dirname(fromRel);
    const base = normalize(join(fromDir, body));
    return { rel: pickTsOrDts(base), kind: "ts" };
  }
  if (body.startsWith("vs/")) {
    const base = body.slice("vs/".length);
    return { rel: pickTsOrDts(base), kind: "ts" };
  }
  // Bare specifier (e.g. "node:...") — external, don't recurse.
  return null;
}

/**
 * Pick `.ts` if it exists, else fall back to `.d.ts`. Upstream contains a
 * few `.d.ts` declaration files (e.g. `observableInternal/logging/debugger/debuggerApi.d.ts`)
 * imported with `.js` extension under bundler-mode TS.
 *
 * @param {string} baseRel path under UPSTREAM_ROOT without extension
 * @returns {string} resolved relative path with extension
 */
function pickTsOrDts(baseRel) {
  if (existsSync(join(UPSTREAM_ROOT, baseRel + ".ts"))) return baseRel + ".ts";
  if (existsSync(join(UPSTREAM_ROOT, baseRel + ".d.ts"))) return baseRel + ".d.ts";
  // Default to .ts so the caller's "file not found" diagnostic surfaces a
  // clear path; otherwise we'd silently invent a path that doesn't exist.
  return baseRel + ".ts";
}

/** Normalize a relative path so it has no `./` or `../` segments. */
function normalize(p) {
  return p.split("/").reduce((acc, seg) => {
    if (seg === "" || seg === ".") return acc;
    if (seg === "..") {
      acc.pop();
      return acc;
    }
    acc.push(seg);
    return acc;
  }, []).join("/");
}

/** SHA-256 of given bytes/string. */
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Walk the closure starting at ENTRY_POINTS.
 * Returns: { tsFiles: Set<rel>, cssFiles: Set<rel>, cssByFile: Map<rel, rel[]> }
 */
function walk() {
  const tsFiles = new Set();
  const cssFiles = new Set();
  const cssByFile = new Map();
  const queue = [...ENTRY_POINTS];

  while (queue.length > 0) {
    const rel = queue.shift();
    if (tsFiles.has(rel)) continue;
    if (PROJECT_OWNED.has(rel)) continue;

    const abs = upstreamPath(rel);
    if (!existsSync(abs)) {
      throw new Error(`Upstream file not found: ${rel} (resolved to ${abs})`);
    }
    tsFiles.add(rel);

    const src = readFileSync(abs, "utf8");
    const localCss = [];

    // Match imports.
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      const resolved = resolveImport(spec, rel);
      if (!resolved) continue;
      if (PROJECT_OWNED.has(resolved.rel)) continue;
      if (resolved.kind === "ts") {
        if (!tsFiles.has(resolved.rel)) queue.push(resolved.rel);
      } else if (resolved.kind === "css") {
        cssFiles.add(resolved.rel);
        localCss.push(resolved.rel);
      }
    }

    if (localCss.length > 0) cssByFile.set(rel, localCss);
  }

  return { tsFiles, cssFiles, cssByFile };
}

function main() {
  console.log(`[vendor-vscode-list] upstream sha: ${UPSTREAM_SHA}`);
  console.log(`[vendor-vscode-list] entry points: ${ENTRY_POINTS.join(", ")}`);
  console.log(`[vendor-vscode-list] mode: ${DRY_RUN ? "DRY-RUN" : "WRITE"}`);

  const { tsFiles, cssFiles, cssByFile } = walk();

  const sortedTs = [...tsFiles].sort();
  const sortedCss = [...cssFiles].sort();

  console.log(`\n=== TS files (${sortedTs.length}) ===`);
  for (const f of sortedTs) console.log(`  ${f}`);

  console.log(`\n=== CSS side-effect imports (${sortedCss.length}) ===`);
  for (const f of sortedCss) console.log(`  ${f}`);

  console.log(`\n=== Per-file CSS imports ===`);
  for (const [f, css] of [...cssByFile.entries()].sort()) {
    console.log(`  ${f} -> ${css.join(", ")}`);
  }

  if (DRY_RUN) {
    console.log(`\n[vendor-vscode-list] dry-run complete. ${sortedTs.length} TS, ${sortedCss.length} CSS.`);
    process.exit(0);
  }

  // Live copy.
  const manifestFiles = [];
  const generatedAt = new Date().toISOString();

  for (const rel of sortedTs) {
    const srcAbs = upstreamPath(rel);
    const destAbs = vendorPath(rel);
    const bytes = readFileSync(srcAbs);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, bytes);
    manifestFiles.push({
      src: `src/vs/${rel}`,
      dest: `src/vendor/vscode/${rel}`,
      upstreamSha: sha256(bytes),
      copiedAt: generatedAt,
    });
  }

  for (const rel of sortedCss) {
    const srcAbs = upstreamPath(rel);
    if (!existsSync(srcAbs)) {
      console.warn(`[vendor-vscode-list] WARN: CSS not found upstream: ${rel}`);
      continue;
    }
    const destAbs = vendorPath(rel);
    const bytes = readFileSync(srcAbs);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, bytes);
    manifestFiles.push({
      src: `src/vs/${rel}`,
      dest: `src/vendor/vscode/${rel}`,
      upstreamSha: sha256(bytes),
      copiedAt: generatedAt,
    });
  }

  const manifest = {
    upstreamRepo: UPSTREAM_REPO,
    upstreamSha: UPSTREAM_SHA,
    generatedAt,
    entryPoints: ENTRY_POINTS.map((p) => `src/vs/${p}`),
    files: manifestFiles,
    cssImports: sortedCss.map((p) => `src/vendor/vscode/${p}`),
  };

  mkdirSync(VENDOR_ROOT, { recursive: true });
  writeFileSync(
    join(VENDOR_ROOT, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    `\n[vendor-vscode-list] wrote ${manifestFiles.length} files + MANIFEST.json to ${relative(REPO_ROOT, VENDOR_ROOT)}/`,
  );
}

main();
