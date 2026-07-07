---
labels: [cache, concurrency, single-flight, state-management, async-coordination]
source: write-vault-rename-to-store
summary: Cached store with single-flight reads: force-refresh must await and clear ALL in-flight reads before starting a new one, ensuring reads begin strictly after writes for data consistency.
---
# Force-refresh must drain prior in-flight reads to serialize updates
**Date**: 2026-07-07

## TL;DR
- Single-flight cache pattern: concurrent normal calls share one in-flight read
- Force-refresh (after a write) cannot join that read — it may have started **before** the write
- Drain loop: `while (this.inflightRefresh) await` to clear all in-flight, then start a new one
- Guarantees: reads start strictly after writes; concurrent force-refreshes serialize

## Context
When a cached store is updated (e.g., native SQLite write), the cache is stale. A force-refresh bypasses the normal single-flight coalescing and re-reads fresh data. But if an in-flight normal read started before the write, joining it would return pre-write data.

The vault refresh() pattern implements single-flight coalescing: concurrent normal callers share one `this.inflightRefresh` promise. The force-refresh branch must not join this — instead it must:
1. Await and clear the in-flight read
2. Start a new read guaranteed to occur after the write

Without the drain, concurrent force-refresh callers could both check `this.inflightRefresh`, find it null, and start two separate reads that race and persist out of order (losing the ordering guarantee).

## Evidence
### Anchors
- `src/vault/VaultService.ts` → `refresh(opts?: { force?: boolean })` lines 317-354
  - Line 318: normal callers short-circuit to in-flight if present
  - Lines 327-329: **force branch drains** with `while (this.inflightRefresh) await this.inflightRefresh.catch(()=>{})`
  - Line 330: new read assigned to `this.inflightRefresh` strictly after drain completes
  - Comment lines 322-326: design rationale (D4)
- Review finding W1: "Two concurrent `refresh({force:true})` calls interleave — single-flight broken" → fixed by drain loop
- Design D4: "Fresh refresh strictly AFTER the write (single-flight bypass)" with sequence diagram

## When to apply
- Implementing a single-flight cache pattern with normal + force-refresh paths
- Symptom: concurrent force-refreshes persist updates out of order, or a force-refresh returns pre-write data
- Test: spawn concurrent force-refresh calls and verify maxActive===1 (serialized, not racey)
- Prevention gate: check `if (opts?.force) { while (this.inflightRefresh) await ... }`
