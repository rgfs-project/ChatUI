import { describe, expect, it } from "vitest";
import { formatSeparator, separatorIndexes } from "../../app/lib/time";

const fmt = { locale: "en-US", timeZone: "UTC", now: "2026-10-29T18:00:00.000Z" };

describe("time separators", () => {
  it("labels today, yesterday and older dates in the given zone", () => {
    expect(formatSeparator("2026-10-29T15:06:00.000Z", fmt)).toBe("Today 3:06 PM");
    expect(formatSeparator("2026-10-28T09:12:00.000Z", fmt)).toBe("Yesterday 9:12 AM");
    expect(formatSeparator("2026-10-20T09:12:00.000Z", fmt)).toMatch(/^Tue, Oct 20/);
    expect(formatSeparator("2025-01-02T09:12:00.000Z", fmt)).toMatch(/2025/);
  });

  it("uses the browser's time zone (server-rendered from the hint cookie)", () => {
    expect(
      formatSeparator("2026-10-29T23:30:00.000Z", {
        ...fmt,
        timeZone: "Asia/Tokyo",
        now: "2026-10-30T00:00:00.000Z",
      }),
    ).toBe("Today 8:30 AM");
  });

  it("starts a group at the first timed message and after an hour's gap", () => {
    const times = [
      null,
      "2026-10-29T10:00:00.000Z",
      "2026-10-29T10:30:00.000Z",
      "2026-10-29T12:00:00.000Z",
    ];
    expect([...separatorIndexes(times)]).toEqual([1, 3]);
  });
});
