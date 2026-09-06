# jellyfin-curator

Every night, read the household's Jellyfin library, ask Claude to invent a handful of themed shelves from it ("Heists that go sideways", "Small towns with secrets"), and publish them as Jellyfin collections. Optionally the same shelves appear as rows on the web home screen through the Home Screen Sections plugin family.

Design: [docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md](docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md).

## What it costs

The shelves are planned by Claude through the Anthropic API, on your own key, so
each planning run costs you real money: about **$0.25 on `claude-sonnet-5` for a
1 000-item library**, scaling with the size of the library rather than the number
of shelves. `CURATOR_MIN_DAYS_BETWEEN_RUNS` is how you turn that into a monthly
figure — every four days is roughly $1.70 a month. Everything else (collections,
covers, home rows) is local and free. Every run logs its actual tokens and an
estimated cost, and `--dry-run` shows you the plan before anything is written.

## Quick start (Docker)

You need a Jellyfin server, an admin API key from it (Dashboard → API Keys), and
an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).

```bash
docker run --rm -v curator-data:/data \
  -e JELLYFIN_URL=http://jellyfin:8096 \
  -e JELLYFIN_API_KEY=<your jellyfin key> \
  -e ANTHROPIC_API_KEY=<your anthropic key> \
  ghcr.io/cocathey/jellyfin-curator run --dry-run
```

Read the `planned "..."` lines it prints. If they look right, drop `--dry-run`
and it writes the collections for real. Then put it on a schedule — a cron line
on the NAS, or `scripts/install-mac.sh` if a Mac is the always-on machine here.

That image is published by this repository's CI. To build it yourself instead:

```bash
git clone <this repo> && cd jellyfin-curator
docker compose build curator && docker compose run --rm curator run --dry-run
```

The container joins Jellyfin's own Docker network in the compose file, which is
why `http://jellyfin:8096` works; from anywhere else use the server's address.
The `/data` volume holds `state.json`, which is how the service knows which
collections are its own — keep it.

## How it works

1. Fetch every movie and series with genres, overview, people, studios, tags, plus per-user played and favourite flags aggregated into household counts.
2. Render a compact one-line-per-item catalog and ask `claude-opus-5` (structured output) for N shelves: title, blurb, member ids. More than `CURATOR_MAX_SHELVES_PER_CALL` at once is split into batches, each avoiding what the earlier ones produced.
3. Validate: unknown ids dropped, duplicates removed within the answer, size bounds enforced.
4. Retire the oldest shelves (default two per run, only once `CURATOR_SHELF_COUNT` shelves are live), create the new ones as collections tagged `jellyfin-curator`, save state after every write.
5. Give each new collection a cover built from its own members' artwork: the first member with a backdrop, blurred to fill a 2:3 poster, a sharp copy inset above the shelf title. No model, no external service, no tokens.
6. If `CURATOR_HOME_ROWS=true`, rewrite the Collection Sections slots `curator-shelf-1..N` and bust the Home Screen Sections cache.

Ownership is the state file (`/data/state.json`) plus the tag. Hand-made collections are never touched: only a `BoxSet` carrying the tag can be deleted.

## One-time setup

1. Jellyfin dashboard → API Keys → create a key named `jellyfin-curator`.
2. For home rows: Dashboard → Plugins → Repositories → add `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`, then install **File Transformation**, **Plugin Pages**, **Home Screen Sections** and **Collection Sections**; restart Jellyfin; enable Home Screen Sections in its plugin settings.
3. Copy `.env.example` to `.env` and fill in the keys.
4. First run from your machine, dry:

   ```bash
   JELLYFIN_URL=http://nas.local:8096 CURATOR_STATE_PATH=./curator-data/state.json pnpm curator run --dry-run
   ```

   Read the `planned "..."` lines. Then drop `--dry-run`.
