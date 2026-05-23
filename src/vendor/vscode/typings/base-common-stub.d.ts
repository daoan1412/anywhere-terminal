// Replaces upstream `typings/base-common.d.ts` for our integration.
//
// Upstream declares a phantom-typed `interface TimeoutHandle { readonly _: never }`
// + `type Timeout = TimeoutHandle` + custom setTimeout/setInterval overloads
// returning `Timeout`. The phantom type prevents direct `number` assignment.
//
// In our tsconfig (which auto-includes `@types/node`), the upstream declaration
// collides with both DOM's `setTimeout` (returns `number`) and Node's (returns
// `NodeJS.Timeout`). We side-step the collision by aliasing `Timeout` to the
// union of plausible runtime returns — the vendored closure only uses it as
// the storage type for setTimeout/setInterval handles (`let t: Timeout = setTimeout(...);
// clearTimeout(t);`), and both branches of the union are accepted by `clearTimeout`.
//
// NOT vendored from upstream — this is our own surface, no Microsoft copyright header.

declare global {
  type Timeout = number | ReturnType<typeof setTimeout>;

  interface IdleDeadline {
    readonly didTimeout: boolean;
    timeRemaining(): number;
  }

  function requestIdleCallback(callback: (args: IdleDeadline) => void, options?: { timeout: number }): number;
  function cancelIdleCallback(handle: number): void;
}

export {};
