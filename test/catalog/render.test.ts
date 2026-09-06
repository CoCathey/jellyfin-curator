import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../src/catalog/build.js";
import { renderCatalog, renderEntry } from "../../src/catalog/render.js";

const heat: CatalogEntry = {
  id: "m1",
  kind: "M",
  title: "Heat",
  year: 1995,
  genres: ["Crime", "Thriller"],
  rating: 8.3,
  runtimeMin: 170,
  studios: ["Warner Bros."],
  tags: [],
  watchedBy: 2,
  favoritedBy: 1,
  overview: "A group of professional thieves.",
};
const wire: CatalogEntry = { id: "s1", kind: "S", title: "The Wire", genres: [], studios: [], tags: ["hbo"], watchedBy: 0, favoritedBy: 0, overview: "" };

describe("renderEntry", () => {
  it("renders the fixed pipe-separated column order", () => {
    expect(renderEntry(heat, true)).toBe("m1|M|Heat (1995)|Crime,Thriller|8.3|170|Warner Bros.||w2f1|A group of professional thieves.");
    expect(renderEntry(wire, true)).toBe("s1|S|The Wire (-)||-|-||hbo|w0f0|");
  });

  it("omits the overview column when asked", () => {
    expect(renderEntry(heat, false)).toBe("m1|M|Heat (1995)|Crime,Thriller|8.3|170|Warner Bros.||w2f1");
  });

  it("never lets a pipe or newline inside a field break the format", () => {
    const tricky: CatalogEntry = { ...heat, title: "Face|Off\nRemix", genres: ["Ac|tion"] };
    expect(renderEntry(tricky, false).split("|")).toHaveLength(9);
    expect(renderEntry(tricky, false)).toContain("Face Off Remix (1995)");
  });
});

describe("renderCatalog", () => {
  const opts = { overviews: "recent" as const, recentYears: 2, year: 2026 };

  it("numbers entries 1..N, keeps the first studio and five clean keywords, and maps numbers back", () => {
    const busy: CatalogEntry = {
      ...heat,
      id: "jf-heat",
      studios: ["Warner Bros.", "Regency"],
      tags: ["heist", "duringcreditsstinger", "los angeles", "bank", "cop", "robber", "sixth"],
    };
    const rendered = renderCatalog([busy, { ...wire, id: "jf-wire" }], { ...opts, overviews: "all" });
    const [first, second] = rendered.text.split("\n");
    expect(first).toBe("1|M|Heat (1995)|Crime,Thriller|8.3|170|Warner Bros.|heist,los angeles,bank,cop,robber|w2f1|A group of professional thieves.");
    expect(second!.startsWith("2|S|The Wire (-)|")).toBe(true);
    expect(rendered.resolveId("1")).toBe("jf-heat");
    expect(rendered.resolveId("2")).toBe("jf-wire");
    expect(rendered.resolveId(" 2 ")).toBe("jf-wire");
    expect(rendered.resolveId("3")).toBeUndefined();
    expect(rendered.resolveId("jf-heat")).toBeUndefined();
    expect(rendered.shortIdFor("jf-wire")).toBe("2");
    expect(rendered.shortIdFor("jf-missing")).toBeUndefined();
  });

  it("keeps overviews only for recent titles under the recent policy", () => {
    const old: CatalogEntry = { ...heat, id: "a", year: 2023 };
    const fresh: CatalogEntry = { ...heat, id: "b", year: 2024 };
    const undated: CatalogEntry = { ...heat, id: "c", year: undefined };
    const lines = renderCatalog([old, fresh, undated], opts).text.split("\n");
    expect(lines[0]!.split("|")).toHaveLength(9);
    expect(lines[1]!.split("|")).toHaveLength(10);
    expect(lines[2]!.split("|")).toHaveLength(9);
  });

  it("all and none apply to every entry, and an empty catalog renders empty", () => {
    expect(renderCatalog([heat, wire], { ...opts, overviews: "all" }).text.split("\n").every((l) => l.split("|").length === 10)).toBe(true);
    expect(renderCatalog([heat, wire], { ...opts, overviews: "none" }).text.split("\n").every((l) => l.split("|").length === 9)).toBe(true);
    expect(renderCatalog([], opts).text).toBe("");
  });
});
