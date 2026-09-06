import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { COLLECTION_SECTIONS_PLUGIN_ID, CURATOR_TAG, STREAMYFIN_PLUGIN_ID } from "../src/constants.js";
import { JellyfinHttpError } from "../src/jellyfin/client.js";
import { MemoryLogger } from "../src/log.js";
import { estimateCostUsd, runCuration, type RunDeps } from "../src/run.js";
import { FakeJellyfinClient } from "./fakes/jellyfin.js";
import { chunkShelves, FakeShelfPlanner } from "./fakes/planner.js";
import { MemoryStateStore } from "./fakes/state.js";

const env = { JELLYFIN_URL: "http://fake", JELLYFIN_API_KEY: "k", CURATOR_STATE_PATH: "/unused" };

interface World {
  client: FakeJellyfinClient;
  planner: FakeShelfPlanner;
  store: MemoryStateStore;
  log: MemoryLogger;
  now: () => Date;
  advanceDay: () => void;
  deps: RunDeps;
}

function world(itemCount = 60, extraEnv: Record<string, string> = {}): World {
  const client = new FakeJellyfinClient();
  for (let i = 1; i <= itemCount; i++) {
    client.addItem({ Id: `m${i}`, Name: `Movie ${i}`, Type: i % 5 === 0 ? "Series" : "Movie", Genres: ["Drama"], Overview: `Plot ${i}`, ProductionYear: i % 2 === 0 ? 2026 : 1999 });
  }
  client.users = [{ Id: "u1", Name: "Admin" }, { Id: "u2", Name: "Guest" }];
  client.played.set("u1", new Set(["m1", "m2"]));
  client.favorites.set("u2", new Set(["m1"]));
  const planner = new FakeShelfPlanner((request) => chunkShelves(request, 8));
  const store = new MemoryStateStore();
  const log = new MemoryLogger();
  let clock = new Date("2026-09-04T04:00:00.000Z");
  const now = (): Date => clock;
  const advanceDay = (): void => {
    clock = new Date(clock.getTime() + 86_400_000);
  };
  const config = loadConfig({ ...env, ...extraEnv });
  return { client, planner, store, log, now, advanceDay, deps: { config, client, planner, store, log, now } };
}

