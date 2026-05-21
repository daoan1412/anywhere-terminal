// src/providers/resolveCwdRelative.ts — Port of VS Code's `updateLinkWithRelativeCwd`.
//
// Given a PTY cwd and a clicked relative link, returns an ordered list of
// candidate absolute paths to try. The first candidate is `cwd/<full link>`;
// subsequent candidates progressively strip the link's leading segments while
// they match the cwd's trailing segments.
//
// Worked example: cwd `/x/y/a` + link `a/file.md` → ['/x/y/a/a/file.md',
// '/x/y/a/file.md'] — the second matches when the user clicked a path that
// duplicates the cwd's last segment.
//
// Reference: VS Code source `terminalLinkHelpers.ts:221-251`
// (microsoft/vscode, terminal contrib).
//
// Intentional divergence from upstream: `filter(Boolean)` after split. Callers
// can pass cwd values from sources (lsof, OSC 7) that occasionally include a
// trailing slash or repeated separators; the empty segment otherwise corrupts
// the reverse-walk comparison.

import * as path from "node:path";

export function resolveCwdRelative(cwd: string, link: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!cwd) {
    return [];
  }
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(cwd)) {
    return [];
  }
  const sep = platform === "win32" ? "\\" : "/";
  const splitRe = platform === "win32" ? /[\\/]+/ : /\/+/;
  const cwdParts = cwd.split(splitRe).filter(Boolean).reverse();
  const linkParts = link.split(splitRe).filter(Boolean);
  // Single-segment link (no separator) → degenerate to plain join.
  if (linkParts.length <= 1) {
    return [p.resolve(p.join(cwd, link))];
  }
  const eq =
    platform === "win32"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  const out: string[] = [];
  let common = 0;
  for (let i = 0; i < cwdParts.length; i++) {
    out.push(p.resolve(cwd + sep + linkParts.slice(common).join(sep)));
    if (cwdParts[i] !== undefined && linkParts[i] !== undefined && eq(cwdParts[i], linkParts[i])) {
      common++;
    } else {
      break;
    }
  }
  return out;
}
