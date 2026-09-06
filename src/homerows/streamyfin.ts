import { STREAMYFIN_PLUGIN_ID } from "../constants.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import type { Logger } from "../log.js";
import type { OwnedShelf } from "../state/types.js";

/** Mirrors Jellyfin.Plugin.Streamyfin.Configuration: `Config.settings.home` is a
 * Lockable<Home>; a Section's `items` block is a Jellyfin /Items query, and
 * `parentId` pointed at a BoxSet makes the section a row of that collection.
 * Keys are camelCase because the plugin declares them that way. */
export interface StreamyfinItemsQuery {
  parentId?: string | null;
  includeItemTypes?: string[] | null;
  limit?: number | null;
  [extra: string]: unknown;
}

export interface StreamyfinSection {
  title?: string | null;
  orientation?: string | null;
  items?: StreamyfinItemsQuery | null;
  [extra: string]: unknown;
}

export interface StreamyfinHome {
  sections?: StreamyfinSection[] | null;
  [extra: string]: unknown;
}

export interface StreamyfinLockableHome {
  locked?: boolean | null;
  value?: StreamyfinHome | null;
  [extra: string]: unknown;
}

export interface StreamyfinConfig {
  Config?: {
    settings?: { home?: StreamyfinLockableHome | null; [extra: string]: unknown } | null;
    [extra: string]: unknown;
  } | null;
  [extra: string]: unknown;
}

export interface StreamyfinWriteResult {
  written: number;
  foreignKept: number;
  /** Collection ids the rows now point at; recorded in state so the next run can tell ours from hand-written ones. */
  parentIds: string[];
}

/** The plugin's own example rows. Seeded once, only when the plugin has no home
 * layout at all: otherwise our rows alone would replace Continue Watching. */
export const DEFAULT_STREAMYFIN_SECTIONS: readonly StreamyfinSection[] = [
  { title: "Continue Watching", orientation: "horizontal", custom: { endpoint: "/UserItems/Resume" } },
  { title: "Next Up", orientation: "horizontal", nextUp: { limit: 25, enableResumable: true, enableRewatching: false } },
  {
    title: "Recently Added",
    orientation: "vertical",
    items: { sortBy: ["DateCreated"], sortOrder: ["Descending"], includeItemTypes: ["Series", "Movie"], limit: 25 },
  },
];

/** Newest shelves first, one row each, at most slotCount. */
export function buildStreamyfinSections(shelves: OwnedShelf[], slotCount: number): StreamyfinSection[] {
  return [...shelves]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0;
    })
    .slice(0, slotCount)
    .map((shelf) => ({
      title: shelf.title,
      orientation: "horizontal",
      items: { parentId: shelf.collectionId, includeItemTypes: ["Movie", "Series"], limit: 20 },
    }));
}

/** Keeps every section whose collection id is not one of ours (now or previously
 * written), keeps every other setting untouched, appends our rows last. */
export function mergeStreamyfinSections(
  existing: StreamyfinConfig,
  sections: StreamyfinSection[],
  ours: ReadonlySet<string>,
): { config: StreamyfinConfig; foreignKept: number; seededDefaults: boolean } {
  const home = existing.Config?.settings?.home ?? undefined;
  const current = home?.value?.sections ?? [];
  const foreign = current.filter((section) => !(section.items?.parentId && ours.has(section.items.parentId)));
  const seededDefaults = current.length === 0;
  const base = seededDefaults ? [...DEFAULT_STREAMYFIN_SECTIONS] : foreign;
  const config: StreamyfinConfig = {
    ...existing,
    Config: {
      ...(existing.Config ?? {}),
      settings: {
        ...(existing.Config?.settings ?? {}),
        home: { ...(home ?? {}), locked: home?.locked ?? false, value: { ...(home?.value ?? {}), sections: [...base, ...sections] } },
      },
    },
  };
  return { config: normalizeLockables(config), foreignKept: foreign.length, seededDefaults };
}

/** Streamyfin 0.66 writes a null `Lockable<T>` as `{ locked }` with no `value`
 * key, then refuses that shape on POST ("missing required properties including:
 * 'value'"), so its own config cannot round-trip. Giving every lockable an
 * explicit `value` (null when absent) is what makes the endpoint accept it. */
export function normalizeLockables<T>(node: T): T {
  if (Array.isArray(node)) return node.map((item) => normalizeLockables(item)) as T;
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = normalizeLockables(value);
  if ("locked" in out && !("value" in out)) out.value = null;
  return out as T;
}

function asConfig(value: unknown): StreamyfinConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("Streamyfin configuration is not a JSON object");
  return value as StreamyfinConfig;
}

export async function writeStreamyfinRows(
  client: JellyfinClient,
  shelves: OwnedShelf[],
  options: { slotCount: number; dryRun: boolean; previousParentIds: string[] },
  log: Logger,
): Promise<StreamyfinWriteResult | undefined> {
  const existing = asConfig(await client.getPluginConfiguration(STREAMYFIN_PLUGIN_ID));
  if (existing === undefined) {
    log.warn("Streamyfin plugin not installed (no configuration at its plugin id); skipping Streamyfin rows");
    return undefined;
  }
  const sections = buildStreamyfinSections(shelves, options.slotCount);
  const ours = new Set([...options.previousParentIds, ...shelves.map((s) => s.collectionId)]);
  const { config, foreignKept, seededDefaults } = mergeStreamyfinSections(existing, sections, ours);
  const parentIds = sections.map((s) => s.items?.parentId ?? "").filter((id) => id.length > 0);
  const seeded = seededDefaults ? `, seeded ${DEFAULT_STREAMYFIN_SECTIONS.length} default rows first` : "";
  if (options.dryRun) {
    log.info(`[dry-run] would write ${sections.length} Streamyfin rows (${foreignKept} foreign sections kept${seeded})`);
    return { written: sections.length, foreignKept, parentIds };
  }
  await client.setPluginConfiguration(STREAMYFIN_PLUGIN_ID, config);
  log.info(`wrote ${sections.length} Streamyfin rows (${foreignKept} foreign sections kept${seeded})`);
  return { written: sections.length, foreignKept, parentIds };
}
