import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { blockGeometry, buildCoverCard, COVER_HEIGHT, COVER_WIDTH, coverLayout, wrapTitle } from "../../src/art/cover.js";

/** A 16:9 source, like a Jellyfin backdrop. */
const backdrop = (): Promise<Buffer> =>
  sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 40, g: 90, b: 60 } } }).jpeg().toBuffer();

describe("wrapTitle", () => {
  it.each([
    { title: "Cubicle Chaos", max: 20, lines: ["Cubicle Chaos"] },
    { title: "Robots You'd Trust With Your Life", max: 18, lines: ["Robots You'd Trust", "With Your Life"] },
    { title: "  spaced   out  ", max: 20, lines: ["spaced out"] },
  ])("wraps $title", ({ title, max, lines }) => {
    expect(wrapTitle(title, max)).toEqual(lines);
  });

  it("lets a single word overflow rather than breaking it", () => {
    expect(wrapTitle("Supercalifragilistic", 5)).toEqual(["Supercalifragilistic"]);
  });
});

describe("coverLayout", () => {
  it("keeps the largest size that fits in three lines", () => {
    expect(coverLayout("Cubicle Chaos").fontSize).toBe(88);
    const long = coverLayout("Something in the House Won't Settle Down Tonight At All");
    expect(long.lines.length).toBeLessThanOrEqual(3);
    expect(long.fontSize).toBeLessThan(88);
  });
});

describe("blockGeometry", () => {
  it("centres inset and title together, so more lines start higher", () => {
    const one = blockGeometry(1, 88);
    const three = blockGeometry(3, 88);
    expect(three.insetTop).toBeLessThan(one.insetTop);
    expect(one.titleTop).toBeGreaterThan(one.insetTop);
  });
});

describe("buildCoverCard", () => {
  it("returns a poster-shaped JPEG whatever the backdrop's shape", async () => {
    const card = await buildCoverCard(await backdrop(), "Pure Dread, Slowly");
    const meta = await sharp(card).metadata();
    expect([meta.width, meta.height]).toEqual([COVER_WIDTH, COVER_HEIGHT]);
    expect(meta.format).toBe("jpeg");
  });

  it("survives a title with XML in it", async () => {
    const card = await buildCoverCard(await backdrop(), 'Cops & "Robbers" <2000s>');
    expect((await sharp(card).metadata()).width).toBe(COVER_WIDTH);
  });
});
