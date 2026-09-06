import { CURATOR_TAG, RETIRED_HISTORY_LIMIT } from "../constants.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import type { Logger } from "../log.js";
import type { Shelf } from "../planner/schema.js";
import type { StateStore } from "../state/store.js";
import type { OwnedShelf, State } from "../state/types.js";

export interface ApplyInput {
  retire: OwnedShelf[];
  create: Shelf[];
  /** Every BoxSet id that existed before this run, ours and the household's own alike.
   * Jellyfin derives a BoxSet id from its name-based path, so creating a
   * collection whose name is already taken silently resolves to that
   * collection. Without this set we would tag someone's hand-made collection,
   * record it as ours, and delete it a few rotations later. */
  existingCollectionIds: Set<string>;
  dryRun: boolean;
  now: () => Date;
}

export interface ApplyReport {
  retired: string[];
  created: { collectionId: string; title: string }[];
  skipped: { title: string; reason: string }[];
}

export interface ApplyResult {
  state: State;
  report: ApplyReport;
}

function withoutShelf(state: State, shelf: OwnedShelf, retiredAt: Date): State {
  const retired = [...state.retired, { title: shelf.title, retiredAt: retiredAt.toISOString() }].slice(-RETIRED_HISTORY_LIMIT);
  return { ...state, shelves: state.shelves.filter((s) => s.collectionId !== shelf.collectionId), retired };
}

/** The only code that writes to Jellyfin. Retires first (guarded), then
 * creates. State is saved after every successful write so a crash mid-run
 * leaves it truthful. Dry run performs the reads and none of the writes. */
export async function applyPlan(client: JellyfinClient, store: StateStore, state: State, input: ApplyInput, log: Logger): Promise<ApplyResult> {
  let next: State = structuredClone(state);
  const report: ApplyReport = { retired: [], created: [], skipped: [] };

  for (const shelf of input.retire) {
    const item = await client.getItem(shelf.collectionId);
    if (!item) {
      log.warn(`retire "${shelf.title}": ${shelf.collectionId} no longer exists; dropping from state`);
      if (!input.dryRun) {
        next = withoutShelf(next, shelf, input.now());
        await store.save(next);
      }
      continue;
    }
    const tagged = (item.Tags ?? []).includes(CURATOR_TAG);
    if (item.Type !== "BoxSet" || !tagged) {
      log.error(`retire "${shelf.title}": refusing to delete ${shelf.collectionId} (Type=${item.Type}, tagged=${String(tagged)})`);
      report.skipped.push({ title: shelf.title, reason: "delete guard failed" });
      continue;
    }
    if (input.dryRun) {
      log.info(`[dry-run] would retire "${shelf.title}" (${shelf.collectionId})`);
      report.retired.push(shelf.title);
      continue;
    }
    await client.deleteItem(shelf.collectionId);
    next = withoutShelf(next, shelf, input.now());
    await store.save(next);
    report.retired.push(shelf.title);
    log.info(`retired "${shelf.title}"`);
  }

  for (const shelf of input.create) {
    if (input.dryRun) {
      log.info(`[dry-run] would create "${shelf.title}" with ${shelf.itemIds.length} items`);
      report.created.push({ collectionId: "(dry-run)", title: shelf.title });
      continue;
    }
    let collectionId: string | undefined;
    try {
      collectionId = await client.createCollection(shelf.title, shelf.itemIds);
      if (input.existingCollectionIds.has(collectionId)) {
        log.error(`create "${shelf.title}": resolved to existing collection ${collectionId}; leaving it untagged and unrecorded`);
        report.skipped.push({ title: shelf.title, reason: "name collides with an existing collection" });
        continue;
      }
      const dto = await client.getItem(collectionId);
      if (!dto) throw new Error(`created collection ${collectionId} could not be read back`);
      const tags = Array.from(new Set([...(dto.Tags ?? []), CURATOR_TAG]));
      await client.updateItem({ ...dto, Tags: tags, Overview: shelf.blurb });
      const owned: OwnedShelf = {
        collectionId,
        title: shelf.title,
        blurb: shelf.blurb,
        itemIds: [...shelf.itemIds],
        createdAt: input.now().toISOString(),
        origin: "planned",
      };
      next = { ...next, shelves: [...next.shelves, owned] };
      await store.save(next);
      report.created.push({ collectionId, title: shelf.title });
      log.info(`created "${shelf.title}" (${collectionId}, ${shelf.itemIds.length} items)`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`create "${shelf.title}" failed: ${reason}`);
      if (collectionId !== undefined) {
        // No compensating delete: the collection is untagged, and only tagged
        // BoxSets may ever be deleted. Say exactly what is out there instead.
        log.error(`create "${shelf.title}": left an untagged collection ${collectionId} in Jellyfin; delete it by hand`);
      }
      report.skipped.push({ title: shelf.title, reason });
    }
  }

  return { state: next, report };
}
