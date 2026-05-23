// src/vendor/seti/setiIconResolver.ts — Looks up `(filename)` against the
// vendored `vs-seti-icon-theme.json` and returns the glyph character + color
// the file-tree renderer should stamp.
//
// Lookup order (mirrors VS Code's file icon theme resolution):
//   1. `fileNames` keyed on the lowercased filename (e.g. "package.json").
//   2. `fileExtensions` keyed on progressively-shorter dot-separated suffixes
//      (e.g. for "spec.config.ts": "config.ts" → "ts").
//   3. `languageIds` via `EXT_TO_LANGUAGE` for common extensions that VS Code
//      classifies through language contributions instead of direct
//      file-extension mapping (e.g. `.ts` → `typescript` → `_typescript`,
//      `.json` → `json` → `_json`). Without this bridge those everyday
//      file types fall through to the generic `_default` icon.
//   4. `file` default icon.
//
// The `fontCharacter` field arrives from JSON as a string like `"\E001"` —
// after JSON.parse, that's a 5-char string starting with a literal backslash
// followed by hex digits. We slice the backslash, parse hex, and convert to
// the actual Unicode code point.
//
// Vendored from microsoft/vscode (MIT) at release/1.96. Original icon set:
// jesseweed/seti-ui (MIT, https://github.com/jesseweed/seti-ui).
// See: THIRD_PARTY_NOTICES.md, asimov/changes/port-vscode-async-data-tree/design.md

import setiTheme from "./vs-seti-icon-theme.json";

interface SetiIconDefinition {
  fontCharacter: string;
  fontColor: string;
}

interface SetiTheme {
  iconDefinitions: Record<string, SetiIconDefinition>;
  file: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
}

const THEME = setiTheme as unknown as SetiTheme;

/**
 * Bridges file extensions to the VS Code language identifiers Seti's
 * `languageIds` table keys on. VS Code derives these from `contributes.languages`
 * entries in the relevant language extensions (e.g. `vscode.typescript-language-features`).
 * The seti theme has icons for languages but not always for the raw extension —
 * `.ts` is the canonical example: there's no `"ts"` entry in `fileExtensions`,
 * but `languageIds.typescript` maps to `_typescript`. Without this mapping
 * everyday filetypes fall back to the generic file icon.
 *
 * Only ships the common subset; less common extensions still fall through to
 * the default icon. Add entries as needed.
 */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  dart: "dart",
  php: "php",
  lua: "lua",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  fs: "fsharp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  ps1: "powershell",
  bat: "bat",
  dockerfile: "dockerfile",
};

export interface ResolvedSetiIcon {
  /** The single-glyph string the Seti font renders for this file. */
  char: string;
  /** Tint color for the glyph (e.g. "#519aba" for TypeScript blue). */
  color: string;
}

/** Cached lookups so repeated row recycles don't re-walk the JSON. */
const CACHE = new Map<string, ResolvedSetiIcon>();

export function resolveSetiIcon(name: string): ResolvedSetiIcon {
  const key = name.toLowerCase();
  const cached = CACHE.get(key);
  if (cached) {
    return cached;
  }
  const defId = findDefinitionId(key);
  const def = THEME.iconDefinitions[defId] ?? THEME.iconDefinitions[THEME.file];
  // After JSON parse, fontCharacter is e.g. `\E001` (5 chars: literal `\` +
  // hex). Slice the backslash, parse hex, build a Unicode glyph.
  const codePoint = Number.parseInt(def.fontCharacter.slice(1), 16);
  const resolved: ResolvedSetiIcon = {
    char: String.fromCodePoint(codePoint),
    color: def.fontColor,
  };
  CACHE.set(key, resolved);
  return resolved;
}

function findDefinitionId(lowerName: string): string {
  // Whole-filename match — wins over extension. e.g. "package.json" → "_npm".
  const byName = THEME.fileNames[lowerName];
  if (byName) {
    return byName;
  }
  // Compound-extension walk: for "foo.config.ts" try "config.ts" first,
  // then "ts". This matches how VS Code's icon themes handle composite
  // extensions (e.g. ".d.ts", ".test.ts").
  let dot = lowerName.indexOf(".");
  let finalSuffix = "";
  while (dot !== -1 && dot < lowerName.length - 1) {
    const suffix = lowerName.slice(dot + 1);
    const byExt = THEME.fileExtensions[suffix];
    if (byExt) {
      return byExt;
    }
    finalSuffix = suffix;
    dot = lowerName.indexOf(".", dot + 1);
  }
  // Bridge through `languageIds` for everyday extensions Seti only catalogues
  // by language (e.g. `.ts` → `typescript` → `_typescript`).
  const language = EXT_TO_LANGUAGE[finalSuffix];
  if (language) {
    const byLang = THEME.languageIds[language];
    if (byLang) {
      return byLang;
    }
  }
  return THEME.file;
}
