import { buildCoverCard } from "./cover.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import type { Logger } from "../log.js";
import type { OwnedShelf } from "../state/types.js";

export interface CoverWriteResult {
  written: number;
  skipped: { title: string; reason: string }[];
}

/** Wider than the card so the blurred background still has detail to lose. */
const BACKDROP_MAX_WIDTH = 1600;

/** The first member with a backdrop. The planner lists the title that defines
 * the shelf first, so its artwork is usually the one that carries the theme;
 * anything cleverer costs either tokens or an opinion the metadata cannot back.
 */
export async function pickCoverSource(
  client: JellyfinClient,
  itemIds: string[],
): Promise<{ itemId: string; name: string; backdrop: Buffer } | undefined> {
  for (const itemId of itemIds) {
    const item = await client.getItem(itemId);
    if (!item || (item.BackdropImageTags ?? []).length === 0) continue;
    const backdrop = await client.getImage(itemId, "Backdrop", 0, BACKDROP_MAX_WIDTH);
    if (backdrop) return { itemId, name: item.Name ?? itemId, backdrop };
  }
  return undefined;
}

/** Gives every shelf a cover built from its own members' artwork. Costs no
 * tokens: no model is involved and no image leaves the household. */
export async function writeCovers(
  client: JellyfinClient,
  shelves: OwnedShelf[],
  options: { dryRun: boolean; force: boolean },
  log: Logger,
): Promise<CoverWriteResult> {
  const result: CoverWriteResult = { written: 0, skipped: [] };
  for (const shelf of shelves) {
    const collection = await client.getItem(shelf.collectionId);
    if (!collection) {
      result.skipped.push({ title: shelf.title, reason: "collection is gone" });
      continue;
    }
    if (!options.force && (collection.ImageTags ?? {}).Primary) {
      result.skipped.push({ title: shelf.title, reason: "already has a cover" });
      continue;
    }
    const source = await pickCoverSource(client, shelf.itemIds);
    if (!source) {
      result.skipped.push({ title: shelf.title, reason: "no member has a backdrop" });
      continue;
    }
    if (options.dryRun) {
      log.info(`[dry-run] would cover "${shelf.title}" with the backdrop from ${source.name}`);
      result.written += 1;
      continue;
    }
    const card = await buildCoverCard(source.backdrop, shelf.title);
    await client.setPrimaryImage(shelf.collectionId, card, "image/jpeg");
    log.info(`covered "${shelf.title}" with the backdrop from ${source.name}`);
    result.written += 1;
  }
  for (const { title, reason } of result.skipped) {
    if (reason !== "already has a cover") log.warn(`no cover for "${title}": ${reason}`);
  }
  return result;
}
