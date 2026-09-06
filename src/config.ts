import { z } from "zod";

const flagOff = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

export const ConfigSchema = z
  .object({
    JELLYFIN_URL: z.string().min(1).transform((u) => u.replace(/\/+$/, "")),
    JELLYFIN_API_KEY: z.string().min(1),
    CURATOR_MODEL: z.string().min(1).default("claude-opus-5"),
    CURATOR_SHELF_COUNT: z.coerce.number().int().min(1).default(6),
    CURATOR_ROTATE_PER_RUN: z.coerce.number().int().min(0).default(2),
    /** Home-screen rows, newest shelf first. Defaults to CURATOR_SHELF_COUNT.
     * Split from it because a big shelf count is a browsable collection library,
     * while a home screen stays readable at eight rows. */
    CURATOR_ROW_COUNT: z.coerce.number().int().min(0).optional(),
    CURATOR_MIN_ITEMS: z.coerce.number().int().min(1).default(8),
    CURATOR_MAX_ITEMS: z.coerce.number().int().min(1).default(20),
    /** all: every title; recent: only titles from the last CATALOG_RECENT_YEARS; none. */
    CURATOR_OVERVIEWS: z.enum(["all", "recent", "none"]).default("recent"),
    /** Shelves per run that must fit the time of year; clamped to `wanted` at run time. */
    CURATOR_SEASONAL_SHELVES: z.coerce.number().int().min(0).default(2),
    /** Most shelves to ask for in one planner call. A big ask (a catch-up run after
     * raising CURATOR_SHELF_COUNT, or --full-refresh) overruns the model's output
     * budget and comes back as a max_tokens failure, so the run splits it. */
    CURATOR_MAX_SHELVES_PER_CALL: z.coerce.number().int().min(1).default(6),
    /** Build a cover card for each new collection from its members' backdrops.
     * On by default: it costs no tokens and the alternative is a blank poster. */
    CURATOR_COVERS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    CURATOR_HOME_ROWS: flagOff,
    /** Keep collection rows on the Streamyfin (iOS, Android, Apple TV) home screen in sync. */
    CURATOR_STREAMYFIN_ROWS: flagOff,
    /** Mark the catalog block for prompt caching. Off: a cache write bills at 1.25x and
     * only pays off when a shortfall retry follows within the cache window. */
    CURATOR_CACHE_CATALOG: flagOff,
    /** With a daily cron, a real run happens only when the last one is at least this many days old. 0 disables. */
    CURATOR_MIN_DAYS_BETWEEN_RUNS: z.coerce.number().min(0).default(0),
    CURATOR_STATE_PATH: z.string().min(1).default("/data/state.json"),
    CURATOR_LIBRARY_IDS: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : [])),
  })
  .refine((c) => c.CURATOR_MIN_ITEMS <= c.CURATOR_MAX_ITEMS, {
    message: "CURATOR_MIN_ITEMS must be <= CURATOR_MAX_ITEMS",
    path: ["CURATOR_MIN_ITEMS"],
  })
  .transform((c) => ({ ...c, CURATOR_ROW_COUNT: c.CURATOR_ROW_COUNT ?? c.CURATOR_SHELF_COUNT }));

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse configuration from an env-shaped record. Unknown keys are dropped, so
 * secrets that are not ours (ANTHROPIC_API_KEY) never end up in Config. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
