import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type Config } from "./config.js";
import { CURATOR_TAG } from "./constants.js";
import { writeHomeRowSlots } from "./homerows/slots.js";
import { writeStreamyfinRows } from "./homerows/streamyfin.js";
import { HttpJellyfinClient, JellyfinHttpError, type JellyfinClient } from "./jellyfin/client.js";
import { consoleLogger, type Logger } from "./log.js";
import { ClaudeShelfPlanner, PlannerError, type ShelfPlanner } from "./planner/planner.js";
import { writeCovers } from "./art/covers.js";
import { runCuration, type RunSummary } from "./run.js";
import { JsonFileStateStore, type StateStore } from "./state/store.js";
import { applyPlan } from "./sync/apply.js";
import { reconcileOwned } from "./sync/reconcile.js";

export type CliCommand =
  | { command: "run"; dryRun: boolean; fullRefresh: boolean; force: boolean }
  | { command: "status" }
  | { command: "rows"; dryRun: boolean }
  | { command: "covers"; dryRun: boolean; force: boolean }
  | { command: "retire-all"; yes: boolean }
  | { command: "help" };

export const EXIT = { ok: 0, failure: 1, jellyfin: 2, planner: 3, librarySmall: 4 } as const;

export const USAGE = `Usage: curator <command> [options]

Commands:
  run              plan, rotate and write collections (the nightly job)
    --dry-run        read everything, write nothing, print the plan
    --full-refresh   retire every live shelf and plan a full new set
    --force          run even if CURATOR_MIN_DAYS_BETWEEN_RUNS says it is too soon
  status           list the shelves this service owns
  rows             re-sync the home-row writers from state, no planning (add --dry-run to preview)
  covers           build a cover for every shelf that has none, from its members' backdrops
    --dry-run        say which member each cover would come from, write nothing
    --force          rebuild covers that already exist
  retire-all       delete every shelf this service owns (needs --yes)
  help             this text

Exit codes: 0 ok, 1 failure, 2 Jellyfin unreachable or refused, 3 planner failed, 4 library too small`;

