import { describe, expect, it } from "vitest";
import { FakeJellyfinClient } from "./jellyfin.js";

function seeded(): FakeJellyfinClient {
  const fake = new FakeJellyfinClient();
  fake.addItem({ Id: "m1", Name: "Heat", Type: "Movie" });
  fake.addItem({ Id: "s1", Name: "The Wire", Type: "Series", Tags: ["hbo"] });
  fake.addItem({ Id: "e1", Name: "Pilot", Type: "Episode" });
  fake.users = [{ Id: "u1", Name: "Admin" }];
  fake.played.set("u1", new Set(["m1"]));
  fake.favorites.set("u1", new Set(["s1"]));
  return fake;
}

describe("FakeJellyfinClient", () => {
  it("filters by type, tags, played and favourite; attaches UserData per user", async () => {
    const fake = seeded();
    expect((await fake.queryItems({ includeItemTypes: ["Movie", "Series"] })).map((i) => i.Id)).toEqual(["m1", "s1"]);
    expect((await fake.queryItems({ includeItemTypes: ["Series"], tags: ["hbo"] })).map((i) => i.Id)).toEqual(["s1"]);
    expect((await fake.queryItems({ includeItemTypes: ["Movie", "Series"], userId: "u1", isPlayed: true })).map((i) => i.Id)).toEqual(["m1"]);
    const favs = await fake.queryItems({ includeItemTypes: ["Movie", "Series"], userId: "u1", isFavorite: true });
    expect(favs.map((i) => i.Id)).toEqual(["s1"]);
    expect(favs[0]!.UserData).toEqual({ Played: false, IsFavorite: true });
  });

  it("round-trips a collection through create, get, update, delete", async () => {
    const fake = seeded();
    const id = await fake.createCollection("Shelf", ["m1", "s1"]);
    expect(id).toBe("boxset-1");
    const dto = await fake.getItem(id);
    expect(dto).toMatchObject({ Id: id, Name: "Shelf", Type: "BoxSet" });
    await fake.updateItem({ ...dto!, Tags: ["jellyfin-curator"] });
    expect((await fake.getItem(id))!.Tags).toEqual(["jellyfin-curator"]);
    expect((await fake.queryItems({ includeItemTypes: ["BoxSet"], tags: ["jellyfin-curator"] })).map((i) => i.Id)).toEqual([id]);
    await fake.deleteItem(id);
    expect(await fake.getItem(id)).toBeUndefined();
    expect(fake.deleted).toEqual([id]);
  });

  it("returns copies, not live references", async () => {
    const fake = seeded();
    const first = await fake.getItem("m1");
    first!.Name = "changed";
    expect((await fake.getItem("m1"))!.Name).toBe("Heat");
    const users = await fake.listUsers();
    users[0]!.Name = "changed";
    expect((await fake.listUsers())[0]!.Name).toBe("Admin");
  });

  it("stores plugin configuration and records actions", async () => {
    const fake = seeded();
    expect(await fake.getPluginConfiguration("p")).toBeUndefined();
    await fake.setPluginConfiguration("p", { Sections: [{ UniqueId: "x" }] });
    expect(await fake.getPluginConfiguration("p")).toEqual({ Sections: [{ UniqueId: "x" }] });
    fake.actionStatus = 404;
    expect(await fake.postAction("/HomeScreen/BustCache")).toBe(404);
    expect(fake.actions).toEqual(["/HomeScreen/BustCache"]);
  });

  it("can be told to fail a create", async () => {
    const fake = seeded();
    fake.failCreateFor.add("Broken");
    await expect(fake.createCollection("Broken", ["m1"])).rejects.toThrow(/Broken/);
  });
});
