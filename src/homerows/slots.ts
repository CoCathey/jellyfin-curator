import { COLLECTION_SECTIONS_PLUGIN_ID, HOME_SCREEN_BUST_CACHE_PATH, SLOT_PREFIX } from "../constants.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import type { Logger } from "../log.js";
import type { OwnedShelf } from "../state/types.js";

/** Mirrors Jellyfin.Plugin.CollectionSections.Configuration.SectionsConfig. */
export interface SlotEntry {
  UniqueId: string;
  DisplayText: string;
  CollectionName: string;
  SectionType: "Collection" | "Playlist";
}

export interface CollectionSectionsConfig {
  Sections?: Array<Partial<SlotEntry>> | null;
  [extra: string]: unknown;
}

export interface SlotWriteResult {
  written: number;
  foreignKept: number;
}

/** Newest shelves first, one slot each, at most slotCount. Slot ids are stable
 * across runs so a user's "enabled sections" choice survives rotation. */
export function buildSlots(shelves: OwnedShelf[], slotCount: number): SlotEntry[] {
  return [...shelves]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0;
    })
    .slice(0, slotCount)
    .map((shelf, index) => ({
      UniqueId: `${SLOT_PREFIX}${index + 1}`,
      DisplayText: shelf.title,
      CollectionName: shelf.title,
      SectionType: "Collection" as const,
    }));
}

/** Keeps every section the service did not create; replaces all of ours. */
export function mergeSlots(existing: CollectionSectionsConfig | undefined, slots: SlotEntry[]): { config: CollectionSectionsConfig; foreignKept: number } {
  const foreign = (existing?.Sections ?? []).filter((section) => !(section.UniqueId ?? "").startsWith(SLOT_PREFIX));
  return { config: { ...(existing ?? {}), Sections: [...foreign, ...slots] }, foreignKept: foreign.length };
}

function asConfig(value: unknown): CollectionSectionsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("Collection Sections configuration is not a JSON object");
  return value as CollectionSectionsConfig;
}

export async function writeHomeRowSlots(
  client: JellyfinClient,
  shelves: OwnedShelf[],
  options: { slotCount: number; dryRun: boolean },
  log: Logger,
): Promise<SlotWriteResult | undefined> {
  const existing = asConfig(await client.getPluginConfiguration(COLLECTION_SECTIONS_PLUGIN_ID));
  if (existing === undefined) {
    log.warn("Collection Sections plugin not installed (no configuration at its plugin id); skipping home rows");
    return undefined;
  }
  const slots = buildSlots(shelves, options.slotCount);
  const { config, foreignKept } = mergeSlots(existing, slots);
  if (options.dryRun) {
    log.info(`[dry-run] would write ${slots.length} home-row slots (${foreignKept} foreign sections kept)`);
    return { written: slots.length, foreignKept };
  }
  await client.setPluginConfiguration(COLLECTION_SECTIONS_PLUGIN_ID, config);
  const status = await client.postAction(HOME_SCREEN_BUST_CACHE_PATH);
  if (status !== 200) log.warn(`Home Screen Sections cache bust returned ${status}; rows may lag up to 24 h`);
  log.info(`wrote ${slots.length} home-row slots (${foreignKept} foreign sections kept)`);
  return { written: slots.length, foreignKept };
}
