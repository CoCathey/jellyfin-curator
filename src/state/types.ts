import { z } from "zod";

export const OwnedShelfSchema = z.object({
  collectionId: z.string(),
  title: z.string(),
  blurb: z.string(),
  itemIds: z.array(z.string()),
  /** ISO timestamp from the injected clock. Rotation retires oldest first. */
  createdAt: z.string(),
  /** "orphan": tagged in Jellyfin but unknown to state; retired first, never planned around. */
  origin: z.enum(["planned", "orphan"]),
});

export const RetiredShelfSchema = z.object({
  title: z.string(),
  retiredAt: z.string(),
});

export const StateSchema = z.object({
  version: z.literal(1),
  shelves: z.array(OwnedShelfSchema),
  retired: z.array(RetiredShelfSchema),
  lastRun: z.object({ at: z.string(), inputTokens: z.number(), outputTokens: z.number() }).optional(),
  /** Collection ids our Streamyfin rows point at, so the next write can tell ours from hand-written sections. */
  streamyfin: z.object({ parentIds: z.array(z.string()) }).optional(),
});

export type OwnedShelf = z.infer<typeof OwnedShelfSchema>;
export type RetiredShelf = z.infer<typeof RetiredShelfSchema>;
export type State = z.infer<typeof StateSchema>;

export function emptyState(): State {
  return { version: 1, shelves: [], retired: [] };
}
