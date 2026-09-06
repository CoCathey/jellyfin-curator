import { describe, expect, it } from "vitest";
import { aggregateSignals, buildCatalog, cleanOverview } from "../../src/catalog/build.js";
import type { JellyfinItem } from "../../src/jellyfin/types.js";

const MINUTE_TICKS = 600_000_000;

const heat: JellyfinItem = {
  Id: "m1",
  Name: " Heat ",
  Type: "Movie",
  ProductionYear: 1995,
  Genres: ["Crime", " Thriller"],
  CommunityRating: 8.26,
  RunTimeTicks: 170 * MINUTE_TICKS,
  Studios: [{ Name: "Warner Bros." }, { Name: "" }],
  Tags: ["jellyfin-curator", "favourite-director"],
  Overview: "A  group of\nprofessional | thieves.",
};
const wire: JellyfinItem = { Id: "s1", Name: "The Wire", Type: "Series", Genres: null, Overview: null };
const episode: JellyfinItem = { Id: "e1", Name: "Pilot", Type: "Episode" };

/** Jellyfin's BaseItemDto declares Name nullable, and a half-scanned item really
 * can come back without one. */
const nameless: JellyfinItem = { Id: "m2", Name: null, Type: "Movie" };

describe("aggregateSignals", () => {
  it("counts users, not occurrences", () => {
    const signals = aggregateSignals([["m1", "m1"], ["m1", "s1"]], [["m1"]]);
    expect(signals.get("m1")).toEqual({ watchedBy: 2, favoritedBy: 1 });
    expect(signals.get("s1")).toEqual({ watchedBy: 1, favoritedBy: 0 });
    expect(signals.get("zzz")).toBeUndefined();
  });
});

describe("cleanOverview", () => {
  it("collapses whitespace, replaces pipes and truncates", () => {
    expect(cleanOverview("A  group of\nprofessional | thieves.")).toBe("A group of professional / thieves.");
    expect(cleanOverview(null)).toBe("");
    expect(cleanOverview("x".repeat(200), 160)).toHaveLength(160);
  });
});

describe("buildCatalog", () => {
  it("maps fields, converts ticks to minutes, rounds ratings, drops our own tag", () => {
    const [entry] = buildCatalog([heat], new Map([["m1", { watchedBy: 2, favoritedBy: 1 }]]));
    expect(entry).toEqual({
      id: "m1",
      kind: "M",
      title: "Heat",
      year: 1995,
      genres: ["Crime", "Thriller"],
      rating: 8.3,
      runtimeMin: 170,
      studios: ["Warner Bros."],
      tags: ["favourite-director"],
      watchedBy: 2,
      favoritedBy: 1,
      overview: "A group of professional / thieves.",
    });
  });

  it("is order-independent, skips non movie/series types and dedupes", () => {
    const a = buildCatalog([wire, heat, episode, heat], new Map());
    const b = buildCatalog([heat, wire], new Map());
    expect(a).toEqual(b);
    expect(a.map((e) => e.id)).toEqual(["m1", "s1"]);
  });

  it("omits optional fields when Jellyfin has no value", () => {
    const [entry] = buildCatalog([wire], new Map());
    expect(entry).toEqual({ id: "s1", kind: "S", title: "The Wire", genres: [], studios: [], tags: [], watchedBy: 0, favoritedBy: 0, overview: "" });
  });
});

describe("buildCatalog with a nameless item", () => {
  it("renders an empty title instead of throwing", () => {
    const entries = buildCatalog([nameless], new Map());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("");
  });
});
