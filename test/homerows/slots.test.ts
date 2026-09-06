import { describe, expect, it } from "vitest";
import { COLLECTION_SECTIONS_PLUGIN_ID } from "../../src/constants.js";
import { buildSlots, mergeSlots, writeHomeRowSlots } from "../../src/homerows/slots.js";
import { MemoryLogger } from "../../src/log.js";
import type { OwnedShelf } from "../../src/state/types.js";
import { FakeJellyfinClient } from "../fakes/jellyfin.js";

const shelf = (n: number): OwnedShelf => ({
  collectionId: `boxset-${n}`,
  title: `Shelf ${n}`,
  blurb: "",
  itemIds: [],
  createdAt: `2026-09-0${n}T00:00:00.000Z`,
  origin: "planned",
});

describe("buildSlots", () => {
  it("assigns stable ids newest first and caps at slotCount", () => {
    expect(buildSlots([shelf(1), shelf(3), shelf(2)], 2)).toEqual([
      { UniqueId: "curator-shelf-1", DisplayText: "Shelf 3", CollectionName: "Shelf 3", SectionType: "Collection" },
      { UniqueId: "curator-shelf-2", DisplayText: "Shelf 2", CollectionName: "Shelf 2", SectionType: "Collection" },
    ]);
  });

  it("writes fewer slots than slotCount when there are fewer shelves", () => {
    expect(buildSlots([shelf(1)], 6)).toHaveLength(1);
  });
});

describe("mergeSlots", () => {
  it("keeps foreign sections and other keys, replaces every curator slot", () => {
    const existing = {
      Sections: [
        { UniqueId: "trending", DisplayText: "Trending", CollectionName: "Trending", SectionType: "Collection" as const },
        { UniqueId: "curator-shelf-1", DisplayText: "Stale", CollectionName: "Stale", SectionType: "Collection" as const },
      ],
      SomethingElse: true,
    };
    const { config, foreignKept } = mergeSlots(existing, buildSlots([shelf(1)], 6));
    expect(foreignKept).toBe(1);
    expect(config.SomethingElse).toBe(true);
    expect(config.Sections!.map((s) => s.UniqueId)).toEqual(["trending", "curator-shelf-1"]);
    expect(config.Sections![1]!.DisplayText).toBe("Shelf 1");
  });

  it("tolerates a config with no Sections", () => {
    expect(mergeSlots({}, []).config).toEqual({ Sections: [] });
  });
});

describe("writeHomeRowSlots", () => {
  it("skips with a warning when the plugin is not installed", async () => {
    const fake = new FakeJellyfinClient();
    const log = new MemoryLogger();
    expect(await writeHomeRowSlots(fake, [shelf(1)], { slotCount: 6, dryRun: false }, log)).toBeUndefined();
    expect(log.lines[0]).toMatch(/^warn .*not installed/);
    expect(fake.pluginConfigs.size).toBe(0);
  });

  it("writes the merged config and busts the cache", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    const log = new MemoryLogger();
    const result = await writeHomeRowSlots(fake, [shelf(1), shelf(2)], { slotCount: 6, dryRun: false }, log);
    expect(result).toEqual({ written: 2, foreignKept: 0 });
    const written = fake.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID) as { Sections: { UniqueId: string }[] };
    expect(written.Sections.map((s) => s.UniqueId)).toEqual(["curator-shelf-1", "curator-shelf-2"]);
    expect(fake.actions).toEqual(["/HomeScreen/BustCache"]);
  });

  it("warns when the cache bust is refused", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    fake.actionStatus = 401;
    const log = new MemoryLogger();
    await writeHomeRowSlots(fake, [shelf(1)], { slotCount: 6, dryRun: false }, log);
    expect(log.lines.some((l) => l.startsWith("warn") && l.includes("401"))).toBe(true);
  });

  it("dry run reads the config and writes nothing", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [{ UniqueId: "keep" }] });
    const log = new MemoryLogger();
    const result = await writeHomeRowSlots(fake, [shelf(1)], { slotCount: 6, dryRun: true }, log);
    expect(result).toEqual({ written: 1, foreignKept: 1 });
    expect(fake.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID)).toEqual({ Sections: [{ UniqueId: "keep" }] });
    expect(fake.actions).toEqual([]);
  });
});
