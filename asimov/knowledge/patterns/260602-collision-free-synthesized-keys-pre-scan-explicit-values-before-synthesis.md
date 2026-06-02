---
labels: [data-structure, synthesis, defensive, collision-avoidance]
source: 260602-0408-render-vault-workflow-board
summary: When synthesizing a fallback index/key for missing-or-invalid entries, pre-scan all explicit values to find the lowest unused slot so a synthesized key can never collide with a real one and create duplicate grouped items.
---
# Collision-free synthesized keys — pre-scan explicit values before synthesis
**Date**: 2026-06-02

## TL;DR
- When synthesizing fallback values (indices, keys) for incomplete data, **pre-scan all explicit values first**
- Synthesize the **lowest unused value** (not `length + 1`), so duplicates never occur
- Collision: a synthesized index matching an explicit one groups the same agent set under two phase headers

## Context
In the workflow board reader, each workflow phase has an explicit `index` field. When a `workflow_phase` entry lacks a valid `index`, one is synthesized.

**Naive approach (collision-prone):**
```typescript
const index = manifestInt(obj.index) ?? (phases.length + 1);  // ❌ can collide
```

If the manifest is malformed (out-of-order entries, hand-edited), a phase at position 2 lacking an index gets `synthesized = phases.length + 1`. If a later explicit phase has that same index, they collide:

```
phases = [
  { index: 1, title: "Setup" },           // explicit
  { index: 2, title: "Check" },           // missing, gets synthesized = 1 + 1 = 2
  { index: 2, title: "Verify" }           // explicit, same index → collision!
]
```

Both phases get the same index. When grouping agents by `phaseIndex`, the `byPhase.get(2)` returns the **same array twice** — agents render as duplicate leaves under both headers. Selection state (`phaseEls.set(key, el)`) uses last-wins, orphaning the first phase's open state.

**Safe approach (collision-free):**
```typescript
const usedIndexes = new Set<number>();
for (const entry of progress) {
  const obj = asObj(entry);
  if (obj?.type === "workflow_phase") {
    const i = manifestInt(obj.index);
    if (i !== undefined) {
      usedIndexes.add(i);  // Pre-scan explicit indices
    }
  }
}

let nextSynthIndex = 1;
const synthIndex = (): number => {
  while (usedIndexes.has(nextSynthIndex)) {
    nextSynthIndex++;
  }
  usedIndexes.add(nextSynthIndex);
  return nextSynthIndex;
};
```

Now `synthesized` always picks an unused slot.

## Evidence
### Anchors
- `src/vault/readers/claudeChildren.ts` lines 154–174 — collision-free synthesis pattern, with comment: "Pre-scan explicit phase indices so a synthesized index (for an entry missing one) can't collide with a real one — a collision would group the same agents under two phases (W2)."
- Code review round 3, finding W2 — "Synthesized phase index can collide with an explicit one → duplicate agent leaves" — fixed via this pre-scan pattern
- Test fixture would be: manifest with `workflowProgress` containing phases with indices [1, missing, 2] → should synthesize to [1, missing→something NOT 1 or 2, 2]

## When to apply
- When filling missing or invalid values from a default/synthesized pool (indices, IDs, keys)
- When the synthesized value drives equality-based grouping or deduplication
- When the data source is untrusted/user-provided/hand-editable (JSON manifests, config files, local user data)
- Prevention: add a comment in the code explaining why explicit-scan-first is necessary, and include a test for the malformed case

## Prevention gate
- **Before synthesis:** scan all explicit values into a Set
- **Synthesize cautiously:** pick the lowest unused value, don't assume `length + 1` is free
- **Test the edge case:** malformed input (explicit duplicate indices, out-of-order, gaps) should still produce correct grouping

