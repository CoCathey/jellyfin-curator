import { describe, expect, it } from "vitest";
import { renderEntry } from "../../src/catalog/render.js";
import { SYSTEM_PROMPT, buildCatalogBlock, buildUserMessage } from "../../src/planner/prompt.js";

const SEASON = "Today is Saturday 5 September 2026, autumn in the northern hemisphere: first cool evenings. Coming up: Halloween in 8 weeks.";
const catalogText = "m1|M|Heat (1995)|Crime|8.3|170|WB||w0f0|x\ns1|S|The Wire (2002)|Crime|9.3|-|HBO||w1f1|y";

describe("SYSTEM_PROMPT", () => {
  it("is frozen text that names the contract and carries nothing volatile", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).toContain("itemIds");
    expect(SYSTEM_PROMPT).toContain("rationale");
    expect(SYSTEM_PROMPT).toContain("id|M or S");
    expect(SYSTEM_PROMPT).toContain("Moods");
    expect(SYSTEM_PROMPT).toContain("Seasonal shelves");
  });

  it("makes fit a hard rule: no near-misses, no padding to reach a size", () => {
    const hardRules = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Hard rules"), SYSTEM_PROMPT.indexOf("Catalog line format"));
    expect(hardRules).toContain("genuinely fit");
    expect(hardRules).toContain("Never pad a shelf");
    expect(hardRules).toContain("drop the shelf");
  });

  it("legends the watch-signal column exactly as render.ts writes it", () => {
    const signal = renderEntry(
      { id: "m1", kind: "M", title: "Heat", genres: [], studios: [], tags: [], watchedBy: 2, favoritedBy: 1, overview: "" },
      false,
    ).split("|")[8];
    expect(signal).toBe("w2f1");
    expect(SYSTEM_PROMPT).toContain("wNfM");
    expect(SYSTEM_PROMPT).not.toContain("wN fM");
  });
});

describe("buildCatalogBlock", () => {
  it("heads the catalog with its size and is otherwise the rendered text", () => {
    expect(buildCatalogBlock(catalogText)).toBe(`Catalog (2 items):\n${catalogText}`);
  });

  it("says 0 items for an empty catalog", () => {
    expect(buildCatalogBlock("")).toBe("Catalog (0 items):\n");
  });
});

describe("buildUserMessage", () => {
  it("is the ask alone: the catalog lives in its own cacheable system block", () => {
    const message = buildUserMessage({ catalogText, wanted: 2, minItems: 8, maxItems: 20, avoidThemes: ["Heists that go sideways"], seasonContext: SEASON, seasonalMin: 2 });
    expect(message).toContain("Invent 2 shelves");
    expect(message).toContain("between 8 and 20 members");
    expect(message).toContain("- Heists that go sideways");
    expect(message).not.toContain("Catalog (");
    expect(message).not.toContain("m1|M|Heat");
  });

  it("says None when there is nothing to avoid", () => {
    const message = buildUserMessage({ catalogText: "", wanted: 2, minItems: 8, maxItems: 20, avoidThemes: [], seasonContext: SEASON, seasonalMin: 2 });
    expect(message).toContain("None.");
  });

  it("carries the season and asks for the seasonal minimum", () => {
    const message = buildUserMessage({ catalogText, wanted: 6, minItems: 8, maxItems: 20, avoidThemes: [], seasonContext: SEASON, seasonalMin: 2 });
    expect(message).toContain(`Today's context: ${SEASON}`);
    expect(message).toContain("At least 2 of the 6 shelves must fit this moment");
  });

  it("says nothing about the season when the seasonal minimum is 0", () => {
    const message = buildUserMessage({ catalogText, wanted: 6, minItems: 8, maxItems: 20, avoidThemes: [], seasonContext: SEASON, seasonalMin: 0 });
    expect(message).not.toContain("Today's context");
    expect(message).not.toContain("fit this moment");
  });

  it("names what earlier batches already used, as a steer rather than a ban", () => {
    const message = buildUserMessage({ catalogText, wanted: 6, minItems: 8, maxItems: 20, avoidThemes: [], seasonContext: SEASON, seasonalMin: 0, usedItemIds: ["3", "9"] });
    expect(message).toContain("Already on shelves built earlier in this run: 3, 9.");
    expect(message).toContain("Reuse one only when it truly defines the shelf");
  });

  it("says nothing about used members on the first call of a run", () => {
    const message = buildUserMessage({ catalogText, wanted: 6, minItems: 8, maxItems: 20, avoidThemes: [], seasonContext: SEASON, seasonalMin: 0, usedItemIds: [] });
    expect(message).not.toContain("Already on shelves");
  });

  it("asks for one shelf, not 1 shelves", () => {
    const message = buildUserMessage({ catalogText, wanted: 1, minItems: 8, maxItems: 20, avoidThemes: [], seasonContext: SEASON, seasonalMin: 1 });
    expect(message).toContain("Invent 1 shelf ");
    expect(message).not.toContain("1 shelves");
  });
});
