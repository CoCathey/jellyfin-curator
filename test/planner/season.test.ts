import { describe, expect, it } from "vitest";
import { describeSeason, easterSunday, thanksgiving } from "../../src/planner/season.js";

const at = (iso: string): Date => new Date(iso);

describe("describeSeason", () => {
  it.each([
    { iso: "2026-09-05T09:00:00Z", has: ["Saturday 5 September 2026", "autumn", "first cool evenings", "Halloween in 8 weeks"], not: ["Thanksgiving"] },
    { iso: "2026-12-20T09:00:00Z", has: ["winter", "Christmas in 5 days", "New Year's Eve in 2 weeks"], not: ["Halloween"] },
    { iso: "2026-03-30T09:00:00Z", has: ["spring", "Easter in 6 days"], not: [] },
    { iso: "2026-07-01T09:00:00Z", has: ["summer", "Independence Day in 3 days"], not: [] },
    { iso: "2026-10-31T09:00:00Z", has: ["Halloween today", "Thanksgiving in 4 weeks"], not: [] },
    { iso: "2026-02-13T09:00:00Z", has: ["Valentine's Day tomorrow"], not: [] },
    { iso: "2026-04-20T09:00:00Z", has: ["Nothing on the calendar"], not: ["Coming up:"] },
  ])("$iso", ({ iso, has, not }) => {
    const text = describeSeason(at(iso));
    for (const s of has) expect(text).toContain(s);
    for (const s of not) expect(text).not.toContain(s);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text.endsWith(".")).toBe(true);
  });

  it("is deterministic for the same instant", () => {
    expect(describeSeason(at("2026-09-05T09:00:00Z"))).toBe(describeSeason(at("2026-09-05T09:00:00Z")));
  });
});

describe("holiday arithmetic", () => {
  it("computes Easter and Thanksgiving for known years", () => {
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe("2026-04-05");
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe("2027-03-28");
    expect(thanksgiving(2026).toISOString().slice(0, 10)).toBe("2026-11-26");
    expect(thanksgiving(2027).toISOString().slice(0, 10)).toBe("2027-11-25");
  });
});
