import { describe, expect, it } from "vitest";
import type { Shelf } from "../../src/planner/schema.js";
import { validatePlan } from "../../src/planner/validate.js";

const ids = new Set(["a", "b", "c", "d", "e", "f"]);
const shelf = (title: string, itemIds: string[]): Shelf => ({ title, blurb: "b", itemIds, rationale: "r" });
const opts = { minItems: 2, maxItems: 3, avoidTitles: ["Old Shelf"] };

describe("validatePlan", () => {
  it("drops unknown ids and counts them", () => {
    const result = validatePlan([shelf("One", ["a", "zzz", "b"])], ids, opts);
    expect(result.shelves[0]!.itemIds).toEqual(["a", "b"]);
    expect(result.unknownIds).toBe(1);
  });

  it("dedupes within and across shelves; the earlier shelf wins", () => {
    const result = validatePlan([shelf("One", ["a", "a", "b"]), shelf("Two", ["b", "c", "d"])], ids, opts);
    expect(result.shelves.map((s) => s.itemIds)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("drops shelves below the minimum after cleaning and caps at the maximum", () => {
    const result = validatePlan([shelf("Tiny", ["a", "zzz"]), shelf("Big", ["b", "c", "d", "e", "f"])], ids, opts);
    expect(result.shelves.map((s) => s.title)).toEqual(["Big"]);
    expect(result.shelves[0]!.itemIds).toEqual(["b", "c", "d"]);
    expect(result.dropped).toEqual([{ title: "Tiny", reason: "too few valid members (1)" }]);
  });

  it("drops empty, avoided or duplicate titles, case-insensitively", () => {
    const result = validatePlan(
      [shelf("  ", ["a", "b"]), shelf("old shelf", ["a", "b"]), shelf("Fresh", ["a", "b"]), shelf("FRESH", ["c", "d"])],
      ids,
      opts,
    );
    expect(result.shelves.map((s) => s.title)).toEqual(["Fresh"]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["empty title", "duplicate or avoided title", "duplicate or avoided title"]);
  });

  it("hard-caps a title at 60 and a blurb at 200 characters, after trimming", () => {
    const result = validatePlan([{ title: `  ${"T".repeat(80)}  `, blurb: `  ${"B".repeat(300)}  `, itemIds: ["a", "b"], rationale: "r" }], ids, opts);
    expect(result.shelves[0]!.title).toBe("T".repeat(60));
    expect(result.shelves[0]!.blurb).toBe("B".repeat(200));
  });

  it("trims titles and blurbs", () => {
    const result = validatePlan([{ title: " Neat ", blurb: " nice ", itemIds: ["a", "b"], rationale: "r" }], ids, opts);
    expect(result.shelves[0]).toMatchObject({ title: "Neat", blurb: "nice" });
  });
});