describe("runCuration", () => {
  it("first run plans a full set, creates tagged collections and records state", async () => {
    const w = world();
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(6);
    expect(summary.retired).toEqual([]);
    expect(w.planner.requests[0]).toMatchObject({ wanted: 6, minItems: 8, maxItems: 20, avoidThemes: [], seasonalMin: 2, cacheCatalog: false });
    expect(w.planner.requests[0]!.seasonContext).toContain("4 September 2026");
    expect(w.planner.requests[0]!.seasonContext).toContain("autumn");
    expect(w.planner.requests[0]!.catalogText.split("\n")).toHaveLength(60);
    // Sorted by Jellyfin id ("m1" < "m10"), numbered from 1; a 1999 title loses its overview, a 2026 one keeps it.
    expect(w.planner.requests[0]!.catalogText).toMatch(/^1\|M\|Movie 1 \(1999\)\|Drama\|-\|-\|\|\|w1f1$/m);
    expect(w.planner.requests[0]!.catalogText).toContain("2|S|Movie 10 (2026)|Drama|-|-|||w0f0|Plot 10");
    // The planner answers in catalog numbers; collections and state carry Jellyfin ids.
    expect(w.client.collections.get("boxset-1")!.itemIds.every((id) => id.startsWith("m"))).toBe(true);
    expect(w.store.state.shelves[0]!.itemIds.every((id) => id.startsWith("m"))).toBe(true);
    expect(w.client.collections.size).toBe(6);
    for (const id of w.client.collections.keys()) expect((await w.client.getItem(id))!.Tags).toEqual([CURATOR_TAG]);
    expect(w.store.state.shelves).toHaveLength(6);
    expect(w.store.state.lastRun).toEqual({ at: w.now().toISOString(), inputTokens: 1000, outputTokens: 100 });
    expect(summary.estimatedCostUsd).toBeCloseTo(0.0075, 4);
    expect(w.log.lines.some((l) => l.includes('planned "Shelf 1"') && l.includes("Movie 1"))).toBe(true);
    expect(w.log.lines.some((l) => l.includes("at claude-opus-5 list price"))).toBe(true);
  });

  it("the next run retires the two oldest, avoids every live and retired theme, and tops up", async () => {
    const w = world();
    await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    w.advanceDay();
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.retired).toEqual(["Shelf 1", "Shelf 2"]);
    expect(summary.created).toEqual(["Shelf 7", "Shelf 8"]);
    expect(summary.kept).toEqual(["Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6"]);
    const second = w.planner.requests[1]!;
    expect(second.wanted).toBe(2);
    expect(second.avoidThemes).toEqual(["Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6", "Shelf 1", "Shelf 2"]);
    expect(w.client.deleted).toEqual(["boxset-1", "boxset-2"]);
    expect(w.store.state.shelves.map((s) => s.title)).toEqual(["Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6", "Shelf 7", "Shelf 8"]);
    expect(w.store.state.retired.map((r) => r.title)).toEqual(["Shelf 1", "Shelf 2"]);
    // Spec §4.10 wants a line per shelf; applyPlan logs retired and created, so
    // runCuration owes the kept ones.
    expect(w.log.lines.filter((l) => l.startsWith('info kept "'))).toEqual([
      'info kept "Shelf 3"',
      'info kept "Shelf 4"',
      'info kept "Shelf 5"',
      'info kept "Shelf 6"',
    ]);
  });

  it("asks a second time when the first answer is short, then ships what survived", async () => {
    const w = world();
    let calls = 0;
    w.planner = new FakeShelfPlanner((request) => {
      calls += 1;
      return calls === 1 ? chunkShelves(request, 8).slice(0, 4) : chunkShelves(request, 8, "Extra", 5).slice(0, 1);
    });
    w.deps.planner = w.planner;
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(w.planner.requests.map((r) => r.wanted)).toEqual([6, 2]);
    expect(w.planner.requests.map((r) => r.seasonalMin)).toEqual([2, 2]);
    expect(w.planner.requests[1]!.avoidThemes).toEqual(["Shelf 1", "Shelf 2", "Shelf 3", "Shelf 4"]);
    expect(summary.created).toEqual(["Shelf 1", "Shelf 2", "Shelf 3", "Shelf 4", "Extra 1"]);
    expect(summary.usage).toEqual({ inputTokens: 2000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 200 });
    expect(w.log.lines.some((l) => l.includes("still short"))).toBe(true);
  });

  it("splits a big ask into batches, spends the seasonal quota once and caches the catalog across them", async () => {
    const w = world(240, { CURATOR_SHELF_COUNT: "25", CURATOR_MAX_SHELVES_PER_CALL: "10" });
    let made = 0;
    w.planner = new FakeShelfPlanner((request) => {
      const shelves = chunkShelves(request, 8, "Shelf", made);
      made += shelves.length;
      return shelves;
    });
    w.deps.planner = w.planner;
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    // One answer of 25 shelves overruns the model's output budget; three do not.
    expect(w.planner.requests.map((r) => r.wanted)).toEqual([10, 10, 5]);
    expect(w.planner.requests.map((r) => r.seasonalMin)).toEqual([2, 0, 0]);
    expect(w.planner.requests.every((r) => r.cacheCatalog === true)).toBe(true);
    expect(w.planner.requests[1]!.avoidThemes).toHaveLength(10);
    expect(w.planner.requests[0]!.usedItemIds).toEqual([]);
    // Ten shelves of eight, named by the catalog numbers the model reads.
    expect(w.planner.requests[1]!.usedItemIds).toHaveLength(80);
    expect(w.planner.requests[1]!.usedItemIds!.every((id) => /^\d+$/.test(id))).toBe(true);
    expect(summary.created).toHaveLength(25);
    expect(w.store.state.shelves).toHaveLength(25);
    expect(w.log.lines.some((l) => l.includes("planning batch 2/3 (10 shelves)"))).toBe(true);
  });

  it("lets a later batch reuse members the earlier one took", async () => {
    const w = world(240, { CURATOR_SHELF_COUNT: "12", CURATOR_MAX_SHELVES_PER_CALL: "6" });
    // Both answers pick exactly the same items; only the titles differ. Pooling
    // the run's answers through one validation would drop the whole second batch.
    w.planner = new FakeShelfPlanner((request) => chunkShelves(request, 8, request.avoidThemes.length === 0 ? "First" : "Second"));
    w.deps.planner = w.planner;
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(12);
    expect(w.store.state.shelves[6]!.itemIds).toEqual(w.store.state.shelves[0]!.itemIds);
  });

  it("covers the shelves it created, and only those", async () => {
    const w = world();
    // Only m2 carries artwork, so every shelf that contains it gets a cover.
    w.client.items.set("m2", { ...w.client.items.get("m2")!, BackdropImageTags: ["tag"] });
    w.client.images.set("m2/Backdrop/0", await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#204020" } }).jpeg().toBuffer());
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.covers?.written).toBe(1);
    const covered = [...w.client.uploadedPrimary.keys()];
    expect(covered).toHaveLength(1);
    expect((await sharp(w.client.uploadedPrimary.get(covered[0]!)!.image).metadata()).height).toBe(1500);

    // A second run creates two shelves and leaves the first run's covers alone.
    w.advanceDay();
    const before = w.client.uploadedPrimary.get(covered[0]!)!.image;
    await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    expect(w.client.uploadedPrimary.get(covered[0]!)!.image).toBe(before);
  });

  it("skips a real run that comes too soon after the last one, unless forced or dry", async () => {
    const w = world(60, { CURATOR_MIN_DAYS_BETWEEN_RUNS: "4" });
    await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    const runsBefore = w.planner.requests.length;

    w.advanceDay();
    const tooSoon = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    expect(tooSoon).toMatchObject({ outcome: "too-soon", minDays: 4 });
    if (tooSoon.outcome === "too-soon") expect(tooSoon.daysSinceLastRun).toBeCloseTo(1, 5);
    expect(w.planner.requests).toHaveLength(runsBefore);
    expect(w.store.saves).toBe(7);

    const dry = await runCuration(w.deps, { dryRun: true, fullRefresh: false });
    expect(dry.outcome).toBe("completed");
    const forced = await runCuration(w.deps, { dryRun: false, fullRefresh: false, force: true });
    expect(forced.outcome).toBe("completed");

    w.advanceDay(); w.advanceDay(); w.advanceDay(); w.advanceDay();
    const dueAgain = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    expect(dueAgain.outcome).toBe("completed");
  });

  it("stops before planning when the library is too small", async () => {
    const w = world(20);
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    expect(summary).toEqual({ outcome: "library-too-small", catalogSize: 20, required: 48 });
    expect(w.planner.requests).toEqual([]);
    expect(w.store.saves).toBe(0);
  });

  it("dry run plans but writes nothing anywhere", async () => {
    const w = world(60, { CURATOR_HOME_ROWS: "true" });
    w.client.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    const summary = await runCuration(w.deps, { dryRun: true, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(6);
    expect(summary.homeRows).toEqual({ written: 6, foreignKept: 0 });
    expect(w.client.collections.size).toBe(0);
    expect(w.store.saves).toBe(0);
    expect(w.client.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID)).toEqual({ Sections: [] });
    expect(w.client.actions).toEqual([]);
    expect(w.log.lines.filter((l) => l.includes("[dry-run]"))).toHaveLength(8);
    expect(w.log.lines.some((l) => l.includes("[dry-run] would build 6 covers"))).toBe(true);
    expect(w.client.uploadedPrimary.size).toBe(0);
  });

  it("writes home-row slots for the live shelves when enabled", async () => {
    const w = world(60, { CURATOR_HOME_ROWS: "true" });
    w.client.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, {
      Sections: [{ UniqueId: "trending", DisplayText: "Trending", CollectionName: "Trending", SectionType: "Collection" }],
    });
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.homeRows).toEqual({ written: 6, foreignKept: 1 });
    const config = w.client.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID) as { Sections: { UniqueId: string }[] };
    expect(config.Sections.map((s) => s.UniqueId)).toEqual([
      "trending", "curator-shelf-1", "curator-shelf-2", "curator-shelf-3", "curator-shelf-4", "curator-shelf-5", "curator-shelf-6",
    ]);
    expect(w.client.actions).toEqual(["/HomeScreen/BustCache"]);
  });

  it("a home-row failure is a warning, not a failed run", async () => {
    const w = world(60, { CURATOR_HOME_ROWS: "true" });
    w.client.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    w.client.setPluginConfiguration = async () => {
      throw new JellyfinHttpError(500, "/Plugins/x/Configuration", "boom");
    };
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(6);
    expect(summary.homeRows).toBeUndefined();
    expect(w.log.lines.some((l) => l.startsWith("warn") && l.includes("home rows not written"))).toBe(true);
  });

  it("keeps six Streamyfin rows in sync across a rotation and records the ids it owns", async () => {
    const w = world(60, { CURATOR_STREAMYFIN_ROWS: "true" });
    w.client.pluginConfigs.set(STREAMYFIN_PLUGIN_ID, { Config: { notifications: {}, settings: { home: null }, other: {} } });
    const first = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (first.outcome !== "completed") throw new Error(first.outcome);
    expect(first.streamyfinRows).toMatchObject({ written: 6, foreignKept: 0 });
    const sectionsOf = () => (w.client.pluginConfigs.get(STREAMYFIN_PLUGIN_ID) as { Config: { settings: { home: { value: { sections: { title: string; items?: { parentId?: string } }[] } } } } }).Config.settings.home.value.sections;
    expect(sectionsOf()).toHaveLength(3 + 6);
    expect(w.store.state.streamyfin?.parentIds).toHaveLength(6);

    w.advanceDay();
    const second = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (second.outcome !== "completed") throw new Error(second.outcome);
    const sections = sectionsOf();
    expect(sections).toHaveLength(3 + 6);
    expect(sections.slice(0, 3).map((s) => s.title)).toEqual(["Continue Watching", "Next Up", "Recently Added"]);
    expect(sections.slice(3).map((s) => s.title)).toEqual(["Shelf 7", "Shelf 8", "Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6"]);
    expect(sections.some((s) => s.items?.parentId === "boxset-1")).toBe(false);
    expect(w.store.state.streamyfin?.parentIds).toEqual(sections.slice(3).map((s) => s.items?.parentId));
  });

  it("adopts a tagged stranger as an orphan and retires it first", async () => {
    const w = world();
    const strangerId = await w.client.createCollection("Hand-made but tagged", ["m1"]);
    await w.client.updateItem({ ...(await w.client.getItem(strangerId))!, Tags: [CURATOR_TAG] });
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.retired).toEqual(["Hand-made but tagged"]);
    expect(w.client.deleted).toEqual([strangerId]);
    expect(w.planner.requests[0]!.wanted).toBe(6);
    expect(w.planner.requests[0]!.avoidThemes).toEqual(["Hand-made but tagged"]);
  });
  it("keeps a hand-made collection out of reach: its name is avoided, and it is never tagged or deleted", async () => {
    const w = world();
    const handMadeId = await w.client.createCollection("Shelf 1", ["m1", "m2"]);
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(w.planner.requests[0]!.avoidThemes).toContain("Shelf 1");
    expect(summary.created).not.toContain("Shelf 1");
    expect((await w.client.getItem(handMadeId))!.Tags).toEqual([]);
    expect(w.client.deleted).toEqual([]);
    expect(w.store.state.shelves.map((s) => s.collectionId)).not.toContain(handMadeId);
  });
  it("does not retire for nothing when the planner comes back empty, but still drops the orphan", async () => {
    const w = world();
    await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    const orphanId = await w.client.createCollection("Tagged stranger", ["m1"]);
    await w.client.updateItem({ ...(await w.client.getItem(orphanId))!, Tags: [CURATOR_TAG] });
    w.advanceDay();
    w.planner = new FakeShelfPlanner(() => []);
    w.deps.planner = w.planner;

    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toEqual([]);
    expect(summary.retired).toEqual(["Tagged stranger"]);
    expect(summary.kept).toEqual(["Shelf 2", "Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6", "Shelf 1"]);
    expect(w.client.deleted).toEqual([orphanId]);
    expect(w.store.state.shelves.map((s) => s.title).sort()).toEqual(["Shelf 1", "Shelf 2", "Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6"]);
    expect(w.log.lines.some((l) => l.startsWith("warn") && l.includes("Shelf 1") && l.includes("no usable shelves"))).toBe(true);
  });
});


describe("estimateCostUsd", () => {
  it("prices uncached input, cache writes, cache reads and output separately", () => {
    // 10k uncached at $5/M, 60k written at 1.25x, 30k read at 0.1x, 4k out at $25/M.
    expect(
      estimateCostUsd({ inputTokens: 100_000, cacheCreationInputTokens: 60_000, cacheReadInputTokens: 30_000, outputTokens: 4_000 }),
    ).toBeCloseTo(0.54, 6);
  });

  it("charges everything at the input rate when nothing was cached", () => {
    expect(estimateCostUsd({ inputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 100 })).toBeCloseTo(0.0075, 6);
  });

  it("prices by model, and falls back to Opus 5 rates for a model it does not know", () => {
    const usage = { inputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 100 };
    expect(estimateCostUsd(usage, "claude-sonnet-5")).toBeCloseTo(0.003, 6);
    expect(estimateCostUsd(usage, "claude-haiku-4-5")).toBeCloseTo(0.0015, 6);
    expect(estimateCostUsd(usage, "claude-something-new")).toBeCloseTo(0.0075, 6);
  });
});
