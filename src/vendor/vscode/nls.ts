// AnyWhere Terminal: localized() stub for vendored VS Code list widget.
//
// The vendored TS files under src/vendor/vscode/ are upstream VS Code source
// (Microsoft copyright; see THIRD_PARTY_NOTICES). This file is NOT vendored
// — it is our own implementation that shims the upstream `vs/nls` module so
// `import { localize, localize2 } from '../../nls.js'` (or equivalent) in
// the vendored sources resolves to a no-op string formatter at type-check
// and runtime. The task 1_3 header audit explicitly skips this file because
// it deliberately omits the Microsoft copyright header.
//
// Refs: asimov/changes/port-vscode-async-data-tree/tasks.md task 1_2 plan step 4
//       asimov/changes/port-vscode-async-data-tree/design.md D1
export function localize(_key: string, defaultValue: string, ...args: unknown[]): string {
  return defaultValue.replace(/\{(\d+)\}/g, (_, i) => String(args[+i] ?? ""));
}

export function localize2(
  _key: string,
  defaultValue: string,
  ...args: unknown[]
): { value: string; original: string } {
  const value = localize(_key, defaultValue, ...args);
  return { value, original: defaultValue };
}

// Surface area referenced by the vendored `base/common/platform.ts`. The
// webview never reads a VS Code NLS config, so the language is always
// undefined and the type just needs to be structurally compatible with
// platform.ts's `JSON.parse(rawNlsConfig) as nls.INLSConfiguration` usage.
export interface INLSConfiguration {
  readonly userLocale: string;
  readonly osLocale: string;
  readonly resolvedLanguage: string;
  readonly languagePack?: { readonly translationsConfigFile: string };
}

export function getNLSLanguage(): string | undefined {
  return undefined;
}

