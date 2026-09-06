# jellyfin-curator — agent guide

Nightly service: read the Jellyfin library, ask Claude for themed shelves, write them as tagged collections, optionally expose them as web home rows. Design: `docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md`. Plan that built it: `docs/superpowers/plans/2026-09-04-jellyfin-curator.md`.

---

## If you were asked to install this

You are setting up a service on someone's server, not developing it: run the published container. Everything below the next divider is for changing the code, and you do not need a checkout, Node or pnpm to install.

**Get from the human before you start. Do not guess, and do not work around a missing one.**

1. The Jellyfin base URL that will be reachable *from where the container runs*.
2. A Jellyfin API key: their Dashboard → API Keys → new key. You cannot create this yourself.
3. An Anthropic API key from console.anthropic.com. **This spends their money — about $0.25 per planning run at a 1 000-item library, billed to them.** Say that in plain terms and get an explicit yes before the first real run. A dry run costs the same as a real one, because the planning call is the bill.

**Where it runs:** any machine with Docker that can reach Jellyfin. On a NAS that means shell access (SSH is often disabled by default) or their Docker UI. If you cannot reach the NAS, say so and stop — a half-installed service that silently never runs is worse than an honest "I can't get in from here".

**Steps**

```bash
docker network ls                     # find Jellyfin's network if the container will share it
docker run --rm -v curator-data:/data \
  -e JELLYFIN_URL=... -e JELLYFIN_API_KEY=... -e ANTHROPIC_API_KEY=... \
  ghcr.io/cocathey/jellyfin-curator run --dry-run
```

Show the human the `planned "..."` lines and let them judge the shelves before you write anything — that is the whole point of the dry run. Then drop `--dry-run`. Then schedule it:

```bash
0 4 * * * docker run --rm -v curator-data:/data --env-file /path/to/curator.env ghcr.io/cocathey/jellyfin-curator run
```

Put the keys in an `--env-file` with `chmod 600`, never inline in the crontab, and never in a file you commit. `CURATOR_MIN_DAYS_BETWEEN_RUNS=4` with a nightly cron means it only actually spends money every fourth night; the other nights exit 0 after one log line.

**Verify before you claim it works:** `... jellyfin-curator status` lists the shelves, the collections appear in Jellyfin under Collections with cover art, and the run logged its token count and estimated cost. Exit codes: 0 ok, 1 failure, 2 Jellyfin unreachable or refused, 3 planner failed, 4 library too small.

**Do not:** run `retire-all` (it deletes every collection this service owns); raise `CURATOR_SHELF_COUNT` past a handful without telling them what the catch-up run will cost; or touch collections the service did not create — it only ever deletes a `BoxSet` carrying its own `jellyfin-curator` tag, and that guarantee is the reason people trust it near their libraries.

Settings worth offering: `CURATOR_SHELF_COUNT` (live collections), `CURATOR_ROTATE_PER_RUN` (replaced per run), `CURATOR_MIN_DAYS_BETWEEN_RUNS` (real cadence). Full table in the README. Home-screen rows for the web client and for Streamyfin on Apple TV are optional extras, documented there too, and each needs a plugin installed first.

---

