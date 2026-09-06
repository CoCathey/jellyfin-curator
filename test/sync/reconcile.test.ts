import { describe, expect, it } from "vitest";
import type { State } from "../../src/state/types.js";
import { reconcileOwned } from "../../src/sync/reconcile.js";

const now = new Date("2026-09-04T04:00:00.000Z");
const state: State = {
  version: 1,
  shelves: [
    { collectionId: "boxset-1", title: "Kept", blurb: "", itemIds: [], createdAt: "2026-09-01T00:00:00.000Z", origin: "planned" },
    { collectionId: "boxset-2", title: "Vanished", blurb: "", itemIds: [], createdAt: "2026-09-02T00:00:00.000Z", origin: "planned" },
  ],
  retired: [],
};

describe("reconcileOwned", () => {
  it("drops shelves Jellyfin no longer has and adopts tagged strangers as orphans", () => {
    const result = reconcileOwned(state, [{ Id: "boxset-1", Name: "Kept" }, { Id: "boxset-9", Name: "Stranger" }], now);
    expect(result.dropped.map((s) => s.collectionId)).toEqual(["boxset-2"]);
    expect(result.adopted).toEqual([
      { collectionId: "boxset-9", title: "Stranger", blurb: "", itemIds: [], createdAt: now.toISOString(), origin: "orphan" },
    ]);
    expect(result.state.shelves.map((s) => s.collectionId)).toEqual(["boxset-1", "boxset-9"]);
    expect(result.state.retired).toEqual([]);
  });

  it("is a no-op when everything matches", () => {
    const result = reconcileOwned(state, [{ Id: "boxset-1", Name: "Kept" }, { Id: "boxset-2", Name: "Vanished" }], now);
    expect(result.dropped).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(result.state).toEqual(state);
  });
});
