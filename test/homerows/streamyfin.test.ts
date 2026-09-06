import { describe, expect, it } from "vitest";
import { STREAMYFIN_PLUGIN_ID } from "../../src/constants.js";
import {
  DEFAULT_STREAMYFIN_SECTIONS,
  buildStreamyfinSections,
  mergeStreamyfinSections,
  writeStreamyfinRows,
  type StreamyfinConfig,
  type StreamyfinSection,
} from "../../src/homerows/streamyfin.js";
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

const continueWatching = { title: "Continue Watching", orientation: "horizontal", custom: { endpoint: "/UserItems/Resume" } };
const handMade = { title: "Marvel", orientation: "horizontal", items: { parentId: "boxset-marvel", includeItemTypes: ["Movie"], limit: 20 } };
const withSections = (sections: StreamyfinSection[]): StreamyfinConfig => ({
  Config: { notifications: { SessionStarted: { Enabled: true } }, settings: { home: { locked: true, value: { sections } }, forwardSkipTime: { locked: false, value: 30 } }, other: {} },
});

describe("buildStreamyfinSections", () => {
  it("makes one horizontal collection row per shelf, newest first, capped", () => {
    expect(buildStreamyfinSections([shelf(1), shelf(3), shelf(2)], 2)).toEqual([
      { title: "Shelf 3", orientation: "horizontal", items: { parentId: "boxset-3", includeItemTypes: ["Movie", "Series"], limit: 20 } },
      { title: "Shelf 2", orientation: "horizontal", items: { parentId: "boxset-2", includeItemTypes: ["Movie", "Series"], limit: 20 } },
    ]);
  });
});

describe("mergeStreamyfinSections", () => {
  it("keeps hand-written sections and every other setting, replaces ours by collection id", () => {
    const stale = { title: "Old shelf", orientation: "horizontal", items: { parentId: "boxset-old", includeItemTypes: ["Movie", "Series"], limit: 20 } };
    const existing = withSections([continueWatching, stale, handMade]);
    const { config, foreignKept, seededDefaults } = mergeStreamyfinSections(existing, buildStreamyfinSections([shelf(1)], 6), new Set(["boxset-old", "boxset-1"]));
    const home = config.Config!.settings!.home!;
    expect(home.locked).toBe(true);
    expect(home.value!.sections!.map((s) => s.title)).toEqual(["Continue Watching", "Marvel", "Shelf 1"]);
    expect(foreignKept).toBe(2);
    expect(seededDefaults).toBe(false);
    expect(config.Config!.notifications).toEqual({ SessionStarted: { Enabled: true } });
    expect(config.Config!.settings!.forwardSkipTime).toEqual({ locked: false, value: 30 });
    expect(config.Config!.other).toEqual({});
  });

  it("seeds the plugin's default rows ahead of ours only when there was no home layout at all", () => {
    const empty: StreamyfinConfig = { Config: { notifications: {}, settings: { home: null }, other: {} } };
    const { config, seededDefaults } = mergeStreamyfinSections(empty, buildStreamyfinSections([shelf(1)], 6), new Set());
    const sections = config.Config!.settings!.home!.value!.sections!;
    expect(seededDefaults).toBe(true);
    expect(sections.slice(0, DEFAULT_STREAMYFIN_SECTIONS.length)).toEqual(DEFAULT_STREAMYFIN_SECTIONS);
    expect(sections.at(-1)!.title).toBe("Shelf 1");
    expect(config.Config!.settings!.home!.locked).toBe(false);
  });

  it("does not re-seed defaults when the operator deliberately emptied the layout to only our rows", () => {
    const oursOnly = withSections([{ title: "Shelf 9", orientation: "horizontal", items: { parentId: "boxset-9" } }]);
    const { config, seededDefaults } = mergeStreamyfinSections(oursOnly, buildStreamyfinSections([shelf(1)], 6), new Set(["boxset-9"]));
    expect(seededDefaults).toBe(false);
    expect(config.Config!.settings!.home!.value!.sections!.map((s) => s.title)).toEqual(["Shelf 1"]);
  });

  it("gives every lockable setting an explicit value so the plugin accepts its own config back", () => {
    // Streamyfin 0.66 serialises a null Lockable without its `value` key, then rejects
    // that shape on POST as "missing required properties including: 'value'".
    const existing: StreamyfinConfig = {
      Config: { settings: { home: null, defaultBitrate: { locked: false }, forwardSkipTime: { locked: false, value: 30 } }, other: {} },
    };
    const { config } = mergeStreamyfinSections(existing, buildStreamyfinSections([shelf(1)], 6), new Set());
    const settings = config.Config!.settings as Record<string, { locked?: boolean; value?: unknown }>;
    expect(settings.defaultBitrate).toEqual({ locked: false, value: null });
    expect(settings.forwardSkipTime).toEqual({ locked: false, value: 30 });
    expect(config.Config!.settings!.home!.value!.sections!.at(-1)!.title).toBe("Shelf 1");
  });

  it("tolerates a config with no Config or settings object", () => {
    const { config } = mergeStreamyfinSections({}, buildStreamyfinSections([shelf(1)], 6), new Set());
    expect(config.Config!.settings!.home!.value!.sections!.at(-1)!.title).toBe("Shelf 1");
  });
});

describe("writeStreamyfinRows", () => {
  it("skips with a warning when the plugin is not installed", async () => {
    const fake = new FakeJellyfinClient();
    const log = new MemoryLogger();
    expect(await writeStreamyfinRows(fake, [shelf(1)], { slotCount: 6, dryRun: false, previousParentIds: [] }, log)).toBeUndefined();
    expect(log.lines[0]).toMatch(/^warn .*Streamyfin plugin not installed/);
    expect(fake.pluginConfigs.size).toBe(0);
  });

  it("writes the merged config and reports the collection ids it now owns", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(STREAMYFIN_PLUGIN_ID, withSections([continueWatching, handMade]));
    const log = new MemoryLogger();
    const result = await writeStreamyfinRows(fake, [shelf(1), shelf(2)], { slotCount: 6, dryRun: false, previousParentIds: [] }, log);
    expect(result).toEqual({ written: 2, foreignKept: 2, parentIds: ["boxset-2", "boxset-1"] });
    const written = fake.pluginConfigs.get(STREAMYFIN_PLUGIN_ID) as StreamyfinConfig;
    expect(written.Config!.settings!.home!.value!.sections!.map((s) => s.title)).toEqual(["Continue Watching", "Marvel", "Shelf 2", "Shelf 1"]);
    expect(fake.actions).toEqual([]);
  });

  it("dry run reads the config and writes nothing", async () => {
    const fake = new FakeJellyfinClient();
    const before = withSections([continueWatching]);
    fake.pluginConfigs.set(STREAMYFIN_PLUGIN_ID, before);
    const log = new MemoryLogger();
    const result = await writeStreamyfinRows(fake, [shelf(1)], { slotCount: 6, dryRun: true, previousParentIds: [] }, log);
    expect(result).toEqual({ written: 1, foreignKept: 1, parentIds: ["boxset-1"] });
    expect(fake.pluginConfigs.get(STREAMYFIN_PLUGIN_ID)).toEqual(before);
    expect(log.lines.some((l) => l.includes("[dry-run]"))).toBe(true);
  });
});
