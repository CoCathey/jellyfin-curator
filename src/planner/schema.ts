import { z } from "zod";

/** Keep this schema free of length constraints so the structured-output grammar
 * stays simple. Lengths are asked for in the prompt (title under 40, blurb under
 * 120) and hard-capped by validatePlan (60 and 200) for the answers that ignore
 * the ask. */
export const ShelfSchema = z.object({
  title: z.string(),
  blurb: z.string(),
  itemIds: z.array(z.string()),
  /** One sentence for the operator's log. Never written to Jellyfin. */
  rationale: z.string(),
});

export const PlanSchema = z.object({
  shelves: z.array(ShelfSchema),
});

export type Shelf = z.infer<typeof ShelfSchema>;
export type Plan = z.infer<typeof PlanSchema>;
