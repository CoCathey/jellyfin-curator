# Jellyfin Curator — design

**Status:** approved direction, spec under review
**Date:** 2026-09-04
**Owner:** whoever runs the server

## 1. Purpose

A nightly service that reads the Jellyfin library on `the NAS`, asks Claude to
invent a small set of themed "shelves" from what is actually there, and
materialises them as Jellyfin collections. Optionally it also surfaces the same
collections as rows on the web client's home screen through the Home Screen
Sections plugin family.

Rule-based collection tools already exist (Kometa, smart-collection plugins).
This project exists for the part they cannot do: come up with a theme a person
would find clever ("Heists that go sideways", "Rainy-day 90s comfort"), and
pick the members from *this* library.

### In scope

- Movies and series (whole series, never individual episodes).
- Shared, library-wide shelves. One set for the household.
- Creating, refreshing, and retiring the collections it owns.
- Writing Collection Sections slots so the shelves appear as web home rows.
- Dry-run, status, and full-retire commands.

### Out of scope (deliberately)

- Per-user shelves. Jellyfin collections are global objects; per-user copies
  would clutter the Collections view for everyone.
- Custom poster art. Jellyfin's own BoxSet image provider builds a collage from
  members.
- Music, books, live TV.
- Rows on native TV clients. Only the web client renders plugin sections. The
  Apple TV on the network will see the collections in its Collections view
  only.
- A Jellyfin plugin in C#. Plugins are pinned to one server version each and
  Jellyfin 12 is at rc7; a REST-only service survives upgrades.

## 2. Environment facts (verified 2026-09-04)

| Fact | Value |
| --- | --- |
| Jellyfin | 10.11.10 on the household NAS, Docker, HTTP on 8096 |
| Collections API | `POST /Collections?name&ids`, `POST/DELETE /Collections/{id}/Items?ids`, `DELETE /Items/{id}` |
| Item query | `GET /Items?recursive=true&includeItemTypes=Movie,Series&fields=Genres,Overview,People,Tags,Studios,ProductionYear,...` returns `BaseItemDto` with `UserData` per requesting user |
| Plugin config | `GET/POST /Plugins/{pluginId}/Configuration` (JSON body) |
| Collection Sections plugin id | `043b2c48-b3e0-4610-b398-8217b146d1a4`; config is `{ Sections: [{ UniqueId, DisplayText, CollectionName, SectionType }] }`; saving config re-registers every section with Home Screen Sections in-process, no restart |
| Home Screen Sections | shows a section to a user only if that user's `EnabledSections` contains the section id; `POST /HomeScreen/BustCache` (admin) invalidates its 24 h section cache |
| Plugin versions for 10.11.10 | Home Screen Sections 2.5.11.0, Collection Sections 2.3.10.0, File Transformation 2.5.11.0, Plugin Pages 2.4.11.0, all from `https://www.iamparadox.dev/jellyfin/plugins/manifest.json` |
| Model | `claude-opus-5`, adaptive thinking, structured outputs via `client.messages.parse` + `zodOutputFormat` |

## 3. Architecture

Single Node 22 / TypeScript ESM package, `pnpm`, `vitest`, `eslint`, strict
`tsc`. No framework. One process, one run, exit. Scheduling is external
(container cron or host cron), so the process has no long-lived state.

```
src/
  cli.ts              parse args, load config, wire modules, run one command
  config.ts           env → typed Config (zod), fail fast on missing values
  jellyfin/
    client.ts         JellyfinClient interface + HttpJellyfinClient (fetch)
    types.ts          the handful of BaseItemDto fields we read
  catalog/
    build.ts          BaseItemDto[] → CatalogEntry[] (compact, deterministic)
    render.ts         CatalogEntry[] → prompt text, one line per item
  planner/
    schema.ts         zod schema for the model's answer
    prompt.ts         frozen system prompt + user message builder
    planner.ts        ShelfPlanner interface + ClaudeShelfPlanner
    validate.ts       drop unknown ids, enforce size bounds, dedupe
  state/
    store.ts          StateStore interface + JsonFileStateStore
    types.ts          State, OwnedShelf
  sync/
    rotate.ts         pure: (state, now, policy) → { keep, retire, wanted }
    apply.ts          plan + state → Jellyfin writes, returns new state
  homerows/
    slots.ts          write Collection Sections slots, bust HSS cache
  run.ts              orchestrates one run; the only place modules meet
test/                 vitest; fakes for JellyfinClient, ShelfPlanner, StateStore
```

**Boundaries that matter**

