import { describe, expect, it } from "vitest";
import { formatRestoreDivider } from "./restoreDivider";

const REF = new Date(2026, 0, 1, 9, 5, 0).getTime();
const REF_HH = String(new Date(REF).getHours()).padStart(2, "0");
const REF_MM = String(new Date(REF).getMinutes()).padStart(2, "0");

describe("formatRestoreDivider", () => {
  it("returns the exact divider for a live (non-exited) snapshot", () => {
    const out = formatRestoreDivider({ snapshotAt: REF, shellExited: false, exitCode: null });
    expect(out).toBe(`\r\x1b[2K\x1b[0m\x1b[2m─── restored — last update at ${REF_HH}:${REF_MM} ───\x1b[0m\r\n`);
  });

  it("includes the exit indicator when shellExited === true", () => {
    const out = formatRestoreDivider({ snapshotAt: REF, shellExited: true, exitCode: 137 });
    expect(out).toBe(
      `\r\x1b[2K\x1b[0m\x1b[2m─── restored — last update at ${REF_HH}:${REF_MM} (shell exited, code: 137) ───\x1b[0m\r\n`,
    );
  });

  it("renders code: ? when exitCode is null", () => {
    const out = formatRestoreDivider({ snapshotAt: REF, shellExited: true, exitCode: null });
    expect(out).toContain("(shell exited, code: ?)");
  });

  it("zero-pads hours and minutes", () => {
    const t = new Date(2026, 0, 1, 3, 7, 0).getTime();
    const out = formatRestoreDivider({ snapshotAt: t, shellExited: false, exitCode: null });
    expect(out).toContain("at 03:07");
  });

  it("begins with row-overlay + SGR reset (overwrites inherited prompt row)", () => {
    const out = formatRestoreDivider({ snapshotAt: REF, shellExited: false, exitCode: null });
    expect(out.startsWith("\r\x1b[2K\x1b[0m")).toBe(true);
  });
});
