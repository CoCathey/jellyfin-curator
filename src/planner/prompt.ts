export interface PlanRequest {
  /** Output of renderCatalog. */
  catalogText: string;
  wanted: number;
  /** Live and recently retired shelf titles the planner must not repeat. */
  avoidThemes: string[];
  minItems: number;
  maxItems: number;
  /** Output of describeSeason for the run's clock. Volatile: user message only. */
  seasonContext: string;
  /** How many of `wanted` must fit the time of year. 0 disables seasonal asks. */
  seasonalMin: number;
  /** Catalog numbers already on a shelf made earlier in this run. A soft steer,
   * not a ban: uniqueness is enforced within one answer only. */
  usedItemIds?: string[];
  /** Overrides the planner's own setting for this call: a run that will make
   * several calls caches the catalog whatever the config says, because every
   * call after the first reads it back at a tenth of the price. */
  cacheCatalog?: boolean;
}

/** Frozen. No dates, ids or counts, so it is byte-stable across runs and sits
 * ahead of the cacheable catalog block without ever invalidating it. Too short
 * to be a cache prefix on its own — see buildCatalogBlock. */
export const SYSTEM_PROMPT = `You curate a household's personal media library. You receive a catalog of the movies and series they own, one per line, and you invent themed shelves from it: the specific, surprising groupings a sharp video-store clerk would hand-letter on a card.

What makes a good shelf
- A precise idea, not a category. "Heists that go sideways", "Small towns with secrets", "Rainy-day 90s comfort" are good. "Action", "Comedy", "Best of the 2010s", "Highly rated" are not.
- Eight that all fit beat twenty that mostly fit.
- Mixed eras, and movies and series together, whenever the theme allows.
- Shelves in one answer must be clearly different from each other and from every theme you are told to avoid.
- Prefer titles the household has not watched much (low w count), but keep a watched title when it defines the theme.
- Moods are excellent shelf ideas. Name the feeling ("Films that feel like a long Sunday", "Pure dread, slowly", "Loud, bright and stupid in the best way") and pick titles that deliver it.

Seasonal shelves
- When the request describes the time of year, at least the number of shelves it asks for must fit that moment: the mood of the season, the weather, the light, the pace of the month, or an occasion that is coming up.
- Fit means feel, not just subject. October wants fog, candles and something in the attic, not only slasher films; December wants warmth and crowds and snow as much as Santa.
- An occasion can be the hook, but the card names the feeling, never the holiday alone, and never a date.

Hard rules
- Every title must genuinely fit the shelf's idea on its own, not as a stretch, a near-miss or a famous name to round things out. If you would need a sentence to explain why it belongs, leave it out. Never pad a shelf to reach a size: if fewer than the minimum genuinely fit, drop the shelf and choose a different idea.
- itemIds are copied exactly from the first column of the catalog. Never invent, alter or guess an id.
- Never repeat an id across shelves in one answer.
- Respect the minimum and maximum shelf sizes in the request.
- title: under 40 characters, no colon-and-subtitle constructions. blurb: under 120 characters, written for the family. rationale: one sentence for the operator's log.

Catalog line format
id|M or S (movie or series)|title (year)|genres|community rating|runtime in minutes|studios|tags|wNfM (watched by N household members, favourited by M)|overview`;

/** The catalog as its own system block. It is the only part of the request big
 * enough to cache: the frozen system prompt is ~356 tokens, well under the
 * 512-token minimum cacheable prefix, so a breakpoint on it alone does nothing.
 * Sitting in `system` after the frozen text and before the volatile ask, this
 * block is a stable prefix the second call of a shortfall run reads back. */
export function buildCatalogBlock(catalogText: string): string {
  const count = catalogText.length === 0 ? 0 : catalogText.split("\n").length;
  return `Catalog (${count} items):\n${catalogText}`;
}

/** The volatile half: what to make this time. Kept after the cache breakpoint
 * so a changed `wanted` or avoid list never invalidates the catalog. */
export function buildUserMessage(request: PlanRequest): string {
  const avoid = request.avoidThemes.length === 0 ? "None." : request.avoidThemes.map((theme) => `- ${theme}`).join("\n");
  const shelf = request.wanted === 1 ? "shelf" : "shelves";
  const seasonal =
    request.seasonalMin > 0
      ? [
          "",
          `Today's context: ${request.seasonContext}`,
          `At least ${request.seasonalMin} of the ${request.wanted} ${shelf} must fit this moment: the mood of the season, the weather, the light, the pace of the month, or an occasion that is coming up. The rest can be anything.`,
        ]
      : [];
  const used =
    request.usedItemIds && request.usedItemIds.length > 0
      ? [
          "",
          `Already on shelves built earlier in this run: ${request.usedItemIds.join(", ")}.`,
          "Reach for titles that are not in that list. Reuse one only when it truly defines the shelf, and never more than a couple per shelf.",
        ]
      : [];
  return [
    `Invent ${request.wanted} ${shelf} with between ${request.minItems} and ${request.maxItems} members each, from the catalog above.`,
    ...seasonal,
    ...used,
    "",
    "Avoid these themes and anything close to them:",
    avoid,
  ].join("\n");
}