- `JellyfinClient` is the only thing that talks HTTP to Jellyfin. Everything
  else takes plain data. Tests use `FakeJellyfinClient` (in-memory items,
  collections, plugin config).
- `ShelfPlanner` is the only thing that talks to Claude. `ClaudeShelfPlanner`
  is one file; an Ollama adapter later is another file behind the same
  interface. Tests use `FakeShelfPlanner` returning canned plans.
- `rotate.ts` is pure and clock-injected. All retirement rules live there and
  are table-tested.
- `apply.ts` is the only writer. It receives a validated plan and returns the
  new state; it never decides *what* to build.

## 4. One run, step by step

1. **Load** config and state. Missing state file means first run.
2. **Fetch** all `Movie` and `Series` items, recursive, with the fields in §2,
   as the API-key user. Then, for watch signals, fetch the same ids per
   Jellyfin user with `userId` set, and aggregate `UserData.Played` /
   `IsFavorite` into `watchedBy` and `favoritedBy` counts. (One request per
   user; the household is small.)
3. **Fetch** existing BoxSets tagged `jellyfin-curator` and reconcile with
   state: anything in state but missing from Jellyfin is dropped from state;
   anything tagged but not in state is adopted into state as `orphan` and
   treated as retirable.
4. **Build** the catalog: one `CatalogEntry` per item, stable field order,
   sorted by id, so identical libraries render identical prompt text.
5. **Rotate**: `rotate()` decides which live shelves to keep, which to retire
   (oldest first, `CURATOR_ROTATE_PER_RUN` of them, or all if
   `--full-refresh`), and how many new shelves are wanted so the total equals
   `CURATOR_SHELF_COUNT`. The configured rotation applies only at capacity:
   below `CURATOR_SHELF_COUNT` the run only tops up, so raising the count fills
   the gap instead of retiring shelves to open slots that already exist.
   Overflow above the count, and orphans, are retired at any size.
6. **Plan**: `ShelfPlanner.plan({ catalog, wanted, avoidThemes })` where
   `avoidThemes` is the titles of live shelves plus the last 30 retired, and
   grows with every shelf accepted earlier in the run. At most
   `CURATOR_MAX_SHELVES_PER_CALL` shelves are asked for per call: one answer of
   nineteen overran the model's output budget and came back as a `max_tokens`
   failure with nothing to show, so a catch-up run (or `--full-refresh` at a
   large `CURATOR_SHELF_COUNT`) is split into batches. When a run will make more
   than one call the catalog block is cached whatever `CURATOR_CACHE_CATALOG`
   says: the second and later calls read it back at a tenth of the price.
   Returns `Shelf[]` (`title`, `blurb`, `itemIds[]`, `rationale`); the
   rationale is logged for review and never written to Jellyfin.
7. **Validate**: drop ids not in the catalog, dedupe, drop shelves that fall
   under `CURATOR_MIN_ITEMS` after cleaning, cap at `CURATOR_MAX_ITEMS`. Each
   answer is validated on its own, so a member is exclusive within one answer
   and no further: pooling a run's batches through one validation made each
   batch starve the next (six shelves lost to "too few valid members" on the
   first 25-shelf catch-up run), and exclusivity was never global anyway — a
   shelf from an earlier run may share titles with a new one. The planner is
   told which catalog numbers this run has already used, as a steer. If
   fewer than `wanted` survive after the batches, call the planner once more
   for the shortfall with the survivors added to `avoidThemes`. That retry asks
   for the seasonal minimum again (the dropped shelves may have been the
   seasonal ones); a batch spends the run's seasonal quota once. After the extra
   attempt, ship what survived and log the shortfall. Never loop: the run makes
   at most `ceil(wanted / CURATOR_MAX_SHELVES_PER_CALL) + 1` calls.
8. **Apply** (skipped in `--dry-run`, which prints the plan instead):
   1. Retire: for each shelf to retire, `GET /Items/{id}` and assert
      `Type === "BoxSet"` **and** tag present, then `DELETE /Items/{id}`.
      A failed assertion is logged and the shelf is left alone.
   2. Create: `POST /Collections?name=<title>&ids=<ids>` returns the new
      BoxSet id. Then `GET /Items/{id}` to fetch the full DTO (the update
      endpoint replaces fields wholesale, so never post a partial DTO), set
      `Tags: [...existing, "jellyfin-curator"]` and `Overview: <blurb>`, and
      `POST /Items/{id}` with the whole DTO. Record
      `{ collectionId, title, blurb, itemIds, createdAt }` in state.
   3. Save state **after each successful write** so a crash mid-run leaves
      state truthful.
