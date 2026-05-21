# Manual Smoke Test — fix-open-file-path-resolution

> **Task 5_1.** Run on the Extension Development Host after the implementation
> lands. Document the result by replacing the `_PENDING_` markers below with
> `PASS` or `FAIL` plus the captured DevTools trace.

## Setup

```bash
pnpm install
pnpm run watch        # in one terminal — keep running
```

Then in VS Code, press `F5` to launch the **Extension Development Host**.

In the EDH window, open a terminal (`Ctrl+`) so `AnyWhere Terminal` is the
active provider (or open one via the `AnyWhere Terminal` view).

Open DevTools in the EDH window: `Help → Toggle Developer Tools → Console`.

## Scenario 1 — Bug #1: cwd-suffix duplication

Reproduces the originally reported bug. PTY cwd ends with the same segment
the user clicks at the start of the relative path.

```bash
mkdir -p /tmp/asimov-smoke/a
touch /tmp/asimov-smoke/a/file.md
cd /tmp/asimov-smoke/a
echo "open a/file.md"
```

Click the underlined `a/file.md` in the terminal output.

**Expected**: the file `/tmp/asimov-smoke/a/file.md` opens in an editor tab.
No "File not found" toast. No modal dialog.

**Result**: _PENDING_

**Trace** (paste from DevTools console — search for `[AnyWhere Terminal] openFileLink`):

```
<paste here>
```

## Scenario 2 — Absolute path opens cleanly (latent fix from D8)

Verifies that an absolute path produces exactly ONE stat candidate, not the
bogus `cwd + absolutePath` concatenation the old code generated.

```bash
touch /tmp/asimov-smoke/realfile.md
cd /tmp/asimov-smoke/a    # cwd intentionally different from the absolute path's dir
echo "open /tmp/asimov-smoke/realfile.md"
```

Click the underlined `/tmp/asimov-smoke/realfile.md` in the terminal output.

**Expected**: the file opens. The modal "Open file outside workspace?" MAY
appear if you launched EDH without a workspace folder containing `/tmp/...`;
choose `Open` to confirm. The DevTools trace should show **a single
`stat(/tmp/asimov-smoke/realfile.md) → file ✓`** entry, not the previous
bogus `stat(<cwd>/tmp/asimov-smoke/realfile.md) → FileNotFound` second entry.

**Result**: _PENDING_

**Trace** (paste from DevTools console):

```
<paste here>
```

## Scenario 3 (optional) — Tilde and file:// URI

```bash
touch ~/asimov-smoke.md
echo "see ~/asimov-smoke.md"
echo "see file://${HOME}/asimov-smoke.md"
```

Click each underlined path in turn.

**Expected**: both open `~/asimov-smoke.md`.

**Result**: _PENDING_

## Cleanup

```bash
rm -rf /tmp/asimov-smoke ~/asimov-smoke.md
```