5. Home rows: set `CURATOR_HOME_ROWS=true`, run again, then each user opens the hamburger menu → Modular Home and enables `curator-shelf-1` … `curator-shelf-N` once. Rotation reuses the ids.
6. Apple TV (and phones) via Streamyfin: install [Streamyfin](https://apps.apple.com/us/app/streamyfin/id6593660679) on the device, add its plugin repository `https://raw.githubusercontent.com/streamyfin/jellyfin-plugin-streamyfin/main/manifest.json` (Dashboard → Plugins → Catalog → settings icon → Add), install **Streamyfin** from the catalog, restart Jellyfin, then set `CURATOR_STREAMYFIN_ROWS=true` and run `pnpm curator rows --dry-run` followed by `pnpm curator rows`. The service keeps one horizontal row per shelf in the plugin's home layout (`Config.settings.home`), newest first, after any rows you wrote yourself; if the plugin had no layout yet it seeds Continue Watching, Next Up and Recently Added ahead of ours so the home screen keeps its basics. Swiftfin and Infuse cannot show collection rows.

## Commands

```bash
pnpm curator run [--dry-run] [--full-refresh] [--force]
pnpm curator status
pnpm curator rows [--dry-run]
pnpm curator covers [--dry-run] [--force]
pnpm curator retire-all --yes
```

`covers` gives every shelf that has no cover one, built from its members' backdrops: the backfill after enabling the feature, and the way a shelf whose cover failed mid-run catches up. `--force` rebuilds covers that already exist.

`rows` re-syncs the enabled home-row writers from the shelves already in state, without planning: run it right after installing a home-row plugin instead of paying for a rotation.

`retire-all` follows the tag, not just the state file: every collection
tagged `jellyfin-curator` is retired, including one you tagged by hand. Without
`--yes` it only reports what it would delete.

Exit codes: 0 ok, 1 failure, 2 Jellyfin unreachable or refused, 3 planner failed, 4 library too small.

## Deploy on the NAS

The `curator` service sits behind the `manual` profile (nothing should start on
`docker compose up`), so build it by name — a bare `docker compose build` skips
it. It also joins Jellyfin's existing Docker network as an external network:
confirm what that network is actually called before the first run, and edit
`compose.yml` if it is not `jellyfin_default`.

```bash
docker network ls                              # confirm Jellyfin's network name
docker compose build curator
docker compose run --rm curator run --dry-run
docker compose run --rm curator run
```

Daily at 04:00 on the NAS host crontab; `CURATOR_MIN_DAYS_BETWEEN_RUNS` in `.env` sets the real cadence (4 = every four days, which cron alone cannot express cleanly), and a too-soon tick exits 0 with one log line:

```
0 4 * * * cd /path/to/jellyfin-curator && docker compose run --rm curator run >> curator-data/cron.log 2>&1
```

## Run from a Mac (launchd)

If the NAS is not reachable for Docker, an always-on Mac can run the schedule. macOS lets a launchd-spawned process see but not read files on an external volume, so the checkout on the SSD cannot be what launchd runs; the installer puts a self-contained copy on the internal disk instead:

```bash
scripts/install-mac.sh
```

It builds, copies `dist/`, production `node_modules/`, `.env` and the launcher to `~/.local/share/jellyfin-curator/`, moves `curator-data/state.json` there once (that becomes the state's only home, and the checkout's `.env` is pointed at it so `pnpm curator status` stays truthful), writes `~/Library/LaunchAgents/dev.jellyfin-curator.schedule.plist` for a daily 04:00 tick, and loads it. `CURATOR_MIN_DAYS_BETWEEN_RUNS` in `.env` sets the real cadence. Re-run the installer after any source change. Log: `~/Library/Logs/jellyfin-curator.log`. A Mac asleep at 04:00 runs the tick on wake.

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `JELLYFIN_URL` | required | base URL, no trailing slash |
| `JELLYFIN_API_KEY` | required | admin API key |
| `ANTHROPIC_API_KEY` | required in Docker | resolved by the SDK; locally an `ant auth login` profile also works |
| `CURATOR_MODEL` | `claude-opus-5` | `claude-sonnet-5` for a run at about a third of the cost; `claude-haiku-4-5` only fits with overviews off |
| `CURATOR_SHELF_COUNT` | `6` | live shelves |
| `CURATOR_ROTATE_PER_RUN` | `2` | retired per run, once the live set is full |
| `CURATOR_ROW_COUNT` | `CURATOR_SHELF_COUNT` | home-screen rows (both writers), newest shelves first; a big shelf count with a small row count keeps the home screen short while the rest stay browsable under Collections |
| `CURATOR_MIN_ITEMS` / `CURATOR_MAX_ITEMS` | `8` / `20` | per shelf |
| `CURATOR_OVERVIEWS` | `recent` | `all`, `recent` (titles from the last 2 years keep their overview) or `none` |
| `CURATOR_SEASONAL_SHELVES` | `2` | shelves per run that must fit the time of year (season, weather, upcoming occasions); 0 disables |
| `CURATOR_MAX_SHELVES_PER_CALL` | `6` | most shelves in one planner call; a bigger ask (a catch-up run after raising the shelf count, or `--full-refresh`) is split into batches, because one answer of nineteen shelves overruns the model's output budget and fails |
| `CURATOR_COVERS` | `true` | build a poster for each new collection from its members' backdrops; costs no tokens |
| `CURATOR_HOME_ROWS` | `false` | write Collection Sections slots (web client rows) |
| `CURATOR_STREAMYFIN_ROWS` | `false` | keep six collection rows on the Streamyfin home screen (iOS, Android, Apple TV) |
| `CURATOR_CACHE_CATALOG` | `false` | mark the catalog for prompt caching; only worth it if shortfall retries turn out to be common |
| `CURATOR_MIN_DAYS_BETWEEN_RUNS` | `0` | with a daily cron, run for real only when the last run is at least this many days old; dry runs and `--force` ignore it |
| `CURATOR_STATE_PATH` | `/data/state.json` | |
| `CURATOR_LIBRARY_IDS` | all | comma-separated library ids |

## Cost

The catalog is the whole bill, sent in full every run. It is rendered compactly: a 1..N number instead of the 32-character id (mapped back in code), the first studio, five TMDb keywords with credits-stinger noise removed, and an overview only for titles from the last two years, the ones a model cannot know from name and year alone (`CURATOR_OVERVIEWS=all` restores every overview). Measured on a 1 007-item library: the full catalog was 225 k input tokens; the compact one is about 83 k, so one planner call is roughly $0.25 on `claude-sonnet-5` and $0.60 on `claude-opus-5`, output included. Every four days on Sonnet is about $1.70 a month; weekly about $1.10. Caching is off by default: runs are days apart, so a cache write (billed at 1.25x) only pays off when a second call follows within the window; set `CURATOR_CACHE_CATALOG=true` if the log shows shortfall retries are common. A batched run turns caching on by itself, so a catch-up run of nineteen shelves costs about one full catalog plus small change, not four. The run logs actual tokens with the cache split and an estimate priced for the configured model.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

No test touches the network. Fakes for Jellyfin, the planner and the state store live in `test/fakes/`.