9. **Covers** (when `CURATOR_COVERS=true`, the default): for each collection
   created this run, walk its members in planner order, take the first with a
   backdrop, and compose a 2:3 poster — the backdrop blurred and darkened to
   fill the frame, a rounded 16:9 copy inset, the shelf title beneath it — then
   `POST /Items/{id}/Images/Primary` with the JPEG base64-encoded in the body.
   Local composition only: no image model and no external service, so the
   feature costs nothing per run. A failure here is logged and left for
   `curator covers`, which backfills anything missing a cover.
10. **Home rows** (when `CURATOR_HOME_ROWS=true`): read Collection Sections
   config, keep every entry whose `UniqueId` does not start with
   `curator-shelf-`, then write slots `curator-shelf-1..N` (N =
   `CURATOR_ROW_COUNT`, which defaults to `CURATOR_SHELF_COUNT`) with
   `DisplayText = CollectionName = shelf title`,
   ordered newest first. When fewer than N shelves are live (a shortfall),
   only that many slots are written and the rest are omitted from the config,
   so no row points at a missing collection. `POST` the config, then `POST
   /HomeScreen/BustCache`. Slot ids are stable across runs on purpose: each user enables the N slots
   once in Modular Home settings, and rotation changes only what the slot
   shows.
11. **Report**: one summary line per shelf (kept / retired / created), covers
    written, token usage, and estimated cost.

## 5. The prompt and its contract

**System prompt** (frozen text, no dates or ids, so it is byte-stable):
the role ("you curate a family's personal media library"), what makes a good
shelf (specific, surprising, at least 8 members, mixes eras when the theme
allows, never a plain genre or "Best of"), hard rules (only ids from the
catalog, no episode ids, no duplicate members across the shelves in this
answer, titles under 40 characters, blurbs under 120), and the JSON shape.

**Catalog block** (second `system` block, carrying the cache breakpoint):
`Catalog (<n> items):` then the rendered catalog.

**User message**: the ask alone — `wanted`, the size bounds, and the
`avoidThemes` list. Everything volatile sits after the cache breakpoint so a
changed ask never invalidates the catalog. The bias against entries with high
`watchedBy` lives in the frozen system prompt.

**Catalog line format** (one item per line, pipe-separated, fixed order):

```
<id>|<M|S>|<title> (<year>)|<genres, comma>|<rating or ->|<runtime min or ->|<studios>|<tags>|w<watchedBy>f<favoritedBy>|<overview, first 160 chars>
```

Overview inclusion is a policy (`CURATOR_OVERVIEWS`: all, recent, none; default recent, meaning titles from the last two years)
because it is most of the token cost and most of the creative signal.

**Answer schema** (zod, via `zodOutputFormat`):

```ts
z.object({
  shelves: z.array(z.object({
    title: z.string(),
    blurb: z.string(),
    itemIds: z.array(z.string()),
    rationale: z.string(),   // one sentence, logged, never shown in Jellyfin
  })),
})
```

**Call shape**: `client.messages.parse({ model, max_tokens: 16000,
thinking: { type: "adaptive" }, output_config: { effort: "high", format:
zodOutputFormat(PlanSchema) }, system: [{ type: "text", text: SYSTEM }, {
type: "text", text: CATALOG_BLOCK, cache_control: { type: "ephemeral" } }],
messages: [{ role: "user", content: ASK }] })`. The breakpoint sits on the
second block, not the first: `SYSTEM` is ~356 tokens and the minimum cacheable
prefix is 512, so a breakpoint on it alone silently cached nothing. A `refusal`
stop reason or a null `parsed_output` is a planner error, surfaced as such.
Every `Anthropic.APIError` / `AnthropicError` is rethrown as a planner error
too, so the SDK's failures land on exit 3 rather than the catch-all (§8).

## 6. Ownership and safety guards

- **Ownership** is the state file. The `jellyfin-curator` tag is the recovery
  path if the state file is lost and a second check before any delete.
- **Delete guard**: only `Type === "BoxSet"` items carrying the tag are ever
  deleted, and only when they are in state (or adopted as orphans in step 3).
  Media files are never touched; deleting a BoxSet removes only Jellyfin's
  collection metadata folder.