export function parseCli(argv: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "full-refresh": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help === true || command === undefined || command === "help") return { command: "help" };
  switch (command) {
    case "run":
      return { command: "run", dryRun: values["dry-run"] === true, fullRefresh: values["full-refresh"] === true, force: values.force === true };
    case "status":
      return { command: "status" };
    case "rows":
      return { command: "rows", dryRun: values["dry-run"] === true };
    case "covers":
      return { command: "covers", dryRun: values["dry-run"] === true, force: values.force === true };
    case "retire-all":
      return { command: "retire-all", yes: values.yes === true };
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

/** Test seams. Production leaves every field undefined. */
export interface MainOverrides {
  client?: JellyfinClient;
  planner?: ShelfPlanner;
  store?: StateStore;
  now?: () => Date;
}

interface Runtime {
  config: Config;
  client: JellyfinClient;
  store: StateStore;
  now: () => Date;
  log: Logger;
  /** Lazy: only `run` needs an Anthropic client, so `status` works without a key. */
  planner: () => ShelfPlanner;
}

/** A missing or malformed key throws from the SDK constructor, before any
 * request. That is still "the planner could not run" (spec §8), so it exits 3
 * with a message rather than falling through to the catch-all exit 1. */
function anthropicClient(): Anthropic {
  try {
    return new Anthropic();
  } catch (err) {
    throw new PlannerError(`no usable Anthropic credentials: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: Logger = consoleLogger,
  overrides: MainOverrides = {},
): Promise<number> {
  let cmd: CliCommand;
  try {
    cmd = parseCli(argv);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    log.info(USAGE);
    return EXIT.failure;
  }
  if (cmd.command === "help") {
    log.info(USAGE);
    return EXIT.ok;
  }

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return EXIT.failure;
  }

  const runtime: Runtime = {
    config,
    client: overrides.client ?? new HttpJellyfinClient(config.JELLYFIN_URL, config.JELLYFIN_API_KEY),
    store: overrides.store ?? new JsonFileStateStore(config.CURATOR_STATE_PATH),
    now: overrides.now ?? ((): Date => new Date()),
    log,
    planner: () => overrides.planner ?? new ClaudeShelfPlanner(anthropicClient(), config.CURATOR_MODEL, { cacheCatalog: config.CURATOR_CACHE_CATALOG }),
  };

  try {
    return await dispatch(cmd, runtime);
  } catch (err) {
    if (err instanceof PlannerError) {
      log.error(`planner: ${err.message}`);
      return EXIT.planner;
    }
    if (err instanceof JellyfinHttpError || (err instanceof TypeError && /fetch/i.test(err.message))) {
      // Static, and the key never appears: from cron.log a 401 has to be
      // diagnosable as "wrong or expired JELLYFIN_API_KEY" without a rerun.
      log.error(`jellyfin: ${err.message} (url ${config.JELLYFIN_URL}, auth: Authorization: MediaBrowser Token="<redacted>" from JELLYFIN_API_KEY)`);
      return EXIT.jellyfin;
    }
    log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return EXIT.failure;
  }
}

async function dispatch(cmd: Exclude<CliCommand, { command: "help" }>, rt: Runtime): Promise<number> {
  switch (cmd.command) {
    case "status":
      return status(rt);
    case "rows":
      return rows(cmd.dryRun, rt);
    case "covers":
      return covers(cmd.dryRun, cmd.force, rt);
    case "retire-all":
      return retireAll(cmd.yes, rt);
    case "run": {
      const summary = await runCuration(
        { config: rt.config, client: rt.client, planner: rt.planner(), store: rt.store, log: rt.log, now: rt.now },
        { dryRun: cmd.dryRun, fullRefresh: cmd.fullRefresh, force: cmd.force },
      );
      return report(summary, rt.log);
    }
  }
}

async function status(rt: Runtime): Promise<number> {
  const state = await rt.store.load();
  if (state.shelves.length === 0) {
    rt.log.info("no shelves owned");
    return EXIT.ok;
  }
  const nowMs = rt.now().getTime();
  for (const shelf of state.shelves) {
    const ageDays = Math.floor((nowMs - Date.parse(shelf.createdAt)) / 86_400_000);
    const orphan = shelf.origin === "orphan" ? " (orphan)" : "";
    rt.log.info(`"${shelf.title}" — ${shelf.itemIds.length} items — ${ageDays}d — ${shelf.collectionId}${orphan}`);
  }
  if (state.lastRun) rt.log.info(`last run ${state.lastRun.at}: tokens in=${state.lastRun.inputTokens} out=${state.lastRun.outputTokens}`);
  return EXIT.ok;
}

/** Re-sync every enabled row writer from the shelves in state. No planner, no
 * collection writes: the way to light up rows after installing a plugin without
 * paying for a rotation. */
async function rows(dryRun: boolean, rt: Runtime): Promise<number> {
  if (!rt.config.CURATOR_HOME_ROWS && !rt.config.CURATOR_STREAMYFIN_ROWS) {
    rt.log.error("neither CURATOR_HOME_ROWS nor CURATOR_STREAMYFIN_ROWS is enabled; nothing to write");
    return EXIT.failure;
  }
  let state = await rt.store.load();
  const slotCount = rt.config.CURATOR_ROW_COUNT;
  if (rt.config.CURATOR_HOME_ROWS) {
    await writeHomeRowSlots(rt.client, state.shelves, { slotCount, dryRun }, rt.log);
  }
  if (rt.config.CURATOR_STREAMYFIN_ROWS) {
    const previousParentIds = state.streamyfin?.parentIds ?? [];
    const result = await writeStreamyfinRows(rt.client, state.shelves, { slotCount, dryRun, previousParentIds }, rt.log);
    if (result && !dryRun) {
      state = { ...state, streamyfin: { parentIds: result.parentIds } };
      await rt.store.save(state);
    }
  }
  return EXIT.ok;
}

/** Backfill: give every shelf in state a cover it does not have. Costs nothing
 * but time, so it is safe to run whenever, and it is how a shelf whose cover
 * failed mid-run catches up. */
async function covers(dryRun: boolean, force: boolean, rt: Runtime): Promise<number> {
  const state = await rt.store.load();
  const result = await writeCovers(rt.client, state.shelves, { dryRun, force }, rt.log);
  const already = result.skipped.filter((s) => s.reason === "already has a cover").length;
  rt.log.info(`${dryRun ? "[dry-run] " : ""}covered ${result.written}, ${already} already had one, ${result.skipped.length - already} could not be covered`);
  return EXIT.ok;
}

async function retireAll(yes: boolean, rt: Runtime): Promise<number> {
  // Ownership is the state file, but the tag is the recovery path (spec §6):
  // after a lost state file the collections are still out there, tagged, and
  // "retire everything you own" has to mean them too.
  const loaded = await rt.store.load();
  const tagged = await rt.client.queryItems({ includeItemTypes: ["BoxSet"], tags: [CURATOR_TAG], fields: ["Tags"] });
  const reconciled = reconcileOwned(loaded, tagged.map((t) => ({ Id: t.Id, Name: t.Name ?? t.Id })), rt.now());
  for (const s of reconciled.dropped) rt.log.warn(`state had "${s.title}" (${s.collectionId}) but Jellyfin does not; dropped`);
  for (const s of reconciled.adopted) rt.log.warn(`adopted tagged collection "${s.title}" (${s.collectionId}) not in state`);
  const state = reconciled.state;
  if (!yes) {
    rt.log.error(`would delete ${state.shelves.length} collections; re-run with --yes to confirm`);
    return EXIT.failure;
  }
  // Nothing is created here, so the create-collision guard has nothing to check.
  const applied = await applyPlan(
    rt.client,
    rt.store,
    state,
    { retire: state.shelves, create: [], existingCollectionIds: new Set<string>(), dryRun: false, now: rt.now },
    rt.log,
  );
  if (rt.config.CURATOR_HOME_ROWS) {
    await writeHomeRowSlots(rt.client, [], { slotCount: rt.config.CURATOR_ROW_COUNT, dryRun: false }, rt.log);
  }
  if (rt.config.CURATOR_STREAMYFIN_ROWS) {
    const previousParentIds = applied.state.streamyfin?.parentIds ?? [];
    const cleared = await writeStreamyfinRows(rt.client, [], { slotCount: rt.config.CURATOR_ROW_COUNT, dryRun: false, previousParentIds }, rt.log);
    if (cleared) {
      const forgotten = { ...applied.state };
      delete forgotten.streamyfin;
      await rt.store.save(forgotten);
    }
  }
  rt.log.info(`retired ${applied.report.retired.length}, skipped ${applied.report.skipped.length}`);
  return applied.report.skipped.length === 0 ? EXIT.ok : EXIT.failure;
}

function report(summary: RunSummary, log: Logger): number {
  if (summary.outcome === "too-soon") {
    log.info(`last run was ${summary.daysSinceLastRun.toFixed(1)} days ago, under CURATOR_MIN_DAYS_BETWEEN_RUNS=${summary.minDays}; skipping (use --force to run anyway)`);
    return EXIT.ok;
  }
  if (summary.outcome === "library-too-small") {
    log.error(
      `library has ${summary.catalogSize} movies/series but ${summary.required} are needed for the configured shelves; lower CURATOR_SHELF_COUNT or CURATOR_MIN_ITEMS`,
    );
    return EXIT.librarySmall;
  }
  for (const skipped of summary.skipped) log.warn(`skipped "${skipped.title}": ${skipped.reason}`);
  const covered = summary.covers === undefined ? "" : `, covered ${summary.covers.written}`;
  log.info(
    `summary: kept ${summary.kept.length}, retired ${summary.retired.length}, created ${summary.created.length}, skipped ${summary.skipped.length}${covered}`,
  );
  return EXIT.ok;
}
