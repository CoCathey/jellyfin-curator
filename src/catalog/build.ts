import { CURATOR_TAG, OVERVIEW_MAX_CHARS } from "../constants.js";
import type { JellyfinItem } from "../jellyfin/types.js";

export interface WatchSignal {
  watchedBy: number;
  favoritedBy: number;
}

export interface CatalogEntry {
  id: string;
  kind: "M" | "S";
  title: string;
  year?: number;
  genres: string[];
  rating?: number;
  runtimeMin?: number;
  studios: string[];
  tags: string[];
  watchedBy: number;
  favoritedBy: number;
  overview: string;
}

/** Jellyfin runtimes are 100 ns ticks. */
const TICKS_PER_MINUTE = 600_000_000;

/** Per-user id lists in, per-item household counts out. A user counts once per item. */
export function aggregateSignals(playedPerUser: string[][], favoritedPerUser: string[][]): Map<string, WatchSignal> {
  const signals = new Map<string, WatchSignal>();
  const bump = (id: string, key: keyof WatchSignal): void => {
    const signal = signals.get(id) ?? { watchedBy: 0, favoritedBy: 0 };
    signal[key] += 1;
    signals.set(id, signal);
  };
  for (const ids of playedPerUser) for (const id of new Set(ids)) bump(id, "watchedBy");
  for (const ids of favoritedPerUser) for (const id of new Set(ids)) bump(id, "favoritedBy");
  return signals;
}

/** One line of prose, no pipes (the catalog column separator), capped. */
export function cleanOverview(text: string | null | undefined, max = OVERVIEW_MAX_CHARS): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return collapsed.length > max ? collapsed.slice(0, max).trimEnd() : collapsed;
}

function names(list: Array<{ Name?: string | null }> | null | undefined): string[] {
  return (list ?? []).map((entry) => (entry.Name ?? "").trim()).filter((name) => name.length > 0);
}

/** Deterministic: same items in any order give the same array, sorted by id. */
export function buildCatalog(items: JellyfinItem[], signals: Map<string, WatchSignal>): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const item of items) {
    if (item.Type !== "Movie" && item.Type !== "Series") continue;
    if (byId.has(item.Id)) continue;
    const signal = signals.get(item.Id) ?? { watchedBy: 0, favoritedBy: 0 };
    const entry: CatalogEntry = {
      id: item.Id,
      kind: item.Type === "Movie" ? "M" : "S",
      title: (item.Name ?? "").trim(),
      genres: (item.Genres ?? []).map((g) => g.trim()).filter((g) => g.length > 0),
      studios: names(item.Studios),
      tags: (item.Tags ?? []).filter((t) => t !== CURATOR_TAG),
      watchedBy: signal.watchedBy,
      favoritedBy: signal.favoritedBy,
      overview: cleanOverview(item.Overview),
    };
    if (typeof item.ProductionYear === "number") entry.year = item.ProductionYear;
    if (typeof item.CommunityRating === "number") entry.rating = Math.round(item.CommunityRating * 10) / 10;
    if (typeof item.RunTimeTicks === "number" && item.RunTimeTicks > 0) entry.runtimeMin = Math.round(item.RunTimeTicks / TICKS_PER_MINUTE);
    byId.set(item.Id, entry);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
