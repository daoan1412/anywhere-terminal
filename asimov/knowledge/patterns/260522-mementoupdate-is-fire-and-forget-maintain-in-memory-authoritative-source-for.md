---
labels: [vscode-api, state-management, persistence, race-condition]
source: add-tab-rename
summary: vscode.Memento.update() is async; sequential fire-and-forget calls with load-modify-save patterns race. Solution: hydrate once into in-memory Map, mutate sync, enqueue snapshot write.
---
# Memento.update() is fire-and-forget — maintain in-memory authoritative source for load-modify-save
**Date**: 2026-05-22

## TL;DR
- `vscode.Memento.update(key, value): Thenable<void>` is async fire-and-forget
- Naive load-modify-save on every rename: `const map = get() → modify → update()` races when two updates are enqueued before the first completes
- Second update loads stale state, overwrites first update's changes
- Fix: maintain an in-memory `Map<string, string>` as the single source of truth; hydrate once on construction; on each rename, mutate the Map sync, then enqueue a snapshot write

## Context
The add-tab-rename feature persists custom tab names to `workspaceState` keyed by terminal number. Initial implementation loaded, modified, and wrote the full record on every rename. If a user quickly renamed two different tabs, the second rename's write would overwrite the first's.

## Evidence
### Anchors
- `src/session/SessionManager.ts` → `persistedCustomNames: Map<string, string>` (instance field, hydrated once in constructor)
- `renameSession()` (line ~480+) — mutates the in-memory Map, then calls `savePersistedNamesSnapshot()`
- `loadPersistedNamesFromStorage()` (line ~700+) — called once during construction
- Review finding: `.reviews/round-1.md` B1 — detailed walkthrough of the race condition

### Why the race happens
```typescript
// WRONG: load-modify-save per-call
renameSession(sessionId, input) {
  const map = this.workspaceState.get(KEY) ?? {};  // load
  map[sessionId] = input;                          // modify
  this.workspaceState.update(KEY, map);            // fire-and-forget async
}

// If two calls happen quickly:
// Call 1: load {} → modify map[1]=A → enqueue update({1: A})
// Call 2: load {} (update 1 not done!) → modify map[2]=B → enqueue update({2: B})
// Update 1 applies: {1: A}
// Update 2 applies: {2: B}  ← overwrites {1: A}
```

### The pattern
```typescript
// RIGHT: in-memory authoritative source
class SessionManager {
  private persistedCustomNames: Map<string, string>;

  constructor(workspaceState: CustomNameStorage) {
    this.persistedCustomNames = this.loadPersistedNamesFromStorage();
  }

  renameSession(sessionId, input) {
    const key = String(session.number);
    if (input === null) {
      this.persistedCustomNames.delete(key);
    } else {
      this.persistedCustomNames.set(key, input);
    }
    // Enqueue snapshot write; fire-and-forget. The in-memory state
    // is already updated, so the next rename mutates the correct Map.
    this.savePersistedNamesSnapshot();
  }

  private savePersistedNamesSnapshot() {
    const snapshot = Object.fromEntries(this.persistedCustomNames);
    this.workspaceState.update(STORAGE_KEY, snapshot).catch(err => console.error(err));
  }
}
```

## When to apply
- Any state persisted via Memento that can be mutated from multiple call sites
- Workspacestate, globalState, or any fire-and-forget async storage
- Anywhere a user action can trigger multiple sequential updates (multi-select, batch operations)

## Prevention gate
- Establish ONE in-memory copy of truth before wiring handlers
- Mutate the in-memory state synchronously
- Enqueue the snapshot write WITHOUT awaiting — persistence failure is acceptable degradation
- Test: verify that two rapid updates of different keys both survive (regression test needed)

## Risk: persistence failure
If the snapshot write fails (disk full, read-only FS), the in-memory state persists for the session, but the next VS Code restart won't have the update. Log the error; this is acceptable for user-supplied metadata like custom names.

