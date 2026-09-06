import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { JELLYFIN_URL: "http://jf:8096/", JELLYFIN_API_KEY: "k" };

describe("loadConfig", () => {
  it("applies defaults and strips the trailing slash", () => {
    const c = loadConfig(base);
    expect(c.JELLYFIN_URL).toBe("http://jf:8096");
    expect(c.CURATOR_MODEL).toBe("claude-opus-5");
    expect(c.CURATOR_SHELF_COUNT).toBe(6);
    expect(c.CURATOR_ROTATE_PER_RUN).toBe(2);
    expect(c.CURATOR_MIN_ITEMS).toBe(8);
    expect(c.CURATOR_MAX_ITEMS).toBe(20);
    expect(c.CURATOR_OVERVIEWS).toBe("recent");
    expect(c.CURATOR_HOME_ROWS).toBe(false);
    expect(c.CURATOR_STATE_PATH).toBe("/data/state.json");
    expect(c.CURATOR_LIBRARY_IDS).toEqual([]);
    expect(c.CURATOR_SEASONAL_SHELVES).toBe(2);
    expect(c.CURATOR_MAX_SHELVES_PER_CALL).toBe(6);
    expect(c.CURATOR_STREAMYFIN_ROWS).toBe(false);
    expect(c.CURATOR_CACHE_CATALOG).toBe(false);
    expect(c.CURATOR_MIN_DAYS_BETWEEN_RUNS).toBe(0);
    expect(c.CURATOR_ROW_COUNT).toBe(c.CURATOR_SHELF_COUNT);
  });

  it("keeps home rows shorter than the shelf count when asked", () => {
    const c = loadConfig({ ...base, CURATOR_SHELF_COUNT: "25", CURATOR_ROW_COUNT: "8", CURATOR_MAX_SHELVES_PER_CALL: "8" });
    expect(c.CURATOR_SHELF_COUNT).toBe(25);
    expect(c.CURATOR_ROW_COUNT).toBe(8);
    expect(c.CURATOR_MAX_SHELVES_PER_CALL).toBe(8);
  });

  it("parses numbers, flags and the library id list", () => {
    const c = loadConfig({
      ...base,
      CURATOR_SHELF_COUNT: "4",
      CURATOR_HOME_ROWS: "true",
      CURATOR_OVERVIEWS: "none",
      CURATOR_LIBRARY_IDS: "a, b,,c",
      CURATOR_SEASONAL_SHELVES: "0",
      CURATOR_STREAMYFIN_ROWS: "true",
      CURATOR_CACHE_CATALOG: "true",
      CURATOR_MIN_DAYS_BETWEEN_RUNS: "4",
    });
    expect(c.CURATOR_SHELF_COUNT).toBe(4);
    expect(c.CURATOR_HOME_ROWS).toBe(true);
    expect(c.CURATOR_OVERVIEWS).toBe("none");
    expect(c.CURATOR_LIBRARY_IDS).toEqual(["a", "b", "c"]);
    expect(c.CURATOR_SEASONAL_SHELVES).toBe(0);
    expect(c.CURATOR_STREAMYFIN_ROWS).toBe(true);
    expect(c.CURATOR_CACHE_CATALOG).toBe(true);
    expect(c.CURATOR_MIN_DAYS_BETWEEN_RUNS).toBe(4);
  });

  it("lists every missing required value", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/JELLYFIN_URL/);
    expect(() => loadConfig({})).toThrow(/JELLYFIN_API_KEY/);
  });

  it("rejects min > max and non-numeric numbers", () => {
    expect(() => loadConfig({ ...base, CURATOR_MIN_ITEMS: "10", CURATOR_MAX_ITEMS: "5" })).toThrow(/CURATOR_MIN_ITEMS must be/);
    expect(() => loadConfig({ ...base, CURATOR_SHELF_COUNT: "six" })).toThrow(/CURATOR_SHELF_COUNT/);
    expect(() => loadConfig({ ...base, CURATOR_OVERVIEWS: "sometimes" })).toThrow(/CURATOR_OVERVIEWS/);
  });

  it("ignores unrelated environment variables", () => {
    const c = loadConfig({ ...base, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk" });
    expect(Object.keys(c)).not.toContain("ANTHROPIC_API_KEY");
  });
});
