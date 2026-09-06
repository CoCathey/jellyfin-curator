/** Tag placed on every collection this service creates. Ownership is the state
 * file; the tag is the recovery path and the second guard before any delete. */
export const CURATOR_TAG = "jellyfin-curator";

/** Stable Home Screen Sections slot ids. Users enable these once; rotation
 * changes what each slot shows, never the id. */
export const SLOT_PREFIX = "curator-shelf-";

/** IAmParadox27/jellyfin-plugin-collection-sections, from CollectionSectionPlugin.cs. */
export const COLLECTION_SECTIONS_PLUGIN_ID = "043b2c48-b3e0-4610-b398-8217b146d1a4";

/** Home Screen Sections admin endpoint that invalidates its 24 h section cache. */
export const HOME_SCREEN_BUST_CACHE_PATH = "/HomeScreen/BustCache";

/** streamyfin/jellyfin-plugin-streamyfin, from its Plugin.cs. Its home layout is `Config.settings.home`. */
export const STREAMYFIN_PLUGIN_ID = "1e9e5d38-6e67-4615-8719-e98a5c34f004";

/** How many retired shelf titles we remember so the planner avoids repeats. */
export const RETIRED_HISTORY_LIMIT = 30;

/** Overview characters sent to the planner per item. Most of the token cost lives here. */
export const OVERVIEW_MAX_CHARS = 160;

/** Under CURATOR_OVERVIEWS=recent, titles this many years back (inclusive) keep
 * their overview: the ones a model may not know from name and year alone. */
export const CATALOG_RECENT_YEARS = 2;

/** Claude Opus 5 list price, USD per million tokens. Used only for the cost log
 * line. Cache writes cost 1.25x the input rate and cache reads 0.1x of it. */
export const OPUS_5_USD_PER_MTOK = { input: 5, cacheWrite: 5 * 1.25, cacheRead: 5 * 0.1, output: 25 } as const;

/** List prices, USD per million tokens, for the cost log line only. Cache
 * writes bill at 1.25x input and cache reads at 0.1x. Unknown models fall
 * back to Opus 5 rates so the log errs high rather than silent. */
export interface ModelPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}
const price = (input: number, output: number): ModelPrice => ({ input, cacheWrite: input * 1.25, cacheRead: input * 0.1, output });
export const MODEL_USD_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": price(5, 25),
  "claude-sonnet-5": price(2, 10),
  "claude-haiku-4-5": price(1, 5),
};
export function priceFor(model: string): ModelPrice {
  return MODEL_USD_PER_MTOK[model] ?? MODEL_USD_PER_MTOK["claude-opus-5"]!;
}

export const CLIENT_NAME = "jellyfin-curator";
export const CLIENT_VERSION = "0.1.0";
