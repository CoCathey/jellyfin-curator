import { aggregateSignals, buildCatalog, type CatalogEntry } from "./catalog/build.js";
import { renderCatalog } from "./catalog/render.js";
import type { Config } from "./config.js";
import { CATALOG_RECENT_YEARS, CURATOR_TAG, priceFor } from "./constants.js";
import { writeCovers, type CoverWriteResult } from "./art/covers.js";
import { writeHomeRowSlots, type SlotWriteResult } from "./homerows/slots.js";
import { writeStreamyfinRows, type StreamyfinWriteResult } from "./homerows/streamyfin.js";
import type { JellyfinClient } from "./jellyfin/client.js";
import type { ItemKind, JellyfinItem } from "./jellyfin/types.js";
import type { Logger } from "./log.js";
import type { PlanUsage, ShelfPlanner } from "./planner/planner.js";
import type { Shelf } from "./planner/schema.js";
import { describeSeason } from "./planner/season.js";
import { validatePlan, type ValidationResult } from "./planner/validate.js";
import type { StateStore } from "./state/store.js";
import type { OwnedShelf } from "./state/types.js";
import { applyPlan } from "./sync/apply.js";
import { reconcileOwned } from "./sync/reconcile.js";
import { rotate } from "./sync/rotate.js";

export interface RunOptions {
  dryRun: boolean;
  fullRefresh: boolean;
  /** Ignore CURATOR_MIN_DAYS_BETWEEN_RUNS. */
  force?: boolean;
}

export interface RunDeps {
  config: Config;
  client: JellyfinClient;
  planner: ShelfPlanner;
  store: StateStore;
  log: Logger;
  now: () => Date;
}

export type RunSummary =
  | {
      outcome: "completed";
      kept: string[];
      retired: string[];
      created: string[];
      skipped: { title: string; reason: string }[];
      usage: PlanUsage;
      estimatedCostUsd: number;
      covers?: CoverWriteResult;
      homeRows?: SlotWriteResult;
      streamyfinRows?: StreamyfinWriteResult;
    }
  | { outcome: "library-too-small"; catalogSize: number; required: number }
  | { outcome: "too-soon"; daysSinceLastRun: number; minDays: number };

const LIBRARY_TYPES: ItemKind[] = ["Movie", "Series"];
/** ProductionYear, CommunityRating and RunTimeTicks are in the default DTO; these are not. */
const CATALOG_FIELDS = ["Genres", "Overview", "People", "Tags", "Studios"];

/** inputTokens is the billed total, so the uncached share is what is left after
 * the cached slices are priced at their own rates. */
export function estimateCostUsd(usage: PlanUsage, model = "claude-opus-5"): number {
  const rate = priceFor(model);
  const uncached = usage.inputTokens - usage.cacheCreationInputTokens - usage.cacheReadInputTokens;
  const usd =
    uncached * rate.input +
    usage.cacheCreationInputTokens * rate.cacheWrite +
    usage.cacheReadInputTokens * rate.cacheRead +
    usage.outputTokens * rate.output;
  return usd / 1_000_000;
}

const NO_USAGE: PlanUsage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };

function addUsage(a: PlanUsage, b: PlanUsage): PlanUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

async function fetchLibrary(client: JellyfinClient, libraryIds: string[]): Promise<JellyfinItem[]> {
  if (libraryIds.length === 0) return client.queryItems({ includeItemTypes: LIBRARY_TYPES, fields: CATALOG_FIELDS });
  const perLibrary = await Promise.all(
    libraryIds.map((parentId) => client.queryItems({ includeItemTypes: LIBRARY_TYPES, fields: CATALOG_FIELDS, parentId })),
  );
  return perLibrary.flat();
}

/** Two small queries per user (played, favourited) instead of the whole library per user. */
async function fetchSignals(client: JellyfinClient, log: Logger): Promise<ReturnType<typeof aggregateSignals>> {
  const users = await client.listUsers();
  const played: string[][] = [];
  const favorited: string[][] = [];
  for (const user of users) {
    played.push((await client.queryItems({ includeItemTypes: LIBRARY_TYPES, userId: user.Id, isPlayed: true })).map((i) => i.Id));
    favorited.push((await client.queryItems({ includeItemTypes: LIBRARY_TYPES, userId: user.Id, isFavorite: true })).map((i) => i.Id));
  }
  log.info(`watch signals from ${users.length} users`);
  return aggregateSignals(played, favorited);
}