## Working on the project

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # definition of done; see the output before claiming done
pnpm curator run --dry-run                 # needs JELLYFIN_URL + JELLYFIN_API_KEY (see .env.example)
pnpm build && node dist/bin.js help        # what Docker runs
```

## Layout

- `src/run.ts` is the only place modules meet. Read it first.
- Seams: `JellyfinClient` (`src/jellyfin/client.ts`), `ShelfPlanner` (`src/planner/planner.ts`), `StateStore` (`src/state/store.ts`). Each has a fake in `test/fakes/`.
- Pure logic: `src/catalog/*`, `src/planner/validate.ts`, `src/sync/reconcile.ts`, `src/sync/rotate.ts`. Test these with tables, not mocks.
- `src/sync/apply.ts` is the only writer of collections (`src/homerows/slots.ts` also writes, but only plugin config).

## Invariants (and why)

- Only a `Type === "BoxSet"` item carrying the `jellyfin-curator` tag is ever deleted, and only when it is in state or was adopted as an orphan this run. The tag plus the state file is how we tell our collections from the ones a person made by hand; a bug here deletes someone's curation.
- Item reads (`GET /Items/{id}`) carry an administrator's `userId`. Jellyfin 10.11 throws "Guid can't be empty" for an API key without one; `HttpJellyfinClient` resolves the id once per process. Collection queries and updates do not need it.
- Never POST a partial DTO to `/Items/{id}`. Jellyfin replaces fields wholesale, so a partial body silently blanks metadata. GET, modify, POST the whole object (`applyPlan` does this).
- The catalog the planner sees is compact (`src/catalog/render.ts`): 1..N numbers instead of Jellyfin ids, first studio, five clean keywords, overviews only for recent titles. `run.ts` maps the numbers back before validation; nothing downstream ever sees a short id.
- Streamyfin rows (`src/homerows/streamyfin.ts`) have no ids, so ours are recognised by the collection ids recorded in `state.streamyfin.parentIds`; a section whose `items.parentId` is not one of ours is never touched. Defaults are seeded only when the plugin had no home layout at all.
- `validatePlan` sees one answer at a time. A member is exclusive within an answer, not across a run: validating the whole run at once made each batch starve the next, and a shelf from an earlier run may share titles with a new one regardless. `usedItemIds` in the prompt keeps overlap rare without enforcing it.
- A planner call asks for at most `CURATOR_MAX_SHELVES_PER_CALL` shelves. Asking for nineteen at once returned `stop_reason: max_tokens` — a paid call with nothing to show — so `run.ts` batches, and turns catalog caching on for itself whenever it will make more than one call.
- Rows are capped by `CURATOR_ROW_COUNT` (default: the shelf count), not by the shelf count itself: 25 collections are a browsable library, 8 rows are a readable home screen. Both row writers take it.
- Covers (`src/art/`) are composed locally with sharp from a member's backdrop — never generated, never fetched from outside. That is what keeps them free: the run's whole bill is the planner. `cover.ts` is pure composition (testable without a server), `covers.ts` does the Jellyfin traffic.
- Jellyfin's `POST /Items/{id}/Images/Primary` wants the bytes **base64-encoded in the body** with the image's content type — not multipart, not raw.
- Home-row slot ids `curator-shelf-<n>` are stable. Home Screen Sections shows a section only if the user enabled that id; rotation changes what a slot shows, never the id.
- The system prompt is frozen text (no dates, ids, counts) so it never invalidates what follows, but it is *not* the cached block: at ~356 tokens it is below the 512-token minimum cacheable prefix, so a breakpoint there cached nothing. The catalog is a second system block and carries the `cache_control`; within a run the shortfall call reads it back.
- State is saved after every successful write, atomically. A crash mid-run must leave state truthful.
- No network in tests; inject the clock (`now: () => Date`); fixed ids.
- On a Mac, the schedule runs an installed copy under `~/.local/share/jellyfin-curator/` (`scripts/install-mac.sh`), never the SSD checkout: launchd-spawned processes cannot read external volumes. The state file lives there; re-run the installer after code changes.
- Never log or persist API keys. `loadConfig` drops unknown env keys on purpose.
- Versions are pinned exactly (`.npmrc` `save-exact=true`), as in the rest of this codebase.
- Relative imports carry `.js` (NodeNext). Jellyfin JSON is PascalCase; ours is camelCase; both are correct.

## Cost awareness

Every `run` that reaches the planner spends real money (roughly $0.50–$1.50 at current library sizes). Use `--dry-run` while developing prompt or catalog changes; it still calls the planner, so prefer `FakeShelfPlanner` in tests and reserve real runs for verifying the end result.