- **Hand-made collections** are never tagged, never in state, and never
  deleted. They are *read*: every BoxSet is fetched once per run, and the
  names of untagged ones go into the planner's avoid list and the validator's
  avoid titles so a shelf can never take an existing name. As a backstop,
  `applyPlan` refuses to tag or record a `createCollection` result whose id
  already existed before the run (Jellyfin resolves a same-named create to
  the existing collection). Consequence: hand-made collection *names* are
  sent to the Anthropic API alongside the catalog; their members are not.
- **Home-row config merge** preserves every slot the service did not create.
- **Dry run** performs every read and no write, and prints what it would do.
- **Secrets** come from env only; the Jellyfin API key and Anthropic key are
  never logged. Catalog text (titles, overviews) is the only content sent to
  Anthropic; file paths are never fetched.

## 7. Rotation policy and state

```ts
type State = {
  version: 1;
  shelves: OwnedShelf[];          // live
  retired: { title: string; retiredAt: string }[];  // last 30, for avoidThemes
  lastRun?: { at: string; inputTokens: number; outputTokens: number };
};
type OwnedShelf = {
  collectionId: string;
  title: string;
  blurb: string;
  itemIds: string[];
  createdAt: string;              // ISO, from injected clock
  origin: "planned" | "orphan";
};
```

`rotate(state, now, policy)` returns `{ keep, retire, wanted }`:

- Orphans retire first, then the oldest by `createdAt`.
- Default policy: `shelfCount = 6`, `rotatePerRun = 2`, so a shelf lives about
  three nights. `--full-refresh` retires everything. Shelf life scales with the
  count: at `shelfCount = 25` and one run every four days a shelf lives about
  six months, which is why the home screen shows only the newest
  `CURATOR_ROW_COUNT` of them.
- Rotation happens only when the live set is at `shelfCount`; below it the run
  tops up and retires nothing (overflow and orphans excepted).
- On first run `wanted = shelfCount`.
- If the library has fewer than `shelfCount * minItems` items the run stops
  before calling the planner with a clear message.

## 8. Error handling

| Failure | Behaviour |
| --- | --- |
| Jellyfin unreachable / 401 | exit 2 before any write, message names the URL and the header used |
| Planner API error (429, 5xx) | SDK retries twice; then exit 3, state untouched, nothing retired |
| Planner refusal or unparsable answer | exit 3, same as above |
| Fewer shelves than wanted after validation and one retry | proceed with what survived, warn |
| A single create fails | log, skip that shelf, continue; state saved per write |
| A single retire fails its guard | log loudly, leave the collection, continue |
| Home-row write fails | warn; collections already exist, rows catch up next run |

Retirement happens **after** planning succeeds, never before, so a planner
outage cannot leave the home screen emptier than it was.

## 9. Cost, honestly

Prompt caching has a one-hour ceiling, and runs are 24 hours apart, so the
catalog is paid for on every run. Caching only helps the second planner call
within a run — which is exactly why the breakpoint moved onto the catalog block
(§5): the frozen system prompt is too short to cache, so before that move a
shortfall run paid full price for the catalog twice. Estimate at Opus 5 list
price ($5 / M input, $25 / M output; cache writes 1.25x input, cache reads
0.1x):

| Library size | Tokens/run (with overviews) | Cost/run |
| --- | --- | --- |
| 1 007 items (measured 2026-09-05, the NAS) | 226 k in, 2.2 k out | $1.47 |
| 3 000 items (extrapolated) | ~675 k in | ~$4.40 |

The first estimate of ~90 k tokens per 1 000 items was three times too low:
Jellyfin overviews run longer than 160 characters of prose suggested and the
per-line metadata adds up. Without overviews the catalog is roughly a
quarter of that.

Plus a few thousand output tokens. The run logs `usage` and a cost estimate so
the real number replaces this table after the first night. Levers if it
matters: `CURATOR_OVERVIEWS=none`, run weekly instead of nightly, or
lower `effort`. Model choice stays `claude-opus-5` unless the operator changes it.

## 10. Testing

Test-driven throughout. No network in tests, injected clock, fixed ids.

- `catalog/`: same items in any order render byte-identical text; overview
  truncation; missing fields render `-`.
- `planner/validate.ts`: unknown ids dropped, dedupe, min/max bounds, shortfall
  reported.
- `sync/rotate.ts`: table-driven over (live shelves × policy × clock) including
  first run, orphans first, full refresh, small-library stop.
- `sync/apply.ts` against `FakeJellyfinClient`: creates, tags, retires only
  guarded items, saves state after each write, dry-run writes nothing.
- `homerows/slots.ts`: preserves foreign slots, writes N stable ids, busts
  cache, tolerates missing plugin (404) with a warning.
