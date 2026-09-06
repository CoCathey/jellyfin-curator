import { describe, expect, it } from "vitest";
import { CURATOR_TAG } from "../../src/constants.js";
import { JellyfinHttpError } from "../../src/jellyfin/client.js";
import { MemoryLogger } from "../../src/log.js";
import { emptyState, type OwnedShelf, type State } from "../../src/state/types.js";
import { applyPlan } from "../../src/sync/apply.js";
import { FakeJellyfinClient } from "../fakes/jellyfin.js";
import { MemoryStateStore } from "../fakes/state.js";

const now = (): Date => new Date("2026-09-04T04:00:00.000Z");
const shelfIn = (title: string, itemIds: string[]) => ({ title, blurb: `About ${title}`, itemIds, rationale: "r" });

async function ownedCollection(fake: FakeJellyfinClient, title: string, createdAt: string, tagged = true): Promise<OwnedShelf> {
  const id = await fake.createCollection(title, ["m1"]);
  if (tagged) await fake.updateItem({ ...(await fake.getItem(id))!, Tags: [CURATOR_TAG] });
  return { collectionId: id, title, blurb: "", itemIds: ["m1"], createdAt, origin: "planned" };
}

describe("applyPlan", () => {
  it("creates, tags and describes each new collection, saving state after every write", async () => {
    const fake = new FakeJellyfinClient();
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const { state, report } = await applyPlan(
      fake,
      store,
      emptyState(),
      { retire: [], create: [shelfIn("One", ["m1", "m2"]), shelfIn("Two", ["m3"])], existingCollectionIds: new Set<string>(), dryRun: false, now },
      log,
    );
    expect(report.created.map((c) => c.title)).toEqual(["One", "Two"]);
    expect(state.shelves.map((s) => s.collectionId)).toEqual(["boxset-1", "boxset-2"]);
    expect(state.shelves[0]).toMatchObject({ title: "One", blurb: "About One", itemIds: ["m1", "m2"], createdAt: now().toISOString(), origin: "planned" });
    const dto = (await fake.getItem("boxset-1"))!;
    expect(dto.Tags).toEqual([CURATOR_TAG]);
    expect(dto.Overview).toBe("About One");
    expect(fake.collections.get("boxset-1")).toEqual({ name: "One", itemIds: ["m1", "m2"] });
    expect(store.saves).toBe(2);
    expect(store.state).toEqual(state);
  });

  it("retires only guarded collections, drops vanished ones, records history", async () => {
    const fake = new FakeJellyfinClient();
    const tagged = await ownedCollection(fake, "Tagged", "2026-09-01T00:00:00.000Z");
    const untagged = await ownedCollection(fake, "Untagged", "2026-09-02T00:00:00.000Z", false);
    fake.addItem({ Id: "movie-x", Name: "Not a collection", Type: "Movie", Tags: [CURATOR_TAG] });
    const notBoxSet: OwnedShelf = { collectionId: "movie-x", title: "Movie", blurb: "", itemIds: [], createdAt: "2026-09-03T00:00:00.000Z", origin: "planned" };
    const gone: OwnedShelf = { collectionId: "boxset-404", title: "Gone", blurb: "", itemIds: [], createdAt: "2026-09-03T00:00:00.000Z", origin: "planned" };
    const state: State = { version: 1, shelves: [tagged, untagged, notBoxSet, gone], retired: [] };
    const store = new MemoryStateStore(state);
    const log = new MemoryLogger();

    const result = await applyPlan(fake, store, state, { retire: [tagged, untagged, notBoxSet, gone], create: [], existingCollectionIds: new Set<string>(), dryRun: false, now }, log);

    expect(fake.deleted).toEqual([tagged.collectionId]);
    expect(result.report.retired).toEqual(["Tagged"]);
    expect(result.report.skipped.map((s) => s.title)).toEqual(["Untagged", "Movie"]);
    expect(result.state.shelves.map((s) => s.title)).toEqual(["Untagged", "Movie"]);
    expect(result.state.retired).toEqual([
      { title: "Tagged", retiredAt: now().toISOString() },
      { title: "Gone", retiredAt: now().toISOString() },
    ]);
    expect(log.lines.filter((l) => l.startsWith("error"))).toHaveLength(2);
    expect(log.lines.some((l) => l.includes("Gone") && l.includes("no longer exists"))).toBe(true);
    expect(store.saves).toBe(2);
  });

  it("caps retired history at 30 titles, newest last", async () => {
    const fake = new FakeJellyfinClient();
    const owned = await ownedCollection(fake, "Newest", "2026-09-03T00:00:00.000Z");
    const retired = Array.from({ length: 30 }, (_, i) => ({ title: `Old ${i}`, retiredAt: "2026-08-01T00:00:00.000Z" }));
    const state: State = { version: 1, shelves: [owned], retired };
    const result = await applyPlan(fake, new MemoryStateStore(state), state, { retire: [owned], create: [], existingCollectionIds: new Set<string>(), dryRun: false, now }, new MemoryLogger());
    expect(result.state.retired).toHaveLength(30);
    expect(result.state.retired[0]!.title).toBe("Old 1");
    expect(result.state.retired[29]!.title).toBe("Newest");
  });

  it("dry run reads but never writes", async () => {
    const fake = new FakeJellyfinClient();
    const owned = await ownedCollection(fake, "Live", "2026-09-01T00:00:00.000Z");
    const state: State = { version: 1, shelves: [owned], retired: [] };
    const store = new MemoryStateStore(state);
    const log = new MemoryLogger();
    const result = await applyPlan(fake, store, state, { retire: [owned], create: [shelfIn("New", ["m1"])], existingCollectionIds: new Set<string>(), dryRun: true, now }, log);
    expect(fake.deleted).toEqual([]);
    expect(fake.collections.size).toBe(1);
    expect(store.saves).toBe(0);
    expect(result.state).toEqual(state);
    expect(result.report.retired).toEqual(["Live"]);
    expect(result.report.created.map((c) => c.title)).toEqual(["New"]);
    expect(log.lines.filter((l) => l.includes("[dry-run]"))).toHaveLength(2);
  });

  it("a failed create is skipped and the rest still land", async () => {
    const fake = new FakeJellyfinClient();
    fake.failCreateFor.add("Broken");
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const { state, report } = await applyPlan(fake, store, emptyState(), { retire: [], create: [shelfIn("Broken", ["m1"]), shelfIn("Fine", ["m2"])], existingCollectionIds: new Set<string>(), dryRun: false, now }, log);
    expect(report.skipped).toEqual([{ title: "Broken", reason: expect.stringContaining("Broken") }]);
    expect(state.shelves.map((s) => s.title)).toEqual(["Fine"]);
    expect(store.saves).toBe(1);
  });

  it("refuses to tag or record a create that resolved to a collection that already existed", async () => {
    const fake = new FakeJellyfinClient();
    const strangerId = await fake.createCollection("Same", ["m9"]);
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const { state, report } = await applyPlan(
      fake,
      store,
      emptyState(),
      { retire: [], create: [shelfIn("Same", ["m1", "m2"])], existingCollectionIds: new Set([strangerId]), dryRun: false, now },
      log,
    );
    expect(report.created).toEqual([]);
    expect(report.skipped).toEqual([{ title: "Same", reason: "name collides with an existing collection" }]);
    const stranger = (await fake.getItem(strangerId))!;
    expect(stranger.Tags).toEqual([]);
    expect(stranger.Overview).toBeUndefined();
    expect(state.shelves).toEqual([]);
    expect(store.saves).toBe(0);
    expect(log.lines.some((l) => l.startsWith("error") && l.includes(strangerId) && l.includes("Same"))).toBe(true);
  });
  it("names the untagged collection left behind when a create fails after the POST", async () => {
    const fake = new FakeJellyfinClient();
    fake.updateItem = async () => {
      throw new JellyfinHttpError(500, "/Items/boxset-1", "nope");
    };
    const log = new MemoryLogger();
    const { state, report } = await applyPlan(
      fake,
      new MemoryStateStore(),
      emptyState(),
      { retire: [], create: [shelfIn("Half made", ["m1"])], existingCollectionIds: new Set<string>(), dryRun: false, now },
      log,
    );
    expect(report.created).toEqual([]);
    expect(report.skipped.map((sk) => sk.title)).toEqual(["Half made"]);
    expect(state.shelves).toEqual([]);
    expect(log.lines.some((l) => l.startsWith("error") && l.includes("boxset-1") && l.includes("untagged"))).toBe(true);
  });
});
