import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { pickCoverSource, writeCovers } from "../../src/art/covers.js";
import { MemoryLogger } from "../../src/log.js";
import type { OwnedShelf } from "../../src/state/types.js";
import { FakeJellyfinClient } from "../fakes/jellyfin.js";

const shelf = (overrides: Partial<OwnedShelf> = {}): OwnedShelf => ({
  collectionId: "boxset-1",
  title: "Pure Dread, Slowly",
  blurb: "b",
  itemIds: ["m1", "m2"],
  createdAt: "2026-09-05T00:00:00.000Z",
  origin: "planned",
  ...overrides,
});

async function world(): Promise<{ client: FakeJellyfinClient; log: MemoryLogger }> {
  const client = new FakeJellyfinClient();
  client.addItem({ Id: "boxset-1", Name: "Pure Dread, Slowly", Type: "BoxSet" });
  client.addItem({ Id: "m1", Name: "No Art", Type: "Movie" });
  client.addItem({ Id: "m2", Name: "Alien", Type: "Movie", BackdropImageTags: ["tag"] });
  client.images.set("m2/Backdrop/0", await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#204020" } }).jpeg().toBuffer());
  return { client, log: new MemoryLogger() };
}

describe("pickCoverSource", () => {
  it("takes the first member that actually has a backdrop", async () => {
    const { client } = await world();
    expect((await pickCoverSource(client, ["m1", "m2"]))?.name).toBe("Alien");
  });

  it("is undefined when no member has one", async () => {
    const { client } = await world();
    expect(await pickCoverSource(client, ["m1"])).toBeUndefined();
  });
});

describe("writeCovers", () => {
  it("uploads a JPEG cover and names the film it came from", async () => {
    const { client, log } = await world();
    const result = await writeCovers(client, [shelf()], { dryRun: false, force: false }, log);
    expect(result.written).toBe(1);
    const uploaded = client.uploadedPrimary.get("boxset-1");
    expect(uploaded?.contentType).toBe("image/jpeg");
    expect((await sharp(uploaded!.image).metadata()).height).toBe(1500);
    expect(log.lines.some((l) => l.includes('covered "Pure Dread, Slowly" with the backdrop from Alien'))).toBe(true);
  });

  it("leaves a collection that already has a cover alone, unless forced", async () => {
    const { client, log } = await world();
    await writeCovers(client, [shelf()], { dryRun: false, force: false }, log);
    const first = client.uploadedPrimary.get("boxset-1")!.image;
    const again = await writeCovers(client, [shelf()], { dryRun: false, force: false }, log);
    expect(again).toEqual({ written: 0, skipped: [{ title: "Pure Dread, Slowly", reason: "already has a cover" }] });
    expect(client.uploadedPrimary.get("boxset-1")!.image).toBe(first);
    expect((await writeCovers(client, [shelf()], { dryRun: false, force: true }, log)).written).toBe(1);
  });

  it("writes nothing on a dry run but still reports the count", async () => {
    const { client, log } = await world();
    const result = await writeCovers(client, [shelf()], { dryRun: true, force: false }, log);
    expect(result.written).toBe(1);
    expect(client.uploadedPrimary.size).toBe(0);
    expect(log.lines.some((l) => l.includes("[dry-run] would cover"))).toBe(true);
  });

  it("warns and moves on when no member has a backdrop, or the collection is gone", async () => {
    const { client, log } = await world();
    const result = await writeCovers(
      client,
      [shelf({ itemIds: ["m1"] }), shelf({ collectionId: "vanished", title: "Gone" })],
      { dryRun: false, force: false },
      log,
    );
    expect(result.written).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(["no member has a backdrop", "collection is gone"]);
    expect(log.lines.filter((l) => l.startsWith("warn no cover for")).length).toBe(2);
  });
});
