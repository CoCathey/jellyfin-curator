import type { CatalogEntry } from "./build.js";

/** Column separator is "|" and line separator is "\n"; neither may appear inside a field. */
const clean = (text: string): string => text.replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** id|M/S|title (year)|genres|rating|runtime|studios|tags|wNfM|overview — the
 * legend in the system prompt must match this order. */
export function renderEntry(entry: CatalogEntry, includeOverview: boolean): string {
  const columns = [
    entry.id,
    entry.kind,
    `${clean(entry.title)} (${entry.year ?? "-"})`,
    entry.genres.map(clean).join(","),
    entry.rating === undefined ? "-" : entry.rating.toFixed(1),
    entry.runtimeMin === undefined ? "-" : String(entry.runtimeMin),
    entry.studios.map(clean).join(","),
    entry.tags.map(clean).join(","),
    `w${entry.watchedBy}f${entry.favoritedBy}`,
  ];
  if (includeOverview) columns.push(clean(entry.overview));
  return columns.join("|");
}

export type OverviewPolicy = "all" | "recent" | "none";

export interface RenderOptions {
  overviews: OverviewPolicy;
  /** Under "recent": titles from this many years back (inclusive) keep their overview. */
  recentYears: number;
  /** The current year, injected so rendering is deterministic. */
  year: number;
}

export interface RenderedCatalog {
  text: string;
  /** Map a catalog number the model copied back to the Jellyfin id; undefined for anything else. */
  resolveId(shortId: string): string | undefined;
  /** The other way: a Jellyfin id back to the number the model sees. */
  shortIdFor(id: string): string | undefined;
}

/** Measured on a 1 007-item library: TMDb keywords were the biggest column at
 * a median of 16 per title, studios and 32-character ids the next. Five clean
 * keywords and the first studio keep the signal; a 1..N number replaces the id
 * and is mapped back after planning. */
export const CATALOG_MAX_TAGS = 5;
export const CATALOG_MAX_STUDIOS = 1;
/** TMDb keywords that describe the credits, not the film. */
export const TAG_NOISE: ReadonlySet<string> = new Set(["duringcreditsstinger", "aftercreditsstinger"]);

export function compactEntry(entry: CatalogEntry, shortId: string): CatalogEntry {
  return {
    ...entry,
    id: shortId,
    studios: entry.studios.slice(0, CATALOG_MAX_STUDIOS),
    tags: entry.tags.filter((tag) => !TAG_NOISE.has(tag.toLowerCase())).slice(0, CATALOG_MAX_TAGS),
  };
}

/** The model knows a well-known title from its name and year; an overview only
 * earns its tokens where that knowledge runs out: recent releases. */
export function wantsOverview(entry: CatalogEntry, options: RenderOptions): boolean {
  if (options.overviews === "all") return true;
  if (options.overviews === "none") return false;
  return entry.year !== undefined && entry.year >= options.year - options.recentYears;
}

export function renderCatalog(entries: CatalogEntry[], options: RenderOptions): RenderedCatalog {
  const idByShort = new Map<string, string>();
  const shortById = new Map<string, string>();
  const lines = entries.map((entry, index) => {
    const shortId = String(index + 1);
    idByShort.set(shortId, entry.id);
    shortById.set(entry.id, shortId);
    return renderEntry(compactEntry(entry, shortId), wantsOverview(entry, options));
  });
  return {
    text: lines.join("\n"),
    resolveId: (shortId) => idByShort.get(shortId.trim()),
    shortIdFor: (id) => shortById.get(id),
  };
}
