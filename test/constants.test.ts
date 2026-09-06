import { describe, expect, it } from "vitest";
import { COLLECTION_SECTIONS_PLUGIN_ID, CURATOR_TAG, SLOT_PREFIX } from "../src/constants.js";

describe("constants", () => {
  it("pins the identifiers other systems depend on", () => {
    expect(CURATOR_TAG).toBe("jellyfin-curator");
    expect(SLOT_PREFIX).toBe("curator-shelf-");
    expect(COLLECTION_SECTIONS_PLUGIN_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
