import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/log.js";

describe("MemoryLogger", () => {
  it("records each level with a prefix, in order", () => {
    const log = new MemoryLogger();
    log.info("one");
    log.warn("two");
    log.error("three");
    expect(log.lines).toEqual(["info one", "warn two", "error three"]);
  });
});
