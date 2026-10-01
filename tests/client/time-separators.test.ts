import { describe, expect, it } from "vitest";
import { formatSeparator, separatorsBefore } from "../../app/lib/time-separators";

const msg = (id: string, time: string | null) => ({ id, time });

describe("transcript time separators", () => {
  it("marks the first timed message and each new sitting (an hour's pause or a new day)", () => {
    const marks = separatorsBefore(
      [
        msg("a", null), // historical, no time: never synthesized
        msg("b", "2026-09-22T10:00:00.000Z"),
        msg("c", "2026-09-22T10:00:05.000Z"),
        msg("d", "2026-09-22T10:59:00.000Z"),
        msg("e", "2026-09-22T12:00:00.000Z"),
        msg("f", "2026-09-22T23:59:00.000Z"),
        msg("g", "2026-09-23T00:01:00.000Z"),
        msg("h", "not a date"),
      ],
      "UTC",
    );
    expect([...marks.keys()]).toEqual(["b", "e", "f", "g"]);
    expect(marks.get("b")).toBe("2026-09-22T10:00:00.000Z");
  });

  it("has nothing to show without stored times", () => {
    expect(separatorsBefore([msg("a", null), msg("b", null)]).size).toBe(0);
  });

  it("reads like 'Tue, Sep 22 at 11:56 PM', with the year only when it differs", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    expect(formatSeparator("2026-09-22T23:56:00Z", now, "en-US", "UTC")).toBe(
      "Tue, Sep 22 at 11:56 PM",
    );
    expect(formatSeparator("2025-09-22T23:56:00Z", now, "en-US", "UTC")).toBe(
      "Mon, Sep 22, 2025 at 11:56 PM",
    );
  });
});
