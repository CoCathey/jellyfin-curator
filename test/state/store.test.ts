import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileStateStore } from "../../src/state/store.js";
import { emptyState, type State } from "../../src/state/types.js";

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "curator-")), "nested", "state.json");
}

describe("JsonFileStateStore", () => {
  it("returns an empty state when the file does not exist", async () => {
    const store = new JsonFileStateStore(await tempPath());
    expect(await store.load()).toEqual(emptyState());
  });

  it("round-trips state, creating directories and leaving no temp file behind", async () => {
    const path = await tempPath();
    const store = new JsonFileStateStore(path);
    const state: State = {
      version: 1,
      shelves: [{ collectionId: "boxset-1", title: "T", blurb: "b", itemIds: ["m1"], createdAt: "2026-09-04T00:00:00.000Z", origin: "planned" }],
      retired: [{ title: "Old", retiredAt: "2026-09-01T00:00:00.000Z" }],
      lastRun: { at: "2026-09-04T04:00:00.000Z", inputTokens: 10, outputTokens: 2 },
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(await readdir(join(path, ".."))).toEqual(["state.json"]);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("refuses a corrupt or foreign file instead of silently starting over", async () => {
    const path = await tempPath();
    const store = new JsonFileStateStore(path);
    await store.save(emptyState());
    await writeFile(path, '{"version": 2}', "utf8");
    await expect(store.load()).rejects.toThrow();
    await writeFile(path, "not json", "utf8");
    await expect(store.load()).rejects.toThrow();
  });
});
