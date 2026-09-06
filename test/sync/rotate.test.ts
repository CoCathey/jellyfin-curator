import { describe, expect, it } from "vitest";
import type { OwnedShelf, State } from "../../src/state/types.js";
import { rotate } from "../../src/sync/rotate.js";

const shelf = (n: number, origin: OwnedShelf["origin"] = "planned"): OwnedShelf => ({
  collectionId: `boxset-${n}`,
  title: `Shelf ${n}`,
  blurb: "",
  itemIds: [],
  createdAt: `2026-09-0${n}T00:00:00.000Z`,
  origin,
});
const withShelves = (shelves: OwnedShelf[]): State => ({ version: 1, shelves, retired: [] });
const policy = { shelfCount: 6, rotatePerRun: 2, fullRefresh: false };
const ids = (list: OwnedShelf[]): string[] => list.map((s) => s.collectionId);

describe("rotate", () => {
  it.each([
    { name: "first run wants a full set", shelves: [] as OwnedShelf[], p: policy, retire: [] as string[], keep: [] as string[], wanted: 6 },
    {
      name: "steady state retires the two oldest regardless of input order",
      shelves: [shelf(3), shelf(1), shelf(6), shelf(2), shelf(5), shelf(4)],
      p: policy,
      retire: ["boxset-1", "boxset-2"],
      keep: ["boxset-3", "boxset-4", "boxset-5", "boxset-6"],
      wanted: 2,
    },
    {
      name: "orphans go first even when newer",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6, "orphan")],
      p: policy,
      retire: ["boxset-6", "boxset-1"],
      keep: ["boxset-2", "boxset-3", "boxset-4", "boxset-5"],
      wanted: 2,
    },
    {
      name: "full refresh retires everything",
      shelves: [shelf(1), shelf(2), shelf(3)],
      p: { ...policy, fullRefresh: true },
      retire: ["boxset-1", "boxset-2", "boxset-3"],
      keep: [],
      wanted: 6,
    },
    {
      name: "overflow after lowering shelfCount retires the extras",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6), shelf(7), shelf(8)],
      p: { shelfCount: 5, rotatePerRun: 2, fullRefresh: false },
      retire: ["boxset-1", "boxset-2", "boxset-3"],
      keep: ["boxset-4", "boxset-5", "boxset-6", "boxset-7", "boxset-8"],
      wanted: 0,
    },
    {
      name: "rotatePerRun 0 keeps a full set untouched",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6)],
      p: { ...policy, rotatePerRun: 0 },
      retire: [],
      keep: ["boxset-1", "boxset-2", "boxset-3", "boxset-4", "boxset-5", "boxset-6"],
      wanted: 0,
    },
    {
      name: "a short set is topped up without retiring",
      shelves: [shelf(1), shelf(2), shelf(3)],
      p: policy,
      retire: [] as string[],
      keep: ["boxset-1", "boxset-2", "boxset-3"],
      wanted: 3,
    },
    {
      name: "raising shelfCount fills the gap and keeps every shelf",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6)],
      p: { shelfCount: 25, rotatePerRun: 2, fullRefresh: false },
      retire: [] as string[],
      keep: ["boxset-1", "boxset-2", "boxset-3", "boxset-4", "boxset-5", "boxset-6"],
      wanted: 19,
    },
    {
      name: "orphans still go while the set is below shelfCount",
      shelves: [shelf(1, "orphan"), shelf(2), shelf(3)],
      p: policy,
      retire: ["boxset-1"],
      keep: ["boxset-2", "boxset-3"],
      wanted: 4,
    },
    {
      name: "three orphans all go even though rotatePerRun is 2",
      shelves: [shelf(1, "orphan"), shelf(2, "orphan"), shelf(3, "orphan"), shelf(4)],
      p: policy,
      retire: ["boxset-1", "boxset-2", "boxset-3"],
      keep: ["boxset-4"],
      wanted: 5,
    },
  ])("$name", ({ shelves, p, retire, keep, wanted }) => {
    const decision = rotate(withShelves(shelves), p);
    expect(ids(decision.retire)).toEqual(retire);
    expect(ids(decision.keep)).toEqual(keep);
    expect(decision.wanted).toBe(wanted);
  });
});
