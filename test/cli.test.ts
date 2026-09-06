import { describe, expect, it } from "vitest";
import { EXIT, main, parseCli } from "../src/cli.js";
import { STREAMYFIN_PLUGIN_ID } from "../src/constants.js";
import { CURATOR_TAG } from "../src/constants.js";
import { JellyfinHttpError } from "../src/jellyfin/client.js";
import { MemoryLogger } from "../src/log.js";
import { PlannerError } from "../src/planner/planner.js";
import { FakeJellyfinClient } from "./fakes/jellyfin.js";
import { chunkShelves, FakeShelfPlanner } from "./fakes/planner.js";
import { MemoryStateStore } from "./fakes/state.js";

const env = { JELLYFIN_URL: "http://fake", JELLYFIN_API_KEY: "k" };

function seededClient(count = 60): FakeJellyfinClient {
  const client = new FakeJellyfinClient();
  for (let i = 1; i <= count; i++) client.addItem({ Id: `m${i}`, Name: `Movie ${i}`, Type: "Movie" });
  return client;
}

describe("parseCli", () => {
  it("parses commands and flags", () => {
    expect(parseCli([])).toEqual({ command: "help" });
    expect(parseCli(["--help"])).toEqual({ command: "help" });
    expect(parseCli(["run"])).toEqual({ command: "run", dryRun: false, fullRefresh: false, force: false });
    expect(parseCli(["run", "--dry-run", "--full-refresh"])).toEqual({ command: "run", dryRun: true, fullRefresh: true, force: false });
    expect(parseCli(["run", "--force"])).toEqual({ command: "run", dryRun: false, fullRefresh: false, force: true });
    expect(parseCli(["status"])).toEqual({ command: "status" });
    expect(parseCli(["rows"])).toEqual({ command: "rows", dryRun: false });
    expect(parseCli(["rows", "--dry-run"])).toEqual({ command: "rows", dryRun: true });
    expect(parseCli(["retire-all", "--yes"])).toEqual({ command: "retire-all", yes: true });
    expect(() => parseCli(["bogus"])).toThrow(/unknown command/);
  });
});