- `planner/planner.ts`: one test with a mocked SDK client asserting the request
  shape (model, `output_config.format`, cached system block) and that a null
  `parsed_output` becomes a planner error. Not a live API test.
- `run.ts`: one end-to-end test with all fakes covering first run and a
  rotation run.
- Manual integration: `pnpm curator run --dry-run` against `the NAS` before
  the first real run, then a real run watched in the Jellyfin dashboard.

`pnpm typecheck lint test` is the definition of done for every task.

## 11. Deployment

- `Dockerfile` (node:22-alpine, `pnpm install --prod`, `node dist/cli.js`).
- `compose.yml` fragment for the NAS: image, `env_file: .env`, volume
  `./curator-data:/data` for `state.json`, no ports, joins Jellyfin's Docker
  network so `JELLYFIN_URL=http://jellyfin:8096` works without a VPN.
- Schedule: a `cron` line on the NAS host runs `docker compose run --rm
  curator run` nightly at 04:00. Simpler than a scheduler inside the container
  and visible in one place.
- Local dev runs against the server's address on the LAN or VPN.

**Config (env)**

| Var | Default | Meaning |
| --- | --- | --- |
| `JELLYFIN_URL` | required | base URL, no trailing slash |
| `JELLYFIN_API_KEY` | required | admin API key |
| `ANTHROPIC_API_KEY` | required | or an `ant auth` profile |
| `CURATOR_MODEL` | `claude-opus-5` | |
| `CURATOR_SHELF_COUNT` | `6` | live shelves |
| `CURATOR_ROTATE_PER_RUN` | `2` | retired per run, once the set is full |
| `CURATOR_ROW_COUNT` | `CURATOR_SHELF_COUNT` | home-screen rows, newest shelves first |
| `CURATOR_MIN_ITEMS` / `CURATOR_MAX_ITEMS` | `8` / `20` | per shelf |
| `CURATOR_OVERVIEWS` | `recent` | all, recent (last two years), none |
| `CURATOR_SEASONAL_SHELVES` | `2` | shelves that must fit the time of year; 0 disables |
| `CURATOR_MAX_SHELVES_PER_CALL` | `6` | most shelves per planner call; a bigger ask is split into batches |
| `CURATOR_COVERS` | `true` | compose collection posters from member backdrops (no tokens) |
| `CURATOR_HOME_ROWS` | `false` | write Collection Sections slots |
| `CURATOR_STREAMYFIN_ROWS` | `false` | keep collection rows on the Streamyfin home layout (Apple TV, phones) |
| `CURATOR_CACHE_CATALOG` | `false` | cache the catalog block; a write bills at 1.25x and only pays on a shortfall retry |
| `CURATOR_MIN_DAYS_BETWEEN_RUNS` | `0` | pacing for a daily cron; a too-soon real run exits 0 |
| `CURATOR_STATE_PATH` | `/data/state.json` | |
| `CURATOR_LIBRARY_IDS` | all | optional comma list of library ids to include |

**CLI**: `curator run [--dry-run] [--full-refresh]`, `curator status`,
`curator retire-all [--yes]`.

## 12. Manual steps for the operator (once)

1. Jellyfin dashboard → API Keys → create one for "jellyfin-curator".
2. Dashboard → Plugins → Repositories → add
   `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`; install File
   Transformation, Plugin Pages, Home Screen Sections, Collection Sections;
   restart Jellyfin.
3. Home Screen Sections plugin settings → enable the plugin.
4. After the first real run with `CURATOR_HOME_ROWS=true`, each user opens
   the hamburger menu → Modular Home and enables `curator-shelf-1..6`. Done
   once; rotation reuses the ids.
5. Put the two keys in `.env` on the NAS; add the cron line.

Step 4 could later be automated with the plugin's per-user settings endpoint
(`POST /ModularHomeViews/UserSettings`); left out until the manual path is
proven.

## 13. Defaults chosen without asking

- Shared shelves, not per-user (reasoning in §1).
- Six shelves, two rotated nightly. Both are env vars.
- No visible name prefix on collections; the tag and state carry ownership.
- Whole series only; episodes are never members.
- Watch signals are aggregate counts, used as a soft bias in the prompt, not a
  filter.
- The first run pays for a full plan; there is no "seed from existing
  collections" step.

## 14. Later, if wanted

- Ollama adapter behind `ShelfPlanner`.
- Auto-enable slots for every user.
- A "pin this shelf" tag that exempts a collection from rotation.
- Per-library shelf quotas (e.g. always one TV shelf).
