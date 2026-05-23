// Minimal stub for the Trusted Types DOM globals referenced by
// `vs/base/browser/browser.ts` and `vs/typings/vscode-globals-ttp.d.ts`.
//
// Upstream installs `@types/trusted-types` (W3C Trusted Types spec). We supply
// only the symbols the vendored closure actually uses (`TrustedTypePolicy`,
// `TrustedTypePolicyOptions`) so we don't pull in another dev-dep.
//
// NOT vendored from upstream — this is our own surface, no Microsoft copyright header.

declare global {
  interface TrustedTypePolicyOptions {
    createHTML?: (input: string, ...args: unknown[]) => string;
    createScript?: (input: string, ...args: unknown[]) => string;
    createScriptURL?: (input: string, ...args: unknown[]) => string;
  }

  interface TrustedTypePolicy {
    readonly name: string;
    createHTML(input: string, ...args: unknown[]): string;
    createScript(input: string, ...args: unknown[]): string;
    createScriptURL(input: string, ...args: unknown[]): string;
  }
}

export {};
