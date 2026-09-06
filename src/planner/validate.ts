import type { Shelf } from "./schema.js";

export interface ValidateOptions {
  minItems: number;
  maxItems: number;
  /** Titles that must not be reused (live shelves, recently retired, earlier answers). */
  avoidTitles: string[];
}

export interface DroppedShelf {
  title: string;
  reason: string;
}

export interface ValidationResult {
  shelves: Shelf[];
  dropped: DroppedShelf[];
  /** Ids the model produced that are not in the catalog. */
  unknownIds: number;
}

/** The prompt asks for under 40 and under 120; these are the hard caps that keep
 * a runaway answer out of a Jellyfin collection name and overview. Generous on
 * purpose: truncating a good shelf is worse than a slightly long one. */
const TITLE_MAX_CHARS = 60;
const BLURB_MAX_CHARS = 200;

const normalise = (title: string): string => title.trim().toLowerCase();

/** The model's answer is untrusted. Keep only ids that exist, no duplicates
 * within or across the shelves of this one answer, sizes within bounds, titles
 * not already in use. Callers validate one answer at a time: pooling a whole
 * run's answers here makes each batch starve the next. */
export function validatePlan(shelves: Shelf[], catalogIds: Set<string>, options: ValidateOptions): ValidationResult {
  const seenTitles = new Set(options.avoidTitles.map(normalise));
  const usedIds = new Set<string>();
  const result: ValidationResult = { shelves: [], dropped: [], unknownIds: 0 };

  for (const shelf of shelves) {
    const title = shelf.title.trim().slice(0, TITLE_MAX_CHARS);
    if (title.length === 0) {
      result.dropped.push({ title: shelf.title, reason: "empty title" });
      continue;
    }
    if (seenTitles.has(normalise(title))) {
      result.dropped.push({ title, reason: "duplicate or avoided title" });
      continue;
    }
    const itemIds: string[] = [];
    for (const id of shelf.itemIds) {
      if (!catalogIds.has(id)) {
        result.unknownIds += 1;
        continue;
      }
      if (usedIds.has(id) || itemIds.includes(id)) continue;
      itemIds.push(id);
    }
    if (itemIds.length < options.minItems) {
      result.dropped.push({ title, reason: `too few valid members (${itemIds.length})` });
      continue;
    }
    const capped = itemIds.slice(0, options.maxItems);
    for (const id of capped) usedIds.add(id);
    seenTitles.add(normalise(title));
    result.shelves.push({ ...shelf, title, blurb: shelf.blurb.trim().slice(0, BLURB_MAX_CHARS), itemIds: capped });
  }
  return result;
}