describe("main", () => {
  it("prints usage for help and fails on a bad command", async () => {
    const log = new MemoryLogger();
    expect(await main(["help"], env, log)).toBe(EXIT.ok);
    expect(log.lines[0]).toContain("Usage:");
    expect(await main(["bogus"], env, log)).toBe(EXIT.failure);
  });

  it("fails with the config problems listed", async () => {
    const log = new MemoryLogger();
    expect(await main(["status"], {}, log)).toBe(EXIT.failure);
    expect(log.lines[0]).toMatch(/JELLYFIN_URL/);
  });

  it("runs end to end with fakes and reports exit 0", async () => {
    const client = seededClient();
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const code = await main(["run"], env, log, {
      client,
      store,
      planner: new FakeShelfPlanner((request) => chunkShelves(request, 8)),
      now: () => new Date("2026-09-04T04:00:00.000Z"),
    });
    expect(code).toBe(EXIT.ok);
    expect(store.state.shelves).toHaveLength(6);
    expect(log.lines.some((l) => l.includes("summary: kept 0, retired 0, created 6, skipped 0"))).toBe(true);
  });

  it("maps a planner failure to exit 3 and retires nothing (spec §8)", async () => {
    const client = seededClient();
    const collectionId = await client.createCollection("Live shelf", ["m1"]);
    await client.updateItem({ ...(await client.getItem(collectionId))!, Tags: [CURATOR_TAG] });
    const store = new MemoryStateStore({
      version: 1,
      shelves: [{ collectionId, title: "Live shelf", blurb: "", itemIds: ["m1"], createdAt: "2026-09-01T00:00:00.000Z", origin: "planned" }],
      retired: [],
    });
    const planner = new FakeShelfPlanner(() => {
      throw new PlannerError("boom");
    });
    const log = new MemoryLogger();
    const code = await main(["run"], env, log, { client, store, planner });
    expect(code).toBe(EXIT.planner);
    expect(client.deleted).toEqual([]);
    expect(store.state.shelves.map((s) => s.collectionId)).toEqual([collectionId]);
    expect(log.lines.some((l) => l.startsWith("error") && l.includes("planner: boom"))).toBe(true);
  });

  it("maps a Jellyfin refusal to exit 2, naming the URL and the auth header but never the key", async () => {
    const client = seededClient();
    client.getSystemInfo = async () => {
      throw new JellyfinHttpError(401, "/System/Info", "no");
    };
    const log = new MemoryLogger();
    const secretEnv = { ...env, JELLYFIN_API_KEY: "super-secret-key" };
    const code = await main(["run"], secretEnv, log, { client, store: new MemoryStateStore(), planner: new FakeShelfPlanner(() => []) });
    expect(code).toBe(EXIT.jellyfin);
    const line = log.lines.find((l) => l.includes("401"))!;
    expect(line).toContain("http://fake");
    expect(line).toContain('Authorization: MediaBrowser Token="<redacted>"');
    expect(log.lines.some((l) => l.includes("super-secret-key"))).toBe(false);
  });

  it("maps a too-small library to exit 4", async () => {
    const code = await main(["run"], env, new MemoryLogger(), { client: seededClient(10), store: new MemoryStateStore(), planner: new FakeShelfPlanner(() => []) });
    expect(code).toBe(EXIT.librarySmall);
  });

  it("status lists owned shelves; retire-all needs --yes", async () => {
    const client = seededClient();
    const store = new MemoryStateStore();
    await main(["run"], env, new MemoryLogger(), { client, store, planner: new FakeShelfPlanner((request) => chunkShelves(request, 8)) });

    const statusLog = new MemoryLogger();
    expect(await main(["status"], env, statusLog, { client, store })).toBe(EXIT.ok);
    expect(statusLog.lines.filter((l) => l.includes("boxset-"))).toHaveLength(6);

    // Tagged in Jellyfin but unknown to state: the tag is the recovery path when
    // the state file is lost (spec §6), so retire-all must find it too.
    const strangerId = await client.createCollection("Lost to state", ["m1"]);
    await client.updateItem({ ...(await client.getItem(strangerId))!, Tags: [CURATOR_TAG] });

    const refusedLog = new MemoryLogger();
    expect(await main(["retire-all"], env, refusedLog, { client, store })).toBe(EXIT.failure);
    expect(refusedLog.lines.some((l) => l.includes("would delete 7 collections"))).toBe(true);
    expect(client.deleted).toEqual([]);

    expect(await main(["retire-all", "--yes"], env, new MemoryLogger(), { client, store })).toBe(EXIT.ok);
    expect(client.deleted).toHaveLength(7);
    expect(client.deleted).toContain(strangerId);
    expect(store.state.shelves).toEqual([]);
  });

  it("retire-all --yes also removes our Streamyfin rows and forgets them", async () => {
    const client = seededClient();
    client.pluginConfigs.set(STREAMYFIN_PLUGIN_ID, { Config: { notifications: {}, settings: { home: null }, other: {} } });
    const store = new MemoryStateStore();
    const flagged = { ...env, CURATOR_STREAMYFIN_ROWS: "true" };
    await main(["run"], flagged, new MemoryLogger(), { client, store, planner: new FakeShelfPlanner((request) => chunkShelves(request, 8)) });
    expect(store.state.streamyfin?.parentIds).toHaveLength(6);
    expect(await main(["retire-all", "--yes"], flagged, new MemoryLogger(), { client, store })).toBe(EXIT.ok);
    const sections = (client.pluginConfigs.get(STREAMYFIN_PLUGIN_ID) as { Config: { settings: { home: { value: { sections: { items?: { parentId?: string } }[] } } } } }).Config.settings.home.value.sections;
    expect(sections.filter((s) => s.items?.parentId)).toEqual([]);
    expect(store.state.streamyfin).toBeUndefined();
  });

  it("rows re-syncs both row writers from state without touching the planner", async () => {
    const client = seededClient();
    const store = new MemoryStateStore();
    const planner = new FakeShelfPlanner((request) => chunkShelves(request, 8));
    await main(["run"], env, new MemoryLogger(), { client, store, planner });
    client.pluginConfigs.set(STREAMYFIN_PLUGIN_ID, { Config: { notifications: {}, settings: { home: null }, other: {} } });
    const flagged = { ...env, CURATOR_STREAMYFIN_ROWS: "true" };
    const log = new MemoryLogger();
    expect(await main(["rows"], flagged, log, { client, store, planner: new FakeShelfPlanner(() => { throw new Error("planner must not run"); }) })).toBe(EXIT.ok);
    const sections = (client.pluginConfigs.get(STREAMYFIN_PLUGIN_ID) as { Config: { settings: { home: { value: { sections: { items?: { parentId?: string } }[] } } } } }).Config.settings.home.value.sections;
    expect(sections.filter((s) => s.items?.parentId)).toHaveLength(6);
    expect(store.state.streamyfin?.parentIds).toHaveLength(6);
    expect(log.lines.some((l) => l.includes("wrote 6 Streamyfin rows"))).toBe(true);

    const dry = new MemoryLogger();
    client.pluginConfigs.set(STREAMYFIN_PLUGIN_ID, { Config: { notifications: {}, settings: { home: null }, other: {} } });
    expect(await main(["rows", "--dry-run"], flagged, dry, { client, store })).toBe(EXIT.ok);
    expect((client.pluginConfigs.get(STREAMYFIN_PLUGIN_ID) as { Config: { settings: { home: null } } }).Config.settings.home).toBeNull();
    expect(dry.lines.some((l) => l.includes("[dry-run]"))).toBe(true);
  });

  it("rows says so when no row writer is enabled", async () => {
    const log = new MemoryLogger();
    expect(await main(["rows"], env, log, { client: seededClient(), store: new MemoryStateStore() })).toBe(EXIT.failure);
    expect(log.lines[0]).toMatch(/neither CURATOR_HOME_ROWS nor CURATOR_STREAMYFIN_ROWS/);
  });

  it("a run that is too soon exits 0 with a skip line, so a daily cron stays quiet", async () => {
    const client = seededClient();
    const store = new MemoryStateStore();
    const now = new Date("2026-09-05T04:00:00.000Z");
    const paced = { ...env, CURATOR_MIN_DAYS_BETWEEN_RUNS: "4" };
    await main(["run"], paced, new MemoryLogger(), { client, store, planner: new FakeShelfPlanner((request) => chunkShelves(request, 8)), now: () => now });
    const log = new MemoryLogger();
    const later = () => new Date(now.getTime() + 86_400_000);
    const code = await main(["run"], paced, log, { client, store, planner: new FakeShelfPlanner(() => { throw new Error("must not plan"); }), now: later });
    expect(code).toBe(EXIT.ok);
    expect(log.lines.some((l) => l.includes("skipping") && l.includes("4"))).toBe(true);
  });
});