function logValidation(result: ValidationResult, log: Logger): void {
  if (result.unknownIds > 0) log.warn(`dropped ${result.unknownIds} ids the planner invented`);
  for (const dropped of result.dropped) log.warn(`dropped shelf "${dropped.title}": ${dropped.reason}`);
}

function logShelves(shelves: Shelf[], catalog: CatalogEntry[], log: Logger): void {
  const titleOf = new Map(catalog.map((entry) => [entry.id, entry.title]));
  for (const shelf of shelves) {
    const members = shelf.itemIds.map((id) => titleOf.get(id) ?? id).join(", ");
    log.info(`planned "${shelf.title}": ${shelf.blurb} [${shelf.itemIds.length}] ${members} — ${shelf.rationale}`);
  }
}

export async function runCuration(deps: RunDeps, options: RunOptions): Promise<RunSummary> {
  const { config, client, planner, store, log, now } = deps;

  const info = await client.getSystemInfo();
  log.info(`connected to ${info.ServerName ?? "Jellyfin"} ${info.Version ?? ""}${options.dryRun ? " (dry run)" : ""}`.trim());

  const loaded = await store.load();
  // Pacing lives here rather than in cron because "every N days" does not fit a
  // crontab and a missed night should not slip the schedule. Dry runs and
  // --force are exempt: neither is the scheduled job.
  const minDays = config.CURATOR_MIN_DAYS_BETWEEN_RUNS;
  if (!options.dryRun && !options.force && minDays > 0 && loaded.lastRun) {
    const daysSinceLastRun = (now().getTime() - Date.parse(loaded.lastRun.at)) / 86_400_000;
    if (daysSinceLastRun < minDays) return { outcome: "too-soon", daysSinceLastRun, minDays };
  }
  const items = await fetchLibrary(client, config.CURATOR_LIBRARY_IDS);
  const signals = await fetchSignals(client, log);
  // One query for every BoxSet, ours and the household's own. The foreign ones never enter
  // state, but their names must reach the planner: Jellyfin resolves a create
  // by name onto an existing collection, so a repeated title would capture it.
  const boxSets = await client.queryItems({ includeItemTypes: ["BoxSet"], fields: ["Tags"] });
  const tagged = boxSets.filter((b) => (b.Tags ?? []).includes(CURATOR_TAG));
  const foreignTitles = boxSets.filter((b) => !(b.Tags ?? []).includes(CURATOR_TAG)).map((b) => b.Name ?? b.Id);
  const existingCollectionIds = new Set(boxSets.map((b) => b.Id));
  const reconciled = reconcileOwned(loaded, tagged.map((t) => ({ Id: t.Id, Name: t.Name ?? t.Id })), now());
  for (const s of reconciled.dropped) log.warn(`state had "${s.title}" (${s.collectionId}) but Jellyfin does not; dropped`);
  for (const s of reconciled.adopted) log.warn(`adopted tagged collection "${s.title}" (${s.collectionId}) not in state; it will be retired`);
  const state = reconciled.state;

  const catalog = buildCatalog(items, signals);
  const required = config.CURATOR_SHELF_COUNT * config.CURATOR_MIN_ITEMS;
  if (catalog.length < required) return { outcome: "library-too-small", catalogSize: catalog.length, required };
  log.info(`catalog: ${catalog.length} items`);

  const decision = rotate(state, {
    shelfCount: config.CURATOR_SHELF_COUNT,
    rotatePerRun: config.CURATOR_ROTATE_PER_RUN,
    fullRefresh: options.fullRefresh,
  });
  const catalogIds = new Set(catalog.map((entry) => entry.id));
  const avoidThemes = [...decision.keep, ...decision.retire]
    .map((s) => s.title)
    .concat(state.retired.map((r) => r.title))
    .concat(foreignTitles);
  let usage: PlanUsage = NO_USAGE;
  let newShelves: Shelf[] = [];

  if (decision.wanted > 0) {
    const rendered = renderCatalog(catalog, { overviews: config.CURATOR_OVERVIEWS, recentYears: CATALOG_RECENT_YEARS, year: now().getUTCFullYear() });
    const catalogText = rendered.text;
    // The catalog shows 1..N numbers, so the answer comes back in numbers; anything
    // that is not a known number stays as-is and validatePlan drops it as unknown.
    const toJellyfinIds = (shelves: Shelf[]): Shelf[] => shelves.map((s) => ({ ...s, itemIds: s.itemIds.map((id) => rendered.resolveId(id) ?? id) }));
    const bounds = { minItems: config.CURATOR_MIN_ITEMS, maxItems: config.CURATOR_MAX_ITEMS };
    // Season goes in the volatile ask, after the cache breakpoint, so the
    // catalog block stays a stable prefix from one night to the next.
    const seasonContext = describeSeason(now());
    // A big ask does not fit one answer: nineteen shelves overran the model's
    // output budget and came back as a max_tokens failure with nothing to show,
    // so the run is split into batches and the catalog is cached across them
    // (every call after the first reads it back at a tenth of the price).
    const batchSize = config.CURATOR_MAX_SHELVES_PER_CALL;
    const batches = Math.ceil(decision.wanted / batchSize);
    const cacheCatalog = config.CURATOR_CACHE_CATALOG || batches > 1;
    // One extra call beyond the batches, for the shortfall the batches leave. Never loop.
    const maxCalls = batches + 1;
    let seasonalLeft = Math.min(config.CURATOR_SEASONAL_SHELVES, decision.wanted);
    // Each answer is validated on its own, so a member is exclusive within one
    // answer and no further. Validating a whole run at once starved the later
    // batches: six good shelves were dropped for "too few valid members" because
    // earlier batches had claimed their titles. Exclusivity was never global
    // anyway — a shelf from a previous run may share titles with a new one — and
    // the planner is told what this run has already used so overlap stays rare.
    let accepted: Shelf[] = [];

    for (let call = 0; call < maxCalls && accepted.length < decision.wanted; call += 1) {
      const missing = decision.wanted - accepted.length;
      const isRetry = call >= batches;
      const wanted = isRetry ? missing : Math.min(missing, batchSize);
      // A batch adds shelves, so it spends from the run's seasonal quota. A retry
      // replaces shelves that were dropped, and nothing says the dropped ones were
      // not the seasonal ones, so it asks for the season again.
      const seasonalMin = isRetry ? Math.min(config.CURATOR_SEASONAL_SHELVES, wanted) : Math.min(seasonalLeft, wanted);
      if (isRetry) log.warn(`planner returned ${accepted.length}/${decision.wanted} usable shelves; asking once more for ${wanted}`);
      else if (batches > 1) log.info(`planning batch ${call + 1}/${batches} (${wanted} shelves)`);
      const answer = await planner.plan({
        catalogText,
        wanted,
        avoidThemes: [...avoidThemes, ...accepted.map((s) => s.title)],
        seasonContext,
        seasonalMin,
        usedItemIds: accepted.flatMap((s) => s.itemIds).flatMap((id) => rendered.shortIdFor(id) ?? []),
        cacheCatalog,
        ...bounds,
      });
      if (!isRetry) seasonalLeft -= seasonalMin;
      usage = addUsage(usage, answer.usage);
      const fresh = validatePlan(toJellyfinIds(answer.shelves), catalogIds, { ...bounds, avoidTitles: [...avoidThemes, ...accepted.map((s) => s.title)] });
      logValidation(fresh, log);
      accepted = [...accepted, ...fresh.shelves];
    }
    if (accepted.length < decision.wanted) log.warn(`still short: ${accepted.length}/${decision.wanted}; shipping what survived`);
    newShelves = accepted.slice(0, decision.wanted);
    logShelves(newShelves, catalog, log);
  }

  // Retiring is only worth it in exchange for something new. If the planner gave
  // us nothing usable across both calls, the shelves due to retire get a reprieve
  // rather than the home screen getting emptier for no reason. Orphans still go:
  // they are ours by tag alone, were never planned, and rotation owes them nothing.
  const plannedNothing = decision.wanted > 0 && newShelves.length === 0;
  const reprieved = plannedNothing ? decision.retire.filter((s) => s.origin !== "orphan") : [];
  const toRetire = plannedNothing ? decision.retire.filter((s) => s.origin === "orphan") : decision.retire;
  const keptShelves = [...decision.keep, ...reprieved];
  if (reprieved.length > 0) {
    const names = reprieved.map((s) => `"${s.title}"`).join(", ");
    log.warn(`no usable shelves came back; keeping ${names} rather than shrinking the home screen for nothing`);
  }

  // applyPlan logs its own retired/created lines; these complete the per-shelf
  // report spec §4.10 asks for.
  for (const shelf of keptShelves) log.info(`kept "${shelf.title}"`);

  const applied = await applyPlan(
    client,
    store,
    state,
    { retire: toRetire, create: newShelves, existingCollectionIds, dryRun: options.dryRun, now },
    log,
  );
  let finalState = applied.state;
  if (!options.dryRun) {
    // The state schema records the two totals only; the cache split is a
    // property of one call, not something the next run needs.
    finalState = { ...finalState, lastRun: { at: now().toISOString(), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
    await store.save(finalState);
  }

  // A dry run never mutates state, so finalState.shelves is still the pre-run live set.
  // Project what a real run would end up with — kept shelves plus the newly planned ones —
  // so the dry-run preview matches what would actually be written.
  const shelvesForHomeRows: OwnedShelf[] = options.dryRun
    ? [
        ...keptShelves,
        ...newShelves.map(
          (shelf): OwnedShelf => ({
            collectionId: "(dry-run)",
            title: shelf.title,
            blurb: shelf.blurb,
            itemIds: [...shelf.itemIds],
            createdAt: now().toISOString(),
            origin: "planned",
          }),
        ),
      ]
    : finalState.shelves;

  // Covers come from the members' own artwork, so they cost nothing and only the
  // new shelves need one. A shelf whose cover failed is picked up by `curator covers`.
  let covers: CoverWriteResult | undefined;
  if (config.CURATOR_COVERS) {
    if (options.dryRun) {
      // Nothing was created, so there is no collection to read back or write to.
      log.info(`[dry-run] would build ${newShelves.length} covers from member backdrops`);
      covers = { written: newShelves.length, skipped: [] };
    } else {
      const fresh = finalState.shelves.filter((s) => applied.report.created.some((c) => c.collectionId === s.collectionId));
      try {
        covers = await writeCovers(client, fresh, { dryRun: false, force: false }, log);
      } catch (err) {
        log.warn(`covers not written: ${err instanceof Error ? err.message : String(err)}; run "curator covers" to catch up`);
      }
    }
  }

  let homeRows: SlotWriteResult | undefined;
  if (config.CURATOR_HOME_ROWS) {
    try {
      homeRows = await writeHomeRowSlots(client, shelvesForHomeRows, { slotCount: config.CURATOR_ROW_COUNT, dryRun: options.dryRun }, log);
    } catch (err) {
      // Collections are already written; rows catch up on the next run (spec §8).
      log.warn(`home rows not written: ${err instanceof Error ? err.message : String(err)}; collections exist, rows catch up next run`);
    }
  }

  let streamyfinRows: StreamyfinWriteResult | undefined;
  if (config.CURATOR_STREAMYFIN_ROWS) {
    try {
      streamyfinRows = await writeStreamyfinRows(
        client,
        shelvesForHomeRows,
        { slotCount: config.CURATOR_ROW_COUNT, dryRun: options.dryRun, previousParentIds: finalState.streamyfin?.parentIds ?? [] },
        log,
      );
      if (streamyfinRows && !options.dryRun) {
        finalState = { ...finalState, streamyfin: { parentIds: streamyfinRows.parentIds } };
        await store.save(finalState);
      }
    } catch (err) {
      log.warn(`Streamyfin rows not written: ${err instanceof Error ? err.message : String(err)}; collections exist, rows catch up next run`);
    }
  }

  const estimatedCostUsd = estimateCostUsd(usage, config.CURATOR_MODEL);
  log.info(
    `tokens in=${usage.inputTokens} (cache write ${usage.cacheCreationInputTokens}, read ${usage.cacheReadInputTokens}) out=${usage.outputTokens} (~$${estimatedCostUsd.toFixed(2)} at ${config.CURATOR_MODEL} list price)`,
  );
  return {
    outcome: "completed",
    kept: keptShelves.map((s) => s.title),
    retired: applied.report.retired,
    created: applied.report.created.map((c) => c.title),
    skipped: applied.report.skipped,
    usage,
    estimatedCostUsd,
    covers,
    homeRows,
    streamyfinRows,
  };
}
