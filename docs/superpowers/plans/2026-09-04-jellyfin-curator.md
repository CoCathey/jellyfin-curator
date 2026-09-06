# Jellyfin Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly CLI that asks Claude to invent themed shelves from the household's Jellyfin library, materialises them as tagged Jellyfin collections, rotates them over time, and optionally writes Collection Sections slots so they appear as rows on the web home screen.

**Architecture:** One Node/TypeScript ESM package. `src/run.ts` orchestrates a single run through four seams: `JellyfinClient` (every Jellyfin HTTP call), `ShelfPlanner` (every Claude call), `StateStore` (the JSON ownership file), and pure functions for catalog rendering, plan validation, reconciliation and rotation. Every seam has an in-memory fake, so a whole run is testable with no network.

**Tech Stack:** Node 26 (Docker `node:26-alpine`), TypeScript 5.9.3 (strict, NodeNext), pnpm 10.33.0, vitest 3.2.7, eslint 9.39.5 + typescript-eslint 8.69.0, tsx 4.23.13, `@anthropic-ai/sdk` 0.124.0, `zod` 4.5.4, native `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md` — the plan argues from the spec; read both.

## Global Constraints

- Dependency versions are pinned exactly (`.npmrc` has `save-exact=true`), matching the rest of this codebase.
- No `any`, no `@ts-ignore`, no lint overrides. `pnpm typecheck && pnpm lint && pnpm test` green, with the output seen, is the definition of done for every task.
- No network in tests. Clock is injected as `now: () => Date`. Ids in tests are fixed strings.
- Model id is exactly `claude-opus-5`. Request shape: `client.messages.parse` with `thinking: { type: "adaptive" }`, `output_config: { effort: "high", format: zodOutputFormat(PlanSchema) }`, `max_tokens: 16000`, frozen system prompt in a cached text block.
- Ownership tag is exactly `jellyfin-curator`. Slot ids are `curator-shelf-<n>`, 1-based. Collection Sections plugin id is `043b2c48-b3e0-4610-b398-8217b146d1a4`.
- Only an item with `Type === "BoxSet"` **and** the ownership tag is ever deleted. Never POST a partial DTO to `/Items/{id}`: GET the item, modify it, POST the whole object.
- Secrets (`JELLYFIN_API_KEY`, `ANTHROPIC_API_KEY`) are never logged and never written to state.
- Relative imports carry `.js` extensions (NodeNext resolution), e.g. `import { x } from "./types.js"`.
- Jellyfin JSON is PascalCase (`Id`, `Name`, `Tags`). Our own types are camelCase. Do not "fix" either.
- **Commits:** the standing rule is "never commit without asking". Before the first Commit step, confirm once that per-task commits on branch `feat/curator-service` are approved for this plan. If they are not, replace every Commit step with `git add` of the listed files and say so in the task report.
- pnpm may not be on PATH and corepack may be absent. If `pnpm -v` fails, run `npm i -g pnpm@10.33.0` and mention it in the task report.

## File map

| File | Responsibility |
| --- | --- |
| `package.json`, `.npmrc`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore` | toolchain (Task 1) |
| `CLAUDE.md`, `AGENTS.md` | agent guidance; CLAUDE.md is one line `@AGENTS.md` (Task 1, expanded in Task 14) |
| `src/constants.ts` | tag, slot prefix, plugin id, limits, price table (Task 1) |
| `src/config.ts` | env → `Config` via zod; `ConfigError` (Task 2) |
| `src/log.ts` | `Logger` interface, `consoleLogger`, `MemoryLogger` (Task 2) |
| `src/jellyfin/types.ts` | the subset of `BaseItemDto` we read (Task 3) |
| `src/jellyfin/client.ts` | `JellyfinClient` interface, `HttpJellyfinClient`, `JellyfinHttpError` (Task 3) |
| `test/fakes/jellyfin.ts` | `FakeJellyfinClient`, in-memory (Task 4) |
| `src/catalog/build.ts` | `aggregateSignals`, `buildCatalog`, `cleanOverview` (Task 5) |
| `src/catalog/render.ts` | `renderEntry`, `renderCatalog` (Task 5) |
| `src/planner/schema.ts` | zod `ShelfSchema`, `PlanSchema` (Task 6) |
| `src/planner/prompt.ts` | `SYSTEM_PROMPT`, `buildUserMessage` (Task 6) |
| `src/planner/validate.ts` | `validatePlan` (Task 6) |
| `src/planner/planner.ts` | `ShelfPlanner`, `ClaudeShelfPlanner`, `PlannerError` (Task 7) |
| `test/fakes/planner.ts` | `FakeShelfPlanner` (Task 7) |
| `src/state/types.ts` | `State`, `OwnedShelf`, `StateSchema`, `emptyState` (Task 8) |
| `src/state/store.ts` | `StateStore`, `JsonFileStateStore` (Task 8) |
| `test/fakes/state.ts` | `MemoryStateStore` (Task 8) |
| `src/sync/reconcile.ts` | `reconcileOwned` (Task 9) |
| `src/sync/rotate.ts` | `rotate` (Task 9) |
| `src/sync/apply.ts` | `applyPlan` (Task 10) |
| `src/homerows/slots.ts` | `buildSlots`, `mergeSlots`, `writeHomeRowSlots` (Task 11) |
| `src/run.ts` | `runCuration`, `estimateCostUsd` (Task 12) |
| `src/cli.ts`, `src/bin.ts` | `parseCli`, `main`, exit codes; entry point (Task 13) |
| `Dockerfile`, `compose.yml`, `.env.example`, `README.md` | deployment and operator docs (Task 14) |

---

### Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `.npmrc`, `.gitignore`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `CLAUDE.md`, `AGENTS.md`, `src/constants.ts`
- Test: `test/constants.test.ts`

**Interfaces:**
- Produces: `src/constants.ts` exports `CURATOR_TAG`, `SLOT_PREFIX`, `COLLECTION_SECTIONS_PLUGIN_ID`, `HOME_SCREEN_BUST_CACHE_PATH`, `RETIRED_HISTORY_LIMIT`, `OVERVIEW_MAX_CHARS`, `OPUS_5_USD_PER_MTOK`, `CLIENT_NAME`, `CLIENT_VERSION`. Scripts `pnpm typecheck | lint | test | build | curator`.

- [ ] **Step 1: Create the branch**

```bash
cd /Volumes/Storage/Code/jellyfin-curator && git checkout -b feat/curator-service
```

- [ ] **Step 2: Write `package.json`, `.npmrc`, `.gitignore`**

`package.json`:

```json
{
  "name": "jellyfin-curator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Nightly Claude-planned themed collections for a Jellyfin library",
  "packageManager": "pnpm@10.33.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "curator": "tsx src/bin.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "0.124.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@types/node": "26.4.1",
    "eslint": "9.39.5",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "typescript-eslint": "8.69.0",
    "vitest": "3.2.7"
  }
}
```

`.npmrc`:

```
save-exact=true
strict-peer-dependencies=true
```

`.gitignore`:

```
node_modules/
dist/
.env
curator-data/
.DS_Store
```

- [ ] **Step 3: Write the TypeScript, ESLint and vitest configs**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist", "declaration": false },
  "include": ["src"]
}
```

`eslint.config.js`:

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "docs/**", "curator-data/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
```

- [ ] **Step 4: Write `CLAUDE.md` and a starter `AGENTS.md`**

`CLAUDE.md`:

```
@AGENTS.md
```

`AGENTS.md` (expanded in Task 14):

```markdown
# jellyfin-curator — agent guide

Nightly service: read the Jellyfin library, ask Claude for themed shelves, write them as tagged collections, optionally expose them as web home rows. Design: `docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md`.

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # definition of done
pnpm curator run --dry-run                 # needs .env (see .env.example)
```

## Invariants (and why)

- Only `Type === "BoxSet"` items carrying the `jellyfin-curator` tag are ever deleted. The tag plus the state file is how we tell our collections from the ones a person made by hand; a bug here deletes someone's curation.
- Never POST a partial DTO to `/Items/{id}`. Jellyfin replaces fields wholesale, so a partial body silently blanks metadata. GET, modify, POST the whole object.
- Home-row slot ids `curator-shelf-<n>` are stable. Users enable them once; rotation changes what a slot shows, never the id.
- No network in tests; inject the clock. Fakes live in `test/fakes/`.
- Never log or persist API keys.
```

- [ ] **Step 5: Write `src/constants.ts` and its test**

`src/constants.ts`:

```ts
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

/** How many retired shelf titles we remember so the planner avoids repeats. */
export const RETIRED_HISTORY_LIMIT = 30;

/** Overview characters sent to the planner per item. Most of the token cost lives here. */
export const OVERVIEW_MAX_CHARS = 160;

/** Claude Opus 5 list price, USD per million tokens. Used only for the cost log line. */
export const OPUS_5_USD_PER_MTOK = { input: 5, output: 25 } as const;

export const CLIENT_NAME = "jellyfin-curator";
export const CLIENT_VERSION = "0.1.0";
```

`test/constants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COLLECTION_SECTIONS_PLUGIN_ID, CURATOR_TAG, SLOT_PREFIX } from "../src/constants.js";

describe("constants", () => {
  it("pins the identifiers other systems depend on", () => {
    expect(CURATOR_TAG).toBe("jellyfin-curator");
    expect(SLOT_PREFIX).toBe("curator-shelf-");
    expect(COLLECTION_SECTIONS_PLUGIN_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
```

- [ ] **Step 6: Install and run the whole toolchain**

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test
```

Expected: install succeeds with no peer warnings; typecheck clean; lint clean; vitest reports `1 passed`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml .npmrc .gitignore tsconfig.json tsconfig.build.json eslint.config.js vitest.config.ts CLAUDE.md AGENTS.md src/constants.ts test/constants.test.ts
git commit -m "chore: scaffold jellyfin-curator toolchain"
```

---

### Task 2: Config loader and logger

**Files:**
- Create: `src/config.ts`, `src/log.ts`
- Test: `test/config.test.ts`, `test/log.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config`, `ConfigError`, `Config` type with fields `JELLYFIN_URL, JELLYFIN_API_KEY, CURATOR_MODEL, CURATOR_SHELF_COUNT, CURATOR_ROTATE_PER_RUN, CURATOR_MIN_ITEMS, CURATOR_MAX_ITEMS, CURATOR_INCLUDE_OVERVIEWS: boolean, CURATOR_HOME_ROWS: boolean, CURATOR_STATE_PATH, CURATOR_LIBRARY_IDS: string[]`. `Logger { info(msg): void; warn(msg): void; error(msg): void }`, `consoleLogger`, `MemoryLogger` with `lines: string[]`.
- Note: `ANTHROPIC_API_KEY` is deliberately not in `Config`; the SDK resolves it (or an `ant auth` profile) itself.

- [ ] **Step 1: Write the failing config test**

`test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { JELLYFIN_URL: "http://jf:8096/", JELLYFIN_API_KEY: "k" };

describe("loadConfig", () => {
  it("applies defaults and strips the trailing slash", () => {
    const c = loadConfig(base);
    expect(c.JELLYFIN_URL).toBe("http://jf:8096");
    expect(c.CURATOR_MODEL).toBe("claude-opus-5");
    expect(c.CURATOR_SHELF_COUNT).toBe(6);
    expect(c.CURATOR_ROTATE_PER_RUN).toBe(2);
    expect(c.CURATOR_MIN_ITEMS).toBe(8);
    expect(c.CURATOR_MAX_ITEMS).toBe(20);
    expect(c.CURATOR_INCLUDE_OVERVIEWS).toBe(true);
    expect(c.CURATOR_HOME_ROWS).toBe(false);
    expect(c.CURATOR_STATE_PATH).toBe("/data/state.json");
    expect(c.CURATOR_LIBRARY_IDS).toEqual([]);
  });

  it("parses numbers, flags and the library id list", () => {
    const c = loadConfig({
      ...base,
      CURATOR_SHELF_COUNT: "4",
      CURATOR_HOME_ROWS: "true",
      CURATOR_INCLUDE_OVERVIEWS: "false",
      CURATOR_LIBRARY_IDS: "a, b,,c",
    });
    expect(c.CURATOR_SHELF_COUNT).toBe(4);
    expect(c.CURATOR_HOME_ROWS).toBe(true);
    expect(c.CURATOR_INCLUDE_OVERVIEWS).toBe(false);
    expect(c.CURATOR_LIBRARY_IDS).toEqual(["a", "b", "c"]);
  });

  it("lists every missing required value", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/JELLYFIN_URL/);
    expect(() => loadConfig({})).toThrow(/JELLYFIN_API_KEY/);
  });

  it("rejects min > max and non-numeric numbers", () => {
    expect(() => loadConfig({ ...base, CURATOR_MIN_ITEMS: "10", CURATOR_MAX_ITEMS: "5" })).toThrow(/CURATOR_MIN_ITEMS must be/);
    expect(() => loadConfig({ ...base, CURATOR_SHELF_COUNT: "six" })).toThrow(/CURATOR_SHELF_COUNT/);
  });

  it("ignores unrelated environment variables", () => {
    const c = loadConfig({ ...base, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk" });
    expect(Object.keys(c)).not.toContain("ANTHROPIC_API_KEY");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL, cannot find module `../src/config.js`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { z } from "zod";

const flagOff = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const flagOn = z.enum(["true", "false"]).default("true").transform((v) => v === "true");

export const ConfigSchema = z
  .object({
    JELLYFIN_URL: z.string().min(1).transform((u) => u.replace(/\/+$/, "")),
    JELLYFIN_API_KEY: z.string().min(1),
    CURATOR_MODEL: z.string().min(1).default("claude-opus-5"),
    CURATOR_SHELF_COUNT: z.coerce.number().int().min(1).default(6),
    CURATOR_ROTATE_PER_RUN: z.coerce.number().int().min(0).default(2),
    CURATOR_MIN_ITEMS: z.coerce.number().int().min(1).default(8),
    CURATOR_MAX_ITEMS: z.coerce.number().int().min(1).default(20),
    CURATOR_INCLUDE_OVERVIEWS: flagOn,
    CURATOR_HOME_ROWS: flagOff,
    CURATOR_STATE_PATH: z.string().min(1).default("/data/state.json"),
    CURATOR_LIBRARY_IDS: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : [])),
  })
  .refine((c) => c.CURATOR_MIN_ITEMS <= c.CURATOR_MAX_ITEMS, {
    message: "CURATOR_MIN_ITEMS must be <= CURATOR_MAX_ITEMS",
    path: ["CURATOR_MIN_ITEMS"],
  });

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
```

- [ ] **Step 4: Run the config test**

Run: `pnpm vitest run test/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing logger test**

`test/log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/log.js";

describe("MemoryLogger", () => {
  it("records each level with a prefix, in order", () => {
    const log = new MemoryLogger();
    log.info("one");
    log.warn("two");
    log.error("three");
    expect(log.lines).toEqual(["info one", "warn two", "error three"]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run test/log.test.ts`
Expected: FAIL, cannot find module `../src/log.js`.

- [ ] **Step 7: Write `src/log.ts`**

```ts
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`WARN ${message}`),
  error: (message) => console.error(`ERROR ${message}`),
};

/** Test double: keeps every line so tests can assert on what was reported. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
}
```

- [ ] **Step 8: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green, 3 test files.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/log.ts test/config.test.ts test/log.test.ts
git commit -m "feat: config loader and logger"
```

---
### Task 3: Jellyfin types and HTTP client

**Files:**
- Create: `src/jellyfin/types.ts`, `src/jellyfin/client.ts`
- Test: `test/jellyfin/client.test.ts`

**Interfaces:**
- Consumes: `CLIENT_NAME`, `CLIENT_VERSION` from Task 1.
- Produces:
  - `JellyfinItem { Id: string; Name: string; Type: string; ProductionYear?, Genres?, Tags?, Overview?, CommunityRating?, RunTimeTicks?, Studios?, People?, UserData?; [extra: string]: unknown }`, `JellyfinUser { Id; Name }`, `JellyfinSystemInfo`, `ItemKind = "Movie" | "Series" | "BoxSet"`.
  - `ItemQuery { includeItemTypes: ItemKind[]; fields?: string[]; userId?: string; tags?: string[]; parentId?: string; isPlayed?: boolean; isFavorite?: boolean }`.
  - `interface JellyfinClient { getSystemInfo(); listUsers(); queryItems(q); getItem(id) → item | undefined; updateItem(item); createCollection(name, itemIds) → id; deleteItem(id); getPluginConfiguration(pluginId) → unknown (undefined on 404); setPluginConfiguration(pluginId, config); postAction(path) → HTTP status }`.
  - `HttpJellyfinClient(baseUrl, apiKey, fetchImpl?, pageSize = 500)`, `JellyfinHttpError { status; path }`, `FetchLike`.

- [ ] **Step 1: Write `src/jellyfin/types.ts`** (no behaviour, no test)

```ts
export type ItemKind = "Movie" | "Series" | "BoxSet";

export interface JellyfinPerson {
  Name?: string | null;
  Type?: string | null;
  Role?: string | null;
}

export interface JellyfinNamePair {
  Name?: string | null;
  Id?: string | null;
}

export interface JellyfinUserData {
  Played?: boolean;
  IsFavorite?: boolean;
  PlayCount?: number;
}

/** The slice of Jellyfin's BaseItemDto we read. The index signature keeps every
 * other field intact for read-modify-write updates, which Jellyfin requires. */
export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number | null;
  Genres?: string[] | null;
  Tags?: string[] | null;
  Overview?: string | null;
  CommunityRating?: number | null;
  RunTimeTicks?: number | null;
  Studios?: JellyfinNamePair[] | null;
  People?: JellyfinPerson[] | null;
  UserData?: JellyfinUserData | null;
  [extra: string]: unknown;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
}

export interface JellyfinSystemInfo {
  Version?: string | null;
  ServerName?: string | null;
}
```

- [ ] **Step 2: Write the failing client test**

`test/jellyfin/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HttpJellyfinClient, JellyfinHttpError, type FetchLike } from "../../src/jellyfin/client.js";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface Canned {
  status?: number;
  json?: unknown;
  text?: string;
}

function fakeFetch(responses: Canned[]): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url: new URL(url),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses.shift() ?? { status: 200, json: {} };
    const body = next.text ?? JSON.stringify(next.json ?? {});
    return new Response(body === "" ? null : body, {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("HttpJellyfinClient", () => {
  it("sends the MediaBrowser token header and builds the query string", async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: { Items: [], TotalRecordCount: 0 } }]);
    const client = new HttpJellyfinClient("http://jf:8096", "secret", fetchImpl);
    await client.queryItems({ includeItemTypes: ["Movie", "Series"], fields: ["Genres", "Tags"], userId: "u1", isPlayed: true });
    const call = calls[0]!;
    expect(call.headers.Authorization).toContain('MediaBrowser Token="secret"');
    expect(call.headers.Authorization).toContain('Client="jellyfin-curator"');
    expect(call.url.pathname).toBe("/Items");
    expect(call.url.searchParams.get("recursive")).toBe("true");
    expect(call.url.searchParams.get("includeItemTypes")).toBe("Movie,Series");
    expect(call.url.searchParams.get("fields")).toBe("Genres,Tags");
    expect(call.url.searchParams.get("userId")).toBe("u1");
    expect(call.url.searchParams.get("isPlayed")).toBe("true");
    expect(call.url.searchParams.has("isFavorite")).toBe(false);
    expect(call.url.searchParams.has("tags")).toBe(false);
  });

  it("pages through /Items until every record is fetched", async () => {
    const page = (ids: string[]): Canned => ({
      json: { Items: ids.map((Id) => ({ Id, Name: Id, Type: "Movie" })), TotalRecordCount: 5 },
    });
    const { calls, fetchImpl } = fakeFetch([page(["a", "b"]), page(["c", "d"]), page(["e"])]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl, 2);
    const items = await client.queryItems({ includeItemTypes: ["Movie"] });
    expect(items.map((i) => i.Id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls.map((c) => c.url.searchParams.get("startIndex"))).toEqual(["0", "2", "4"]);
  });

  it("creates a collection and returns its id", async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: { Id: "box-1" } }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.createCollection("Heists & Chaos", ["m1", "m2"])).resolves.toBe("box-1");
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/Collections");
    expect(call.url.searchParams.get("name")).toBe("Heists & Chaos");
    expect(call.url.searchParams.get("ids")).toBe("m1,m2");
  });

  it("posts the whole item back on updateItem", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.updateItem({ Id: "box-1", Name: "X", Type: "BoxSet", Tags: ["jellyfin-curator"], Extra: 1 });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/Items/box-1");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({ Id: "box-1", Name: "X", Type: "BoxSet", Tags: ["jellyfin-curator"], Extra: 1 });
  });

  it("deletes by id", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.deleteItem("box-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/Items/box-1");
  });

  it("returns undefined for a missing item or plugin config, throws on other errors", async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, text: "" }, { status: 404, text: "" }, { status: 401, text: "nope" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.getItem("nope")).resolves.toBeUndefined();
    await expect(client.getPluginConfiguration("p")).resolves.toBeUndefined();
    const err = await client.getSystemInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JellyfinHttpError);
    expect((err as JellyfinHttpError).status).toBe(401);
    expect((err as JellyfinHttpError).path).toBe("/System/Info");
  });

  it("writes plugin configuration as JSON", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.setPluginConfiguration("abc", { Sections: [] });
    expect(calls[0]!.url.pathname).toBe("/Plugins/abc/Configuration");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ Sections: [] });
  });

  it("postAction returns the status without throwing", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 404, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.postAction("/HomeScreen/BustCache")).resolves.toBe(404);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/HomeScreen/BustCache");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run test/jellyfin/client.test.ts`
Expected: FAIL, cannot find module `../../src/jellyfin/client.js`.

- [ ] **Step 4: Write `src/jellyfin/client.ts`**

```ts
import { CLIENT_NAME, CLIENT_VERSION } from "../constants.js";
import type { ItemKind, JellyfinItem, JellyfinSystemInfo, JellyfinUser } from "./types.js";

export interface ItemQuery {
  includeItemTypes: ItemKind[];
  fields?: string[];
  userId?: string;
  tags?: string[];
  parentId?: string;
  isPlayed?: boolean;
  isFavorite?: boolean;
}

/** Everything the service needs from Jellyfin. The only HTTP seam. */
export interface JellyfinClient {
  getSystemInfo(): Promise<JellyfinSystemInfo>;
  listUsers(): Promise<JellyfinUser[]>;
  /** Recursive query, all pages. */
  queryItems(query: ItemQuery): Promise<JellyfinItem[]>;
  /** undefined when Jellyfin answers 404. */
  getItem(id: string): Promise<JellyfinItem | undefined>;
  /** POSTs the whole DTO. Callers must GET first and modify. */
  updateItem(item: JellyfinItem): Promise<void>;
  /** Returns the new BoxSet id. */
  createCollection(name: string, itemIds: string[]): Promise<string>;
  deleteItem(id: string): Promise<void>;
  /** undefined when the plugin is not installed (404). */
  getPluginConfiguration(pluginId: string): Promise<unknown>;
  setPluginConfiguration(pluginId: string, config: unknown): Promise<void>;
  /** POST with no body; returns the HTTP status instead of throwing. */
  postAction(path: string): Promise<number>;
}

export class JellyfinHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`Jellyfin responded ${status} to ${path}: ${body.slice(0, 200)}`);
    this.name = "JellyfinHttpError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ItemsPage {
  Items?: JellyfinItem[] | null;
  TotalRecordCount?: number;
}

type Query = Record<string, string | undefined>;

export class HttpJellyfinClient implements JellyfinClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly pageSize = 500,
  ) {}

  getSystemInfo(): Promise<JellyfinSystemInfo> {
    return this.json<JellyfinSystemInfo>("GET", "/System/Info");
  }

  listUsers(): Promise<JellyfinUser[]> {
    return this.json<JellyfinUser[]>("GET", "/Users");
  }

  async queryItems(query: ItemQuery): Promise<JellyfinItem[]> {
    const all: JellyfinItem[] = [];
    let startIndex = 0;
    for (;;) {
      const page = await this.json<ItemsPage>("GET", "/Items", {
        recursive: "true",
        includeItemTypes: query.includeItemTypes.join(","),
        fields: query.fields?.join(","),
        userId: query.userId,
        tags: query.tags?.join(","),
        parentId: query.parentId,
        isPlayed: query.isPlayed === undefined ? undefined : String(query.isPlayed),
        isFavorite: query.isFavorite === undefined ? undefined : String(query.isFavorite),
        limit: String(this.pageSize),
        startIndex: String(startIndex),
      });
      const items = page.Items ?? [];
      all.push(...items);
      startIndex += items.length;
      const total = page.TotalRecordCount ?? all.length;
      if (items.length < this.pageSize || startIndex >= total) break;
    }
    return all;
  }

  async getItem(id: string): Promise<JellyfinItem | undefined> {
    const path = `/Items/${id}`;
    const res = await this.send("GET", path);
    if (res.status === 404) return undefined;
    await this.assertOk(res, path);
    return (await res.json()) as JellyfinItem;
  }

  async updateItem(item: JellyfinItem): Promise<void> {
    await this.ok("POST", `/Items/${item.Id}`, undefined, item);
  }

  async createCollection(name: string, itemIds: string[]): Promise<string> {
    const result = await this.json<{ Id: string }>("POST", "/Collections", { name, ids: itemIds.join(",") });
    return result.Id;
  }

  async deleteItem(id: string): Promise<void> {
    await this.ok("DELETE", `/Items/${id}`);
  }

  async getPluginConfiguration(pluginId: string): Promise<unknown> {
    const path = `/Plugins/${pluginId}/Configuration`;
    const res = await this.send("GET", path);
    if (res.status === 404) return undefined;
    await this.assertOk(res, path);
    return (await res.json()) as unknown;
  }

  async setPluginConfiguration(pluginId: string, config: unknown): Promise<void> {
    await this.ok("POST", `/Plugins/${pluginId}/Configuration`, undefined, config);
  }

  async postAction(path: string): Promise<number> {
    const res = await this.send("POST", path);
    return res.status;
  }

  private send(method: string, path: string, query?: Query, body?: unknown): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `MediaBrowser Token="${this.apiKey}", Client="${CLIENT_NAME}", Device="curator", DeviceId="${CLIENT_NAME}", Version="${CLIENT_VERSION}"`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async assertOk(res: Response, path: string): Promise<void> {
    if (!res.ok) throw new JellyfinHttpError(res.status, path, await res.text());
  }

  private async ok(method: string, path: string, query?: Query, body?: unknown): Promise<void> {
    const res = await this.send(method, path, query, body);
    await this.assertOk(res, path);
  }

  private async json<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const res = await this.send(method, path, query, body);
    await this.assertOk(res, path);
    return (await res.json()) as T;
  }
}
```

- [ ] **Step 5: Run the client test**

Run: `pnpm vitest run test/jellyfin/client.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/jellyfin/types.ts src/jellyfin/client.ts test/jellyfin/client.test.ts
git commit -m "feat: Jellyfin HTTP client"
```

---

### Task 4: In-memory FakeJellyfinClient

**Files:**
- Create: `test/fakes/jellyfin.ts`
- Test: `test/fakes/jellyfin.test.ts`

**Interfaces:**
- Consumes: `JellyfinClient`, `ItemQuery`, `JellyfinHttpError` (Task 3).
- Produces: `class FakeJellyfinClient implements JellyfinClient` with public state `items: Map<string, JellyfinItem>`, `users: JellyfinUser[]`, `played: Map<userId, Set<itemId>>`, `favorites: Map<userId, Set<itemId>>`, `collections: Map<id, { name; itemIds }>`, `pluginConfigs: Map<string, unknown>`, `deleted: string[]`, `actions: string[]`, `actionStatus = 200`, `failCreateFor: Set<string>`, helper `addItem(item)`. Created collections get ids `boxset-1`, `boxset-2`, ...

- [ ] **Step 1: Write the failing fake test**

`test/fakes/jellyfin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeJellyfinClient } from "./jellyfin.js";

function seeded(): FakeJellyfinClient {
  const fake = new FakeJellyfinClient();
  fake.addItem({ Id: "m1", Name: "Heat", Type: "Movie" });
  fake.addItem({ Id: "s1", Name: "The Wire", Type: "Series", Tags: ["hbo"] });
  fake.addItem({ Id: "e1", Name: "Pilot", Type: "Episode" });
  fake.users = [{ Id: "u1", Name: "Admin" }];
  fake.played.set("u1", new Set(["m1"]));
  fake.favorites.set("u1", new Set(["s1"]));
  return fake;
}

describe("FakeJellyfinClient", () => {
  it("filters by type, tags, played and favourite; attaches UserData per user", async () => {
    const fake = seeded();
    expect((await fake.queryItems({ includeItemTypes: ["Movie", "Series"] })).map((i) => i.Id)).toEqual(["m1", "s1"]);
    expect((await fake.queryItems({ includeItemTypes: ["Series"], tags: ["hbo"] })).map((i) => i.Id)).toEqual(["s1"]);
    expect((await fake.queryItems({ includeItemTypes: ["Movie", "Series"], userId: "u1", isPlayed: true })).map((i) => i.Id)).toEqual(["m1"]);
    const favs = await fake.queryItems({ includeItemTypes: ["Movie", "Series"], userId: "u1", isFavorite: true });
    expect(favs.map((i) => i.Id)).toEqual(["s1"]);
    expect(favs[0]!.UserData).toEqual({ Played: false, IsFavorite: true });
  });

  it("round-trips a collection through create, get, update, delete", async () => {
    const fake = seeded();
    const id = await fake.createCollection("Shelf", ["m1", "s1"]);
    expect(id).toBe("boxset-1");
    const dto = await fake.getItem(id);
    expect(dto).toMatchObject({ Id: id, Name: "Shelf", Type: "BoxSet" });
    await fake.updateItem({ ...dto!, Tags: ["jellyfin-curator"] });
    expect((await fake.getItem(id))!.Tags).toEqual(["jellyfin-curator"]);
    expect((await fake.queryItems({ includeItemTypes: ["BoxSet"], tags: ["jellyfin-curator"] })).map((i) => i.Id)).toEqual([id]);
    await fake.deleteItem(id);
    expect(await fake.getItem(id)).toBeUndefined();
    expect(fake.deleted).toEqual([id]);
  });

  it("returns copies, not live references", async () => {
    const fake = seeded();
    const first = await fake.getItem("m1");
    first!.Name = "changed";
    expect((await fake.getItem("m1"))!.Name).toBe("Heat");
  });

  it("stores plugin configuration and records actions", async () => {
    const fake = seeded();
    expect(await fake.getPluginConfiguration("p")).toBeUndefined();
    await fake.setPluginConfiguration("p", { Sections: [{ UniqueId: "x" }] });
    expect(await fake.getPluginConfiguration("p")).toEqual({ Sections: [{ UniqueId: "x" }] });
    fake.actionStatus = 404;
    expect(await fake.postAction("/HomeScreen/BustCache")).toBe(404);
    expect(fake.actions).toEqual(["/HomeScreen/BustCache"]);
  });

  it("can be told to fail a create", async () => {
    const fake = seeded();
    fake.failCreateFor.add("Broken");
    await expect(fake.createCollection("Broken", ["m1"])).rejects.toThrow(/Broken/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/fakes/jellyfin.test.ts`
Expected: FAIL, cannot find module `./jellyfin.js`.

- [ ] **Step 3: Write `test/fakes/jellyfin.ts`**

```ts
import { JellyfinHttpError, type ItemQuery, type JellyfinClient } from "../../src/jellyfin/client.js";
import type { ItemKind, JellyfinItem, JellyfinSystemInfo, JellyfinUser } from "../../src/jellyfin/types.js";

/** In-memory Jellyfin. Mirrors the semantics the service relies on: type and
 * tag filtering, per-user played/favourite flags, BoxSet creation, 404s. */
export class FakeJellyfinClient implements JellyfinClient {
  readonly items = new Map<string, JellyfinItem>();
  users: JellyfinUser[] = [];
  readonly played = new Map<string, Set<string>>();
  readonly favorites = new Map<string, Set<string>>();
  readonly collections = new Map<string, { name: string; itemIds: string[] }>();
  readonly pluginConfigs = new Map<string, unknown>();
  readonly deleted: string[] = [];
  readonly actions: string[] = [];
  readonly failCreateFor = new Set<string>();
  actionStatus = 200;
  private nextId = 1;

  addItem(item: JellyfinItem): void {
    this.items.set(item.Id, structuredClone(item));
  }

  async getSystemInfo(): Promise<JellyfinSystemInfo> {
    return { Version: "10.11.10", ServerName: "fake" };
  }

  async listUsers(): Promise<JellyfinUser[]> {
    return [...this.users];
  }

  async queryItems(query: ItemQuery): Promise<JellyfinItem[]> {
    let list = [...this.items.values()].filter((i) => query.includeItemTypes.includes(i.Type as ItemKind));
    if (query.tags) list = list.filter((i) => query.tags!.every((t) => (i.Tags ?? []).includes(t)));
    if (query.userId !== undefined) {
      const played = this.played.get(query.userId) ?? new Set<string>();
      const favorites = this.favorites.get(query.userId) ?? new Set<string>();
      if (query.isPlayed) list = list.filter((i) => played.has(i.Id));
      if (query.isFavorite) list = list.filter((i) => favorites.has(i.Id));
      list = list.map((i) => ({ ...i, UserData: { Played: played.has(i.Id), IsFavorite: favorites.has(i.Id) } }));
    }
    return list.map((i) => structuredClone(i));
  }

  async getItem(id: string): Promise<JellyfinItem | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async updateItem(item: JellyfinItem): Promise<void> {
    if (!this.items.has(item.Id)) throw new JellyfinHttpError(404, `/Items/${item.Id}`, "");
    this.items.set(item.Id, structuredClone(item));
  }

  async createCollection(name: string, itemIds: string[]): Promise<string> {
    if (this.failCreateFor.has(name)) throw new JellyfinHttpError(500, "/Collections", `refused to create ${name}`);
    const id = `boxset-${this.nextId++}`;
    this.collections.set(id, { name, itemIds: [...itemIds] });
    this.items.set(id, { Id: id, Name: name, Type: "BoxSet", Tags: [] });
    return id;
  }

  async deleteItem(id: string): Promise<void> {
    if (!this.items.has(id)) throw new JellyfinHttpError(404, `/Items/${id}`, "");
    this.items.delete(id);
    this.collections.delete(id);
    this.deleted.push(id);
  }

  async getPluginConfiguration(pluginId: string): Promise<unknown> {
    return this.pluginConfigs.has(pluginId) ? structuredClone(this.pluginConfigs.get(pluginId)) : undefined;
  }

  async setPluginConfiguration(pluginId: string, config: unknown): Promise<void> {
    this.pluginConfigs.set(pluginId, structuredClone(config));
  }

  async postAction(path: string): Promise<number> {
    this.actions.push(path);
    return this.actionStatus;
  }
}
```

- [ ] **Step 4: Run the fake test**

Run: `pnpm vitest run test/fakes/jellyfin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full gate, then commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add test/fakes/jellyfin.ts test/fakes/jellyfin.test.ts
git commit -m "test: in-memory Jellyfin fake"
```

---
### Task 5: Catalog builder and renderer

**Files:**
- Create: `src/catalog/build.ts`, `src/catalog/render.ts`
- Test: `test/catalog/build.test.ts`, `test/catalog/render.test.ts`

**Interfaces:**
- Consumes: `JellyfinItem` (Task 3), `CURATOR_TAG`, `OVERVIEW_MAX_CHARS` (Task 1).
- Produces: `WatchSignal { watchedBy: number; favoritedBy: number }`, `CatalogEntry { id; kind: "M" | "S"; title; year?; genres: string[]; rating?; runtimeMin?; studios: string[]; tags: string[]; watchedBy; favoritedBy; overview }`, `aggregateSignals(playedPerUser: string[][], favoritedPerUser: string[][]): Map<string, WatchSignal>`, `cleanOverview(text, max?)`, `buildCatalog(items, signals): CatalogEntry[]` (sorted by id, movies and series only), `renderEntry(entry, includeOverview): string`, `renderCatalog(entries, { includeOverviews }): string`.

- [ ] **Step 1: Write the failing build test**

`test/catalog/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregateSignals, buildCatalog, cleanOverview } from "../../src/catalog/build.js";
import type { JellyfinItem } from "../../src/jellyfin/types.js";

const MINUTE_TICKS = 600_000_000;

const heat: JellyfinItem = {
  Id: "m1",
  Name: " Heat ",
  Type: "Movie",
  ProductionYear: 1995,
  Genres: ["Crime", " Thriller"],
  CommunityRating: 8.26,
  RunTimeTicks: 170 * MINUTE_TICKS,
  Studios: [{ Name: "Warner Bros." }, { Name: "" }],
  Tags: ["jellyfin-curator", "favourite-director"],
  Overview: "A  group of\nprofessional | thieves.",
};
const wire: JellyfinItem = { Id: "s1", Name: "The Wire", Type: "Series", Genres: null, Overview: null };
const episode: JellyfinItem = { Id: "e1", Name: "Pilot", Type: "Episode" };

describe("aggregateSignals", () => {
  it("counts users, not occurrences", () => {
    const signals = aggregateSignals([["m1", "m1"], ["m1", "s1"]], [["m1"]]);
    expect(signals.get("m1")).toEqual({ watchedBy: 2, favoritedBy: 1 });
    expect(signals.get("s1")).toEqual({ watchedBy: 1, favoritedBy: 0 });
    expect(signals.get("zzz")).toBeUndefined();
  });
});

describe("cleanOverview", () => {
  it("collapses whitespace, replaces pipes and truncates", () => {
    expect(cleanOverview("A  group of\nprofessional | thieves.")).toBe("A group of professional / thieves.");
    expect(cleanOverview(null)).toBe("");
    expect(cleanOverview("x".repeat(200), 160)).toHaveLength(160);
  });
});

describe("buildCatalog", () => {
  it("maps fields, converts ticks to minutes, rounds ratings, drops our own tag", () => {
    const [entry] = buildCatalog([heat], new Map([["m1", { watchedBy: 2, favoritedBy: 1 }]]));
    expect(entry).toEqual({
      id: "m1",
      kind: "M",
      title: "Heat",
      year: 1995,
      genres: ["Crime", "Thriller"],
      rating: 8.3,
      runtimeMin: 170,
      studios: ["Warner Bros."],
      tags: ["favourite-director"],
      watchedBy: 2,
      favoritedBy: 1,
      overview: "A group of professional / thieves.",
    });
  });

  it("is order-independent, skips non movie/series types and dedupes", () => {
    const a = buildCatalog([wire, heat, episode, heat], new Map());
    const b = buildCatalog([heat, wire], new Map());
    expect(a).toEqual(b);
    expect(a.map((e) => e.id)).toEqual(["m1", "s1"]);
  });

  it("omits optional fields when Jellyfin has no value", () => {
    const [entry] = buildCatalog([wire], new Map());
    expect(entry).toEqual({ id: "s1", kind: "S", title: "The Wire", genres: [], studios: [], tags: [], watchedBy: 0, favoritedBy: 0, overview: "" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/catalog/build.test.ts`
Expected: FAIL, cannot find module `../../src/catalog/build.js`.

- [ ] **Step 3: Write `src/catalog/build.ts`**

```ts
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
      title: item.Name.trim(),
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
```

- [ ] **Step 4: Run the build test**

Run: `pnpm vitest run test/catalog/build.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing render test**

`test/catalog/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../src/catalog/build.js";
import { renderCatalog, renderEntry } from "../../src/catalog/render.js";

const heat: CatalogEntry = {
  id: "m1",
  kind: "M",
  title: "Heat",
  year: 1995,
  genres: ["Crime", "Thriller"],
  rating: 8.3,
  runtimeMin: 170,
  studios: ["Warner Bros."],
  tags: [],
  watchedBy: 2,
  favoritedBy: 1,
  overview: "A group of professional thieves.",
};
const wire: CatalogEntry = { id: "s1", kind: "S", title: "The Wire", genres: [], studios: [], tags: ["hbo"], watchedBy: 0, favoritedBy: 0, overview: "" };

describe("renderEntry", () => {
  it("renders the fixed pipe-separated column order", () => {
    expect(renderEntry(heat, true)).toBe("m1|M|Heat (1995)|Crime,Thriller|8.3|170|Warner Bros.||w2f1|A group of professional thieves.");
    expect(renderEntry(wire, true)).toBe("s1|S|The Wire (-)||-|-||hbo|w0f0|");
  });

  it("omits the overview column when asked", () => {
    expect(renderEntry(heat, false)).toBe("m1|M|Heat (1995)|Crime,Thriller|8.3|170|Warner Bros.||w2f1");
  });

  it("never lets a pipe or newline inside a field break the format", () => {
    const tricky: CatalogEntry = { ...heat, title: "Face|Off\nRemix", genres: ["Ac|tion"] };
    expect(renderEntry(tricky, false).split("|")).toHaveLength(9);
    expect(renderEntry(tricky, false)).toContain("Face Off Remix (1995)");
  });
});

describe("renderCatalog", () => {
  it("joins one line per entry", () => {
    expect(renderCatalog([heat, wire], { includeOverviews: false }).split("\n")).toHaveLength(2);
    expect(renderCatalog([], { includeOverviews: true })).toBe("");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run test/catalog/render.test.ts`
Expected: FAIL, cannot find module `../../src/catalog/render.js`.

- [ ] **Step 7: Write `src/catalog/render.ts`**

```ts
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

export function renderCatalog(entries: CatalogEntry[], options: { includeOverviews: boolean }): string {
  return entries.map((entry) => renderEntry(entry, options.includeOverviews)).join("\n");
}
```

- [ ] **Step 8: Run both catalog tests, then the full gate**

Run: `pnpm vitest run test/catalog && pnpm typecheck && pnpm lint && pnpm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/catalog test/catalog
git commit -m "feat: catalog builder and prompt renderer"
```

---

### Task 6: Planner schema, prompt and validation

**Files:**
- Create: `src/planner/schema.ts`, `src/planner/prompt.ts`, `src/planner/validate.ts`
- Test: `test/planner/prompt.test.ts`, `test/planner/validate.test.ts`

**Interfaces:**
- Produces: `ShelfSchema`, `PlanSchema` (zod), `Shelf { title; blurb; itemIds: string[]; rationale }`, `Plan { shelves: Shelf[] }`; `PlanRequest { catalogText; wanted; avoidThemes: string[]; minItems; maxItems }`; `SYSTEM_PROMPT: string`; `buildUserMessage(request: PlanRequest): string`; `validatePlan(shelves, catalogIds: Set<string>, { minItems, maxItems, avoidTitles }): { shelves; dropped: { title; reason }[]; unknownIds }`.

- [ ] **Step 1: Write `src/planner/schema.ts`** (types only, exercised by later tests)

```ts
import { z } from "zod";

/** Keep this schema free of length constraints: they are enforced by the
 * prompt and by validatePlan, and structured-output grammars stay simple. */
export const ShelfSchema = z.object({
  title: z.string(),
  blurb: z.string(),
  itemIds: z.array(z.string()),
  /** One sentence for the operator's log. Never written to Jellyfin. */
  rationale: z.string(),
});

export const PlanSchema = z.object({
  shelves: z.array(ShelfSchema),
});

export type Shelf = z.infer<typeof ShelfSchema>;
export type Plan = z.infer<typeof PlanSchema>;
```

- [ ] **Step 2: Write the failing prompt test**

`test/planner/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, buildUserMessage } from "../../src/planner/prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("is frozen text that names the contract and carries nothing volatile", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).toContain("itemIds");
    expect(SYSTEM_PROMPT).toContain("rationale");
    expect(SYSTEM_PROMPT).toContain("id|M or S");
  });
});

describe("buildUserMessage", () => {
  const catalogText = "m1|M|Heat (1995)|Crime|8.3|170|WB||w0f0|x\ns1|S|The Wire (2002)|Crime|9.3|-|HBO||w1f1|y";

  it("states the ask, the bounds, the avoid list and the catalog size", () => {
    const message = buildUserMessage({ catalogText, wanted: 2, minItems: 8, maxItems: 20, avoidThemes: ["Heists that go sideways"] });
    expect(message).toContain("Invent 2 shelves");
    expect(message).toContain("between 8 and 20 members");
    expect(message).toContain("- Heists that go sideways");
    expect(message).toContain("Catalog (2 items)");
    expect(message.endsWith(catalogText)).toBe(true);
  });

  it("says None when there is nothing to avoid, and 0 items for an empty catalog", () => {
    const message = buildUserMessage({ catalogText: "", wanted: 1, minItems: 8, maxItems: 20, avoidThemes: [] });
    expect(message).toContain("None.");
    expect(message).toContain("Catalog (0 items)");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run test/planner/prompt.test.ts`
Expected: FAIL, cannot find module `../../src/planner/prompt.js`.

- [ ] **Step 4: Write `src/planner/prompt.ts`**

```ts
export interface PlanRequest {
  /** Output of renderCatalog. */
  catalogText: string;
  wanted: number;
  /** Live and recently retired shelf titles the planner must not repeat. */
  avoidThemes: string[];
  minItems: number;
  maxItems: number;
}

/** Frozen. No dates, ids or counts: the same bytes on every run so the cached
 * system block is reusable within a run (a second call for a shortfall). */
export const SYSTEM_PROMPT = `You curate a household's personal media library. You receive a catalog of the movies and series they own, one per line, and you invent themed shelves from it: the specific, surprising groupings a sharp video-store clerk would hand-letter on a card.

What makes a good shelf
- A precise idea, not a category. "Heists that go sideways", "Small towns with secrets", "Rainy-day 90s comfort" are good. "Action", "Comedy", "Best of the 2010s", "Highly rated" are not.
- Only titles that genuinely fit. Eight that all fit beat twenty that mostly fit.
- Mixed eras, and movies and series together, whenever the theme allows.
- Shelves in one answer must be clearly different from each other and from every theme you are told to avoid.
- Prefer titles the household has not watched much (low w count), but keep a watched title when it defines the theme.

Hard rules
- itemIds are copied exactly from the first column of the catalog. Never invent, alter or guess an id.
- Never repeat an id across shelves in one answer.
- Respect the minimum and maximum shelf sizes in the request.
- title: under 40 characters, no colon-and-subtitle constructions. blurb: under 120 characters, written for the family. rationale: one sentence for the operator's log.

Catalog line format
id|M or S (movie or series)|title (year)|genres|community rating|runtime in minutes|studios|tags|wN fM (watched by N household members, favourited by M)|overview`;

export function buildUserMessage(request: PlanRequest): string {
  const count = request.catalogText.length === 0 ? 0 : request.catalogText.split("\n").length;
  const avoid = request.avoidThemes.length === 0 ? "None." : request.avoidThemes.map((theme) => `- ${theme}`).join("\n");
  return [
    `Invent ${request.wanted} shelves with between ${request.minItems} and ${request.maxItems} members each.`,
    "",
    "Avoid these themes and anything close to them:",
    avoid,
    "",
    `Catalog (${count} items):`,
    request.catalogText,
  ].join("\n");
}
```

- [ ] **Step 5: Run the prompt test**

Run: `pnpm vitest run test/planner/prompt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing validation test**

`test/planner/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Shelf } from "../../src/planner/schema.js";
import { validatePlan } from "../../src/planner/validate.js";

const ids = new Set(["a", "b", "c", "d", "e", "f"]);
const shelf = (title: string, itemIds: string[]): Shelf => ({ title, blurb: "b", itemIds, rationale: "r" });
const opts = { minItems: 2, maxItems: 3, avoidTitles: ["Old Shelf"] };

describe("validatePlan", () => {
  it("drops unknown ids and counts them", () => {
    const result = validatePlan([shelf("One", ["a", "zzz", "b"])], ids, opts);
    expect(result.shelves[0]!.itemIds).toEqual(["a", "b"]);
    expect(result.unknownIds).toBe(1);
  });

  it("dedupes within and across shelves; the earlier shelf wins", () => {
    const result = validatePlan([shelf("One", ["a", "a", "b"]), shelf("Two", ["b", "c", "d"])], ids, opts);
    expect(result.shelves.map((s) => s.itemIds)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("drops shelves below the minimum after cleaning and caps at the maximum", () => {
    const result = validatePlan([shelf("Tiny", ["a", "zzz"]), shelf("Big", ["b", "c", "d", "e", "f"])], ids, opts);
    expect(result.shelves.map((s) => s.title)).toEqual(["Big"]);
    expect(result.shelves[0]!.itemIds).toEqual(["b", "c", "d"]);
    expect(result.dropped).toEqual([{ title: "Tiny", reason: "too few valid members (1)" }]);
  });

  it("drops empty, avoided or duplicate titles, case-insensitively", () => {
    const result = validatePlan(
      [shelf("  ", ["a", "b"]), shelf("old shelf", ["a", "b"]), shelf("Fresh", ["a", "b"]), shelf("FRESH", ["c", "d"])],
      ids,
      opts,
    );
    expect(result.shelves.map((s) => s.title)).toEqual(["Fresh"]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["empty title", "duplicate or avoided title", "duplicate or avoided title"]);
  });

  it("trims titles and blurbs", () => {
    const result = validatePlan([{ title: " Neat ", blurb: " nice ", itemIds: ["a", "b"], rationale: "r" }], ids, opts);
    expect(result.shelves[0]).toMatchObject({ title: "Neat", blurb: "nice" });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run test/planner/validate.test.ts`
Expected: FAIL, cannot find module `../../src/planner/validate.js`.

- [ ] **Step 8: Write `src/planner/validate.ts`**

```ts
import type { Shelf } from "./schema.js";

export interface ValidateOptions {
  minItems: number;
  maxItems: number;
  /** Titles that must not be reused (live shelves, recently retired, earlier answers). */
  avoidTitles: string[];
}

export interface DroppedShelf {
  title: string;
  reason: string;
}

export interface ValidationResult {
  shelves: Shelf[];
  dropped: DroppedShelf[];
  /** Ids the model produced that are not in the catalog. */
  unknownIds: number;
}

const normalise = (title: string): string => title.trim().toLowerCase();

/** The model's answer is untrusted. Keep only ids that exist, no duplicates
 * within or across shelves, sizes within bounds, titles not already in use. */
export function validatePlan(shelves: Shelf[], catalogIds: Set<string>, options: ValidateOptions): ValidationResult {
  const seenTitles = new Set(options.avoidTitles.map(normalise));
  const usedIds = new Set<string>();
  const result: ValidationResult = { shelves: [], dropped: [], unknownIds: 0 };

  for (const shelf of shelves) {
    const title = shelf.title.trim();
    if (title.length === 0) {
      result.dropped.push({ title: shelf.title, reason: "empty title" });
      continue;
    }
    if (seenTitles.has(normalise(title))) {
      result.dropped.push({ title, reason: "duplicate or avoided title" });
      continue;
    }
    const itemIds: string[] = [];
    for (const id of shelf.itemIds) {
      if (!catalogIds.has(id)) {
        result.unknownIds += 1;
        continue;
      }
      if (usedIds.has(id) || itemIds.includes(id)) continue;
      itemIds.push(id);
    }
    if (itemIds.length < options.minItems) {
      result.dropped.push({ title, reason: `too few valid members (${itemIds.length})` });
      continue;
    }
    const capped = itemIds.slice(0, options.maxItems);
    for (const id of capped) usedIds.add(id);
    seenTitles.add(normalise(title));
    result.shelves.push({ ...shelf, title, blurb: shelf.blurb.trim(), itemIds: capped });
  }
  return result;
}
```

- [ ] **Step 9: Run the validation test, then the full gate**

Run: `pnpm vitest run test/planner && pnpm typecheck && pnpm lint && pnpm test`
Expected: green.

- [ ] **Step 10: Commit**

```bash
git add src/planner/schema.ts src/planner/prompt.ts src/planner/validate.ts test/planner/prompt.test.ts test/planner/validate.test.ts
git commit -m "feat: planner schema, prompt and answer validation"
```

---

### Task 7: ClaudeShelfPlanner and the planner fake

**Files:**
- Create: `src/planner/planner.ts`, `test/fakes/planner.ts`
- Test: `test/planner/planner.test.ts`

**Interfaces:**
- Consumes: `PlanSchema`, `Shelf` (Task 6), `SYSTEM_PROMPT`, `buildUserMessage`, `PlanRequest` (Task 6).
- Produces: `PlanUsage { inputTokens; outputTokens }`, `PlanResult { shelves: Shelf[]; usage: PlanUsage }`, `interface ShelfPlanner { plan(request: PlanRequest): Promise<PlanResult> }`, `class ClaudeShelfPlanner(client: Anthropic, model: string)`, `class PlannerError`; re-exports `PlanRequest`. Test fake: `class FakeShelfPlanner(respond: (request) => Shelf[])` with `requests: PlanRequest[]`, plus helpers `catalogIdsOf(request)` and `chunkShelves(request, size, prefix = "Shelf", startChunk = 0)`.

- [ ] **Step 1: Write the failing planner test**

`test/planner/planner.test.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeShelfPlanner, PlannerError, type PlanRequest } from "../../src/planner/planner.js";

const request: PlanRequest = {
  catalogText: "m1|M|Heat (1995)|Crime|8.3|170|WB||w0f0|x",
  wanted: 2,
  minItems: 8,
  maxItems: 20,
  avoidThemes: [],
};
const shelves = [{ title: "Heists that go sideways", blurb: "b", itemIds: ["m1"], rationale: "r" }];

function clientWith(response: unknown): { client: Anthropic; parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn().mockResolvedValue(response);
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

describe("ClaudeShelfPlanner", () => {
  it("sends the pinned request shape and returns shelves plus usage", async () => {
    const { client, parse } = clientWith({
      stop_reason: "end_turn",
      parsed_output: { shelves },
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 },
    });
    const result = await new ClaudeShelfPlanner(client, "claude-opus-5").plan(request);
    expect(result.shelves).toEqual(shelves);
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 20 });

    const params = parse.mock.calls[0]![0];
    expect(params.model).toBe("claude-opus-5");
    expect(params.max_tokens).toBe(16000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config.effort).toBe("high");
    expect(params.output_config.format).toBeDefined();
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toContain("Invent 2 shelves");
  });

  it("turns a refusal into a PlannerError", async () => {
    const { client } = clientWith({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: null, explanation: "declined" },
      parsed_output: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    await expect(new ClaudeShelfPlanner(client, "claude-opus-5").plan(request)).rejects.toThrow(PlannerError);
    await expect(new ClaudeShelfPlanner(client, "claude-opus-5").plan(request)).rejects.toThrow(/declined/);
  });

  it("turns an unparsable answer into a PlannerError", async () => {
    const { client } = clientWith({ stop_reason: "end_turn", parsed_output: null, usage: { input_tokens: 1, output_tokens: 0 } });
    await expect(new ClaudeShelfPlanner(client, "claude-opus-5").plan(request)).rejects.toThrow(/schema/);
  });

  it("turns a max_tokens cutoff into a PlannerError", async () => {
    const { client } = clientWith({ stop_reason: "max_tokens", parsed_output: null, usage: { input_tokens: 1, output_tokens: 16000 } });
    await expect(new ClaudeShelfPlanner(client, "claude-opus-5").plan(request)).rejects.toThrow(/max_tokens/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/planner/planner.test.ts`
Expected: FAIL, cannot find module `../../src/planner/planner.js`.

- [ ] **Step 3: Write `src/planner/planner.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SYSTEM_PROMPT, buildUserMessage, type PlanRequest } from "./prompt.js";
import { PlanSchema, type Shelf } from "./schema.js";

export type { PlanRequest } from "./prompt.js";

export interface PlanUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PlanResult {
  shelves: Shelf[];
  usage: PlanUsage;
}

/** The only seam that talks to a language model. */
export interface ShelfPlanner {
  plan(request: PlanRequest): Promise<PlanResult>;
}

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerError";
  }
}

export class ClaudeShelfPlanner implements ShelfPlanner {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async plan(request: PlanRequest): Promise<PlanResult> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: zodOutputFormat(PlanSchema) },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserMessage(request) }],
    });

    if (response.stop_reason === "refusal") {
      const explanation = response.stop_details?.explanation;
      throw new PlannerError(`model refused the request${explanation ? `: ${explanation}` : ""}`);
    }
    if (response.stop_reason === "max_tokens") throw new PlannerError("model output was cut off at max_tokens");
    if (!response.parsed_output) throw new PlannerError("model answer did not match the plan schema");

    const usage = response.usage;
    return {
      shelves: response.parsed_output.shelves,
      usage: {
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      },
    };
  }
}
```

If `tsc` rejects a field name on `parse` (the SDK's parameter types are authoritative), open `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`, find `MessageCreateParamsBase`, `OutputConfig` and `StopDetails`, and adjust the field to what the SDK declares. Do not drop `thinking`, `effort`, the cached system block, or the refusal check.

- [ ] **Step 4: Run the planner test**

Run: `pnpm vitest run test/planner/planner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write `test/fakes/planner.ts`**

```ts
import type { PlanRequest, PlanResult, ShelfPlanner } from "../../src/planner/planner.js";
import type { Shelf } from "../../src/planner/schema.js";

/** Scripted planner: records every request and answers with whatever the test decides. */
export class FakeShelfPlanner implements ShelfPlanner {
  readonly requests: PlanRequest[] = [];

  constructor(private readonly respond: (request: PlanRequest) => Shelf[]) {}

  async plan(request: PlanRequest): Promise<PlanResult> {
    this.requests.push(request);
    return { shelves: this.respond(request), usage: { inputTokens: 1000, outputTokens: 100 } };
  }
}

/** The catalog ids, read back out of the rendered prompt text. */
export function catalogIdsOf(request: PlanRequest): string[] {
  return request.catalogText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("|")[0] ?? "");
}

/** Deterministic shelves: consecutive `size`-item chunks of the catalog starting
 * at chunk `startChunk`, titled "<prefix> <n>" with n skipping avoided titles. */
export function chunkShelves(request: PlanRequest, size: number, prefix = "Shelf", startChunk = 0): Shelf[] {
  const ids = catalogIdsOf(request);
  const avoid = new Set(request.avoidThemes.map((theme) => theme.toLowerCase()));
  const shelves: Shelf[] = [];
  let n = 1;
  for (let start = startChunk * size; shelves.length < request.wanted && start + size <= ids.length; start += size) {
    let title = `${prefix} ${n++}`;
    while (avoid.has(title.toLowerCase())) title = `${prefix} ${n++}`;
    shelves.push({ title, blurb: `Blurb for ${title}`, itemIds: ids.slice(start, start + size), rationale: "test" });
  }
  return shelves;
}
```

- [ ] **Step 6: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green (the fake is type-checked and linted even before a test imports it).

- [ ] **Step 7: Commit**

```bash
git add src/planner/planner.ts test/planner/planner.test.ts test/fakes/planner.ts
git commit -m "feat: Claude shelf planner with structured output"
```

---
### Task 8: State types and JSON file store

**Files:**
- Create: `src/state/types.ts`, `src/state/store.ts`, `test/fakes/state.ts`
- Test: `test/state/store.test.ts`

**Interfaces:**
- Produces: `OwnedShelf { collectionId; title; blurb; itemIds: string[]; createdAt: ISO string; origin: "planned" | "orphan" }`, `RetiredShelf { title; retiredAt }`, `State { version: 1; shelves: OwnedShelf[]; retired: RetiredShelf[]; lastRun?: { at; inputTokens; outputTokens } }`, `StateSchema` (zod), `emptyState()`, `interface StateStore { load(): Promise<State>; save(state): Promise<void> }`, `JsonFileStateStore(path)`, test fake `MemoryStateStore(state?)` with `state` and `saves` counter.

- [ ] **Step 1: Write `src/state/types.ts`**

```ts
import { z } from "zod";

export const OwnedShelfSchema = z.object({
  collectionId: z.string(),
  title: z.string(),
  blurb: z.string(),
  itemIds: z.array(z.string()),
  /** ISO timestamp from the injected clock. Rotation retires oldest first. */
  createdAt: z.string(),
  /** "orphan": tagged in Jellyfin but unknown to state; retired first, never planned around. */
  origin: z.enum(["planned", "orphan"]),
});

export const RetiredShelfSchema = z.object({
  title: z.string(),
  retiredAt: z.string(),
});

export const StateSchema = z.object({
  version: z.literal(1),
  shelves: z.array(OwnedShelfSchema),
  retired: z.array(RetiredShelfSchema),
  lastRun: z.object({ at: z.string(), inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

export type OwnedShelf = z.infer<typeof OwnedShelfSchema>;
export type RetiredShelf = z.infer<typeof RetiredShelfSchema>;
export type State = z.infer<typeof StateSchema>;

export function emptyState(): State {
  return { version: 1, shelves: [], retired: [] };
}
```

- [ ] **Step 2: Write the failing store test**

`test/state/store.test.ts`:

```ts
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileStateStore } from "../../src/state/store.js";
import { emptyState, type State } from "../../src/state/types.js";

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "curator-")), "nested", "state.json");
}

describe("JsonFileStateStore", () => {
  it("returns an empty state when the file does not exist", async () => {
    const store = new JsonFileStateStore(await tempPath());
    expect(await store.load()).toEqual(emptyState());
  });

  it("round-trips state, creating directories and leaving no temp file behind", async () => {
    const path = await tempPath();
    const store = new JsonFileStateStore(path);
    const state: State = {
      version: 1,
      shelves: [{ collectionId: "boxset-1", title: "T", blurb: "b", itemIds: ["m1"], createdAt: "2026-09-04T00:00:00.000Z", origin: "planned" }],
      retired: [{ title: "Old", retiredAt: "2026-09-01T00:00:00.000Z" }],
      lastRun: { at: "2026-09-04T04:00:00.000Z", inputTokens: 10, outputTokens: 2 },
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(await readdir(join(path, ".."))).toEqual(["state.json"]);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("refuses a corrupt or foreign file instead of silently starting over", async () => {
    const path = await tempPath();
    const store = new JsonFileStateStore(path);
    await store.save(emptyState());
    await writeFile(path, '{"version": 2}', "utf8");
    await expect(store.load()).rejects.toThrow();
    await writeFile(path, "not json", "utf8");
    await expect(store.load()).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run test/state/store.test.ts`
Expected: FAIL, cannot find module `../../src/state/store.js`.

- [ ] **Step 4: Write `src/state/store.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StateSchema, emptyState, type State } from "./types.js";

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

/** Ownership lives here. Writes are atomic (temp file + rename) because a
 * half-written state file would make the next run forget collections it owns. */
export class JsonFileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    return StateSchema.parse(JSON.parse(raw));
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.path);
  }
}
```

- [ ] **Step 5: Write `test/fakes/state.ts`**

```ts
import type { StateStore } from "../../src/state/store.js";
import { emptyState, type State } from "../../src/state/types.js";

/** In-memory store that counts saves, so tests can assert "saved after every write". */
export class MemoryStateStore implements StateStore {
  saves = 0;

  constructor(public state: State = emptyState()) {}

  async load(): Promise<State> {
    return structuredClone(this.state);
  }

  async save(state: State): Promise<void> {
    this.state = structuredClone(state);
    this.saves += 1;
  }
}
```

- [ ] **Step 6: Run the store test, then the full gate**

Run: `pnpm vitest run test/state && pnpm typecheck && pnpm lint && pnpm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/state test/state test/fakes/state.ts
git commit -m "feat: ownership state file"
```

---

### Task 9: Reconcile and rotate (pure)

**Files:**
- Create: `src/sync/reconcile.ts`, `src/sync/rotate.ts`
- Test: `test/sync/reconcile.test.ts`, `test/sync/rotate.test.ts`

**Interfaces:**
- Consumes: `State`, `OwnedShelf` (Task 8).
- Produces: `reconcileOwned(state, tagged: { Id; Name }[], now: Date): { state; dropped: OwnedShelf[]; adopted: OwnedShelf[] }`; `RotationPolicy { shelfCount; rotatePerRun; fullRefresh }`, `RotationDecision { keep: OwnedShelf[]; retire: OwnedShelf[]; wanted: number }`, `rotate(state, policy): RotationDecision`.

- [ ] **Step 1: Write the failing reconcile test**

`test/sync/reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { State } from "../../src/state/types.js";
import { reconcileOwned } from "../../src/sync/reconcile.js";

const now = new Date("2026-09-04T04:00:00.000Z");
const state: State = {
  version: 1,
  shelves: [
    { collectionId: "boxset-1", title: "Kept", blurb: "", itemIds: [], createdAt: "2026-09-01T00:00:00.000Z", origin: "planned" },
    { collectionId: "boxset-2", title: "Vanished", blurb: "", itemIds: [], createdAt: "2026-09-02T00:00:00.000Z", origin: "planned" },
  ],
  retired: [],
};

describe("reconcileOwned", () => {
  it("drops shelves Jellyfin no longer has and adopts tagged strangers as orphans", () => {
    const result = reconcileOwned(state, [{ Id: "boxset-1", Name: "Kept" }, { Id: "boxset-9", Name: "Stranger" }], now);
    expect(result.dropped.map((s) => s.collectionId)).toEqual(["boxset-2"]);
    expect(result.adopted).toEqual([
      { collectionId: "boxset-9", title: "Stranger", blurb: "", itemIds: [], createdAt: now.toISOString(), origin: "orphan" },
    ]);
    expect(result.state.shelves.map((s) => s.collectionId)).toEqual(["boxset-1", "boxset-9"]);
    expect(result.state.retired).toEqual([]);
  });

  it("is a no-op when everything matches", () => {
    const result = reconcileOwned(state, [{ Id: "boxset-1", Name: "Kept" }, { Id: "boxset-2", Name: "Vanished" }], now);
    expect(result.dropped).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(result.state).toEqual(state);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/sync/reconcile.test.ts`
Expected: FAIL, cannot find module `../../src/sync/reconcile.js`.

- [ ] **Step 3: Write `src/sync/reconcile.ts`**

```ts
import type { OwnedShelf, State } from "../state/types.js";

export interface ReconcileResult {
  state: State;
  /** In state, but Jellyfin no longer has them (someone deleted by hand). */
  dropped: OwnedShelf[];
  /** Tagged in Jellyfin, unknown to state (state file lost, or a hand-added tag). */
  adopted: OwnedShelf[];
}

/** Make state agree with what Jellyfin actually holds under our tag. */
export function reconcileOwned(state: State, tagged: Array<{ Id: string; Name: string }>, now: Date): ReconcileResult {
  const taggedIds = new Set(tagged.map((t) => t.Id));
  const known = new Set(state.shelves.map((s) => s.collectionId));
  const dropped = state.shelves.filter((s) => !taggedIds.has(s.collectionId));
  const kept = state.shelves.filter((s) => taggedIds.has(s.collectionId));
  const adopted: OwnedShelf[] = tagged
    .filter((t) => !known.has(t.Id))
    .map((t) => ({ collectionId: t.Id, title: t.Name, blurb: "", itemIds: [], createdAt: now.toISOString(), origin: "orphan" }));
  return { state: { ...state, shelves: [...kept, ...adopted] }, dropped, adopted };
}
```

- [ ] **Step 4: Run the reconcile test**

Run: `pnpm vitest run test/sync/reconcile.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing rotate test**

`test/sync/rotate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { OwnedShelf, State } from "../../src/state/types.js";
import { rotate } from "../../src/sync/rotate.js";

const shelf = (n: number, origin: OwnedShelf["origin"] = "planned"): OwnedShelf => ({
  collectionId: `boxset-${n}`,
  title: `Shelf ${n}`,
  blurb: "",
  itemIds: [],
  createdAt: `2026-09-0${n}T00:00:00.000Z`,
  origin,
});
const withShelves = (shelves: OwnedShelf[]): State => ({ version: 1, shelves, retired: [] });
const policy = { shelfCount: 6, rotatePerRun: 2, fullRefresh: false };
const ids = (list: OwnedShelf[]): string[] => list.map((s) => s.collectionId);

describe("rotate", () => {
  it.each([
    { name: "first run wants a full set", shelves: [] as OwnedShelf[], p: policy, retire: [] as string[], keep: [] as string[], wanted: 6 },
    {
      name: "steady state retires the two oldest regardless of input order",
      shelves: [shelf(3), shelf(1), shelf(6), shelf(2), shelf(5), shelf(4)],
      p: policy,
      retire: ["boxset-1", "boxset-2"],
      keep: ["boxset-3", "boxset-4", "boxset-5", "boxset-6"],
      wanted: 2,
    },
    {
      name: "orphans go first even when newer",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6, "orphan")],
      p: policy,
      retire: ["boxset-6", "boxset-1"],
      keep: ["boxset-2", "boxset-3", "boxset-4", "boxset-5"],
      wanted: 2,
    },
    {
      name: "full refresh retires everything",
      shelves: [shelf(1), shelf(2), shelf(3)],
      p: { ...policy, fullRefresh: true },
      retire: ["boxset-1", "boxset-2", "boxset-3"],
      keep: [],
      wanted: 6,
    },
    {
      name: "overflow after lowering shelfCount retires the extras",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6), shelf(7), shelf(8)],
      p: { shelfCount: 5, rotatePerRun: 2, fullRefresh: false },
      retire: ["boxset-1", "boxset-2", "boxset-3"],
      keep: ["boxset-4", "boxset-5", "boxset-6", "boxset-7", "boxset-8"],
      wanted: 0,
    },
    {
      name: "rotatePerRun 0 keeps a full set untouched",
      shelves: [shelf(1), shelf(2), shelf(3), shelf(4), shelf(5), shelf(6)],
      p: { ...policy, rotatePerRun: 0 },
      retire: [],
      keep: ["boxset-1", "boxset-2", "boxset-3", "boxset-4", "boxset-5", "boxset-6"],
      wanted: 0,
    },
    {
      name: "a short set still rotates and tops up",
      shelves: [shelf(1), shelf(2), shelf(3)],
      p: policy,
      retire: ["boxset-1", "boxset-2"],
      keep: ["boxset-3"],
      wanted: 5,
    },
    {
      name: "three orphans all go even though rotatePerRun is 2",
      shelves: [shelf(1, "orphan"), shelf(2, "orphan"), shelf(3, "orphan"), shelf(4)],
      p: policy,
      retire: ["boxset-1", "boxset-2", "boxset-3"],
      keep: ["boxset-4"],
      wanted: 5,
    },
  ])("$name", ({ shelves, p, retire, keep, wanted }) => {
    const decision = rotate(withShelves(shelves), p);
    expect(ids(decision.retire)).toEqual(retire);
    expect(ids(decision.keep)).toEqual(keep);
    expect(decision.wanted).toBe(wanted);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run test/sync/rotate.test.ts`
Expected: FAIL, cannot find module `../../src/sync/rotate.js`.

- [ ] **Step 7: Write `src/sync/rotate.ts`**

```ts
import type { OwnedShelf, State } from "../state/types.js";

export interface RotationPolicy {
  shelfCount: number;
  rotatePerRun: number;
  fullRefresh: boolean;
}

export interface RotationDecision {
  keep: OwnedShelf[];
  retire: OwnedShelf[];
  /** How many new shelves the planner should produce so keep + new = shelfCount. */
  wanted: number;
}

/** Orphans first, then oldest first; ties broken by collection id so the
 * decision is stable. Retire count is the largest of: the configured
 * rotation, the overflow above shelfCount, and the number of orphans. */
export function rotate(state: State, policy: RotationPolicy): RotationDecision {
  const ordered = [...state.shelves].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === "orphan" ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0;
  });
  const overflow = Math.max(0, ordered.length - policy.shelfCount);
  const orphans = ordered.filter((s) => s.origin === "orphan").length;
  const retireCount = policy.fullRefresh ? ordered.length : Math.min(ordered.length, Math.max(policy.rotatePerRun, overflow, orphans));
  const retire = ordered.slice(0, retireCount);
  const keep = ordered.slice(retireCount);
  return { keep, retire, wanted: Math.max(0, policy.shelfCount - keep.length) };
}
```

- [ ] **Step 8: Run the rotate test, then the full gate**

Run: `pnpm vitest run test/sync && pnpm typecheck && pnpm lint && pnpm test`
Expected: green (8 rotate cases).

- [ ] **Step 9: Commit**

```bash
git add src/sync/reconcile.ts src/sync/rotate.ts test/sync/reconcile.test.ts test/sync/rotate.test.ts
git commit -m "feat: reconcile owned collections and rotation policy"
```

---

### Task 10: applyPlan — the only writer

**Files:**
- Create: `src/sync/apply.ts`
- Test: `test/sync/apply.test.ts`

**Interfaces:**
- Consumes: `JellyfinClient` (Task 3), `Logger` (Task 2), `Shelf` (Task 6), `StateStore`, `State`, `OwnedShelf` (Task 8), `CURATOR_TAG`, `RETIRED_HISTORY_LIMIT` (Task 1), fakes from Tasks 4 and 8.
- Produces: `ApplyInput { retire: OwnedShelf[]; create: Shelf[]; dryRun: boolean; now: () => Date }`, `ApplyReport { retired: string[]; created: { collectionId; title }[]; skipped: { title; reason }[] }`, `applyPlan(client, store, state, input, log): Promise<{ state: State; report: ApplyReport }>`.

- [ ] **Step 1: Write the failing apply test**

`test/sync/apply.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CURATOR_TAG } from "../../src/constants.js";
import { MemoryLogger } from "../../src/log.js";
import { emptyState, type OwnedShelf, type State } from "../../src/state/types.js";
import { applyPlan } from "../../src/sync/apply.js";
import { FakeJellyfinClient } from "../fakes/jellyfin.js";
import { MemoryStateStore } from "../fakes/state.js";

const now = (): Date => new Date("2026-09-04T04:00:00.000Z");
const shelfIn = (title: string, itemIds: string[]) => ({ title, blurb: `About ${title}`, itemIds, rationale: "r" });

async function ownedCollection(fake: FakeJellyfinClient, title: string, createdAt: string, tagged = true): Promise<OwnedShelf> {
  const id = await fake.createCollection(title, ["m1"]);
  if (tagged) await fake.updateItem({ ...(await fake.getItem(id))!, Tags: [CURATOR_TAG] });
  return { collectionId: id, title, blurb: "", itemIds: ["m1"], createdAt, origin: "planned" };
}

describe("applyPlan", () => {
  it("creates, tags and describes each new collection, saving state after every write", async () => {
    const fake = new FakeJellyfinClient();
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const { state, report } = await applyPlan(
      fake,
      store,
      emptyState(),
      { retire: [], create: [shelfIn("One", ["m1", "m2"]), shelfIn("Two", ["m3"])], dryRun: false, now },
      log,
    );
    expect(report.created.map((c) => c.title)).toEqual(["One", "Two"]);
    expect(state.shelves.map((s) => s.collectionId)).toEqual(["boxset-1", "boxset-2"]);
    expect(state.shelves[0]).toMatchObject({ title: "One", blurb: "About One", itemIds: ["m1", "m2"], createdAt: now().toISOString(), origin: "planned" });
    const dto = (await fake.getItem("boxset-1"))!;
    expect(dto.Tags).toEqual([CURATOR_TAG]);
    expect(dto.Overview).toBe("About One");
    expect(fake.collections.get("boxset-1")).toEqual({ name: "One", itemIds: ["m1", "m2"] });
    expect(store.saves).toBe(2);
    expect(store.state).toEqual(state);
  });

  it("retires only guarded collections, drops vanished ones, records history", async () => {
    const fake = new FakeJellyfinClient();
    const tagged = await ownedCollection(fake, "Tagged", "2026-09-01T00:00:00.000Z");
    const untagged = await ownedCollection(fake, "Untagged", "2026-09-02T00:00:00.000Z", false);
    fake.addItem({ Id: "movie-x", Name: "Not a collection", Type: "Movie", Tags: [CURATOR_TAG] });
    const notBoxSet: OwnedShelf = { collectionId: "movie-x", title: "Movie", blurb: "", itemIds: [], createdAt: "2026-09-03T00:00:00.000Z", origin: "planned" };
    const gone: OwnedShelf = { collectionId: "boxset-404", title: "Gone", blurb: "", itemIds: [], createdAt: "2026-09-03T00:00:00.000Z", origin: "planned" };
    const state: State = { version: 1, shelves: [tagged, untagged, notBoxSet, gone], retired: [] };
    const store = new MemoryStateStore(state);
    const log = new MemoryLogger();

    const result = await applyPlan(fake, store, state, { retire: [tagged, untagged, notBoxSet, gone], create: [], dryRun: false, now }, log);

    expect(fake.deleted).toEqual([tagged.collectionId]);
    expect(result.report.retired).toEqual(["Tagged"]);
    expect(result.report.skipped.map((s) => s.title)).toEqual(["Untagged", "Movie"]);
    expect(result.state.shelves.map((s) => s.title)).toEqual(["Untagged", "Movie"]);
    expect(result.state.retired).toEqual([
      { title: "Tagged", retiredAt: now().toISOString() },
      { title: "Gone", retiredAt: now().toISOString() },
    ]);
    expect(log.lines.filter((l) => l.startsWith("error"))).toHaveLength(2);
    expect(log.lines.some((l) => l.includes("Gone") && l.includes("no longer exists"))).toBe(true);
    expect(store.saves).toBe(2);
  });

  it("caps retired history at 30 titles, newest last", async () => {
    const fake = new FakeJellyfinClient();
    const owned = await ownedCollection(fake, "Newest", "2026-09-03T00:00:00.000Z");
    const retired = Array.from({ length: 30 }, (_, i) => ({ title: `Old ${i}`, retiredAt: "2026-08-01T00:00:00.000Z" }));
    const state: State = { version: 1, shelves: [owned], retired };
    const result = await applyPlan(fake, new MemoryStateStore(state), state, { retire: [owned], create: [], dryRun: false, now }, new MemoryLogger());
    expect(result.state.retired).toHaveLength(30);
    expect(result.state.retired[0]!.title).toBe("Old 1");
    expect(result.state.retired[29]!.title).toBe("Newest");
  });

  it("dry run reads but never writes", async () => {
    const fake = new FakeJellyfinClient();
    const owned = await ownedCollection(fake, "Live", "2026-09-01T00:00:00.000Z");
    const state: State = { version: 1, shelves: [owned], retired: [] };
    const store = new MemoryStateStore(state);
    const log = new MemoryLogger();
    const result = await applyPlan(fake, store, state, { retire: [owned], create: [shelfIn("New", ["m1"])], dryRun: true, now }, log);
    expect(fake.deleted).toEqual([]);
    expect(fake.collections.size).toBe(1);
    expect(store.saves).toBe(0);
    expect(result.state).toEqual(state);
    expect(result.report.retired).toEqual(["Live"]);
    expect(result.report.created.map((c) => c.title)).toEqual(["New"]);
    expect(log.lines.filter((l) => l.includes("[dry-run]"))).toHaveLength(2);
  });

  it("a failed create is skipped and the rest still land", async () => {
    const fake = new FakeJellyfinClient();
    fake.failCreateFor.add("Broken");
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const { state, report } = await applyPlan(fake, store, emptyState(), { retire: [], create: [shelfIn("Broken", ["m1"]), shelfIn("Fine", ["m2"])], dryRun: false, now }, log);
    expect(report.skipped).toEqual([{ title: "Broken", reason: expect.stringContaining("Broken") }]);
    expect(state.shelves.map((s) => s.title)).toEqual(["Fine"]);
    expect(store.saves).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/sync/apply.test.ts`
Expected: FAIL, cannot find module `../../src/sync/apply.js`.

- [ ] **Step 3: Write `src/sync/apply.ts`**

```ts
import { CURATOR_TAG, RETIRED_HISTORY_LIMIT } from "../constants.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import type { Logger } from "../log.js";
import type { Shelf } from "../planner/schema.js";
import type { StateStore } from "../state/store.js";
import type { OwnedShelf, State } from "../state/types.js";

export interface ApplyInput {
  retire: OwnedShelf[];
  create: Shelf[];
  dryRun: boolean;
  now: () => Date;
}

export interface ApplyReport {
  retired: string[];
  created: { collectionId: string; title: string }[];
  skipped: { title: string; reason: string }[];
}

export interface ApplyResult {
  state: State;
  report: ApplyReport;
}

function withoutShelf(state: State, shelf: OwnedShelf, retiredAt: Date): State {
  const retired = [...state.retired, { title: shelf.title, retiredAt: retiredAt.toISOString() }].slice(-RETIRED_HISTORY_LIMIT);
  return { ...state, shelves: state.shelves.filter((s) => s.collectionId !== shelf.collectionId), retired };
}

/** The only code that writes to Jellyfin. Retires first (guarded), then
 * creates. State is saved after every successful write so a crash mid-run
 * leaves it truthful. Dry run performs the reads and none of the writes. */
export async function applyPlan(client: JellyfinClient, store: StateStore, state: State, input: ApplyInput, log: Logger): Promise<ApplyResult> {
  let next: State = structuredClone(state);
  const report: ApplyReport = { retired: [], created: [], skipped: [] };

  for (const shelf of input.retire) {
    const item = await client.getItem(shelf.collectionId);
    if (!item) {
      log.warn(`retire "${shelf.title}": ${shelf.collectionId} no longer exists; dropping from state`);
      if (!input.dryRun) {
        next = withoutShelf(next, shelf, input.now());
        await store.save(next);
      }
      continue;
    }
    const tagged = (item.Tags ?? []).includes(CURATOR_TAG);
    if (item.Type !== "BoxSet" || !tagged) {
      log.error(`retire "${shelf.title}": refusing to delete ${shelf.collectionId} (Type=${item.Type}, tagged=${String(tagged)})`);
      report.skipped.push({ title: shelf.title, reason: "delete guard failed" });
      continue;
    }
    if (input.dryRun) {
      log.info(`[dry-run] would retire "${shelf.title}" (${shelf.collectionId})`);
      report.retired.push(shelf.title);
      continue;
    }
    await client.deleteItem(shelf.collectionId);
    next = withoutShelf(next, shelf, input.now());
    await store.save(next);
    report.retired.push(shelf.title);
    log.info(`retired "${shelf.title}"`);
  }

  for (const shelf of input.create) {
    if (input.dryRun) {
      log.info(`[dry-run] would create "${shelf.title}" with ${shelf.itemIds.length} items`);
      report.created.push({ collectionId: "(dry-run)", title: shelf.title });
      continue;
    }
    try {
      const collectionId = await client.createCollection(shelf.title, shelf.itemIds);
      const dto = await client.getItem(collectionId);
      if (!dto) throw new Error(`created collection ${collectionId} could not be read back`);
      const tags = Array.from(new Set([...(dto.Tags ?? []), CURATOR_TAG]));
      await client.updateItem({ ...dto, Tags: tags, Overview: shelf.blurb });
      const owned: OwnedShelf = {
        collectionId,
        title: shelf.title,
        blurb: shelf.blurb,
        itemIds: [...shelf.itemIds],
        createdAt: input.now().toISOString(),
        origin: "planned",
      };
      next = { ...next, shelves: [...next.shelves, owned] };
      await store.save(next);
      report.created.push({ collectionId, title: shelf.title });
      log.info(`created "${shelf.title}" (${collectionId}, ${shelf.itemIds.length} items)`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`create "${shelf.title}" failed: ${reason}`);
      report.skipped.push({ title: shelf.title, reason });
    }
  }

  return { state: next, report };
}
```

- [ ] **Step 4: Run the apply test, then the full gate**

Run: `pnpm vitest run test/sync/apply.test.ts && pnpm typecheck && pnpm lint && pnpm test`
Expected: green (5 apply tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/apply.ts test/sync/apply.test.ts
git commit -m "feat: guarded collection writer"
```

---
### Task 11: Home-row slots (Collection Sections plugin)

**Files:**
- Create: `src/homerows/slots.ts`
- Test: `test/homerows/slots.test.ts`

**Interfaces:**
- Consumes: `JellyfinClient` (Task 3), `Logger` (Task 2), `OwnedShelf` (Task 8), `SLOT_PREFIX`, `COLLECTION_SECTIONS_PLUGIN_ID`, `HOME_SCREEN_BUST_CACHE_PATH` (Task 1).
- Produces: `SlotEntry { UniqueId; DisplayText; CollectionName; SectionType: "Collection" | "Playlist" }`, `CollectionSectionsConfig { Sections?: Partial<SlotEntry>[] | null; [extra: string]: unknown }`, `SlotWriteResult { written; foreignKept }`, `buildSlots(shelves, slotCount): SlotEntry[]`, `mergeSlots(existing | undefined, slots): { config; foreignKept }`, `writeHomeRowSlots(client, shelves, { slotCount, dryRun }, log): Promise<SlotWriteResult | undefined>` (undefined = plugin not installed).

Why the shape: the plugin's `PluginConfiguration` is `{ Sections: SectionsConfig[] }` with `SectionsConfig { UniqueId, DisplayText, CollectionName, SectionType }` (its `Configuration/SectionsConfig.cs`); the plugin matches a section to a BoxSet by exact `CollectionName`, and re-registers every section with Home Screen Sections in its `ConfigurationChanged` handler, so saving the config is enough.

- [ ] **Step 1: Write the failing slots test**

`test/homerows/slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COLLECTION_SECTIONS_PLUGIN_ID } from "../../src/constants.js";
import { buildSlots, mergeSlots, writeHomeRowSlots } from "../../src/homerows/slots.js";
import { MemoryLogger } from "../../src/log.js";
import type { OwnedShelf } from "../../src/state/types.js";
import { FakeJellyfinClient } from "../fakes/jellyfin.js";

const shelf = (n: number): OwnedShelf => ({
  collectionId: `boxset-${n}`,
  title: `Shelf ${n}`,
  blurb: "",
  itemIds: [],
  createdAt: `2026-09-0${n}T00:00:00.000Z`,
  origin: "planned",
});

describe("buildSlots", () => {
  it("assigns stable ids newest first and caps at slotCount", () => {
    expect(buildSlots([shelf(1), shelf(3), shelf(2)], 2)).toEqual([
      { UniqueId: "curator-shelf-1", DisplayText: "Shelf 3", CollectionName: "Shelf 3", SectionType: "Collection" },
      { UniqueId: "curator-shelf-2", DisplayText: "Shelf 2", CollectionName: "Shelf 2", SectionType: "Collection" },
    ]);
  });

  it("writes fewer slots than slotCount when there are fewer shelves", () => {
    expect(buildSlots([shelf(1)], 6)).toHaveLength(1);
  });
});

describe("mergeSlots", () => {
  it("keeps foreign sections and other keys, replaces every curator slot", () => {
    const existing = {
      Sections: [
        { UniqueId: "trending", DisplayText: "Trending", CollectionName: "Trending", SectionType: "Collection" as const },
        { UniqueId: "curator-shelf-1", DisplayText: "Stale", CollectionName: "Stale", SectionType: "Collection" as const },
      ],
      SomethingElse: true,
    };
    const { config, foreignKept } = mergeSlots(existing, buildSlots([shelf(1)], 6));
    expect(foreignKept).toBe(1);
    expect(config.SomethingElse).toBe(true);
    expect(config.Sections!.map((s) => s.UniqueId)).toEqual(["trending", "curator-shelf-1"]);
    expect(config.Sections![1]!.DisplayText).toBe("Shelf 1");
  });

  it("tolerates a config with no Sections", () => {
    expect(mergeSlots({}, []).config).toEqual({ Sections: [] });
  });
});

describe("writeHomeRowSlots", () => {
  it("skips with a warning when the plugin is not installed", async () => {
    const fake = new FakeJellyfinClient();
    const log = new MemoryLogger();
    expect(await writeHomeRowSlots(fake, [shelf(1)], { slotCount: 6, dryRun: false }, log)).toBeUndefined();
    expect(log.lines[0]).toMatch(/^warn .*not installed/);
    expect(fake.pluginConfigs.size).toBe(0);
  });

  it("writes the merged config and busts the cache", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    const log = new MemoryLogger();
    const result = await writeHomeRowSlots(fake, [shelf(1), shelf(2)], { slotCount: 6, dryRun: false }, log);
    expect(result).toEqual({ written: 2, foreignKept: 0 });
    const written = fake.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID) as { Sections: { UniqueId: string }[] };
    expect(written.Sections.map((s) => s.UniqueId)).toEqual(["curator-shelf-1", "curator-shelf-2"]);
    expect(fake.actions).toEqual(["/HomeScreen/BustCache"]);
  });

  it("warns when the cache bust is refused", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    fake.actionStatus = 401;
    const log = new MemoryLogger();
    await writeHomeRowSlots(fake, [shelf(1)], { slotCount: 6, dryRun: false }, log);
    expect(log.lines.some((l) => l.startsWith("warn") && l.includes("401"))).toBe(true);
  });

  it("dry run reads the config and writes nothing", async () => {
    const fake = new FakeJellyfinClient();
    fake.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [{ UniqueId: "keep" }] });
    const log = new MemoryLogger();
    const result = await writeHomeRowSlots(fake, [shelf(1)], { slotCount: 6, dryRun: true }, log);
    expect(result).toEqual({ written: 1, foreignKept: 1 });
    expect(fake.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID)).toEqual({ Sections: [{ UniqueId: "keep" }] });
    expect(fake.actions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/homerows/slots.test.ts`
Expected: FAIL, cannot find module `../../src/homerows/slots.js`.

- [ ] **Step 3: Write `src/homerows/slots.ts`**

```ts
import { COLLECTION_SECTIONS_PLUGIN_ID, HOME_SCREEN_BUST_CACHE_PATH, SLOT_PREFIX } from "../constants.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import type { Logger } from "../log.js";
import type { OwnedShelf } from "../state/types.js";

/** Mirrors Jellyfin.Plugin.CollectionSections.Configuration.SectionsConfig. */
export interface SlotEntry {
  UniqueId: string;
  DisplayText: string;
  CollectionName: string;
  SectionType: "Collection" | "Playlist";
}

export interface CollectionSectionsConfig {
  Sections?: Array<Partial<SlotEntry>> | null;
  [extra: string]: unknown;
}

export interface SlotWriteResult {
  written: number;
  foreignKept: number;
}

/** Newest shelves first, one slot each, at most slotCount. Slot ids are stable
 * across runs so a user's "enabled sections" choice survives rotation. */
export function buildSlots(shelves: OwnedShelf[], slotCount: number): SlotEntry[] {
  return [...shelves]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0;
    })
    .slice(0, slotCount)
    .map((shelf, index) => ({
      UniqueId: `${SLOT_PREFIX}${index + 1}`,
      DisplayText: shelf.title,
      CollectionName: shelf.title,
      SectionType: "Collection" as const,
    }));
}

/** Keeps every section the service did not create; replaces all of ours. */
export function mergeSlots(existing: CollectionSectionsConfig | undefined, slots: SlotEntry[]): { config: CollectionSectionsConfig; foreignKept: number } {
  const foreign = (existing?.Sections ?? []).filter((section) => !(section.UniqueId ?? "").startsWith(SLOT_PREFIX));
  return { config: { ...(existing ?? {}), Sections: [...foreign, ...slots] }, foreignKept: foreign.length };
}

function asConfig(value: unknown): CollectionSectionsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("Collection Sections configuration is not a JSON object");
  return value as CollectionSectionsConfig;
}

export async function writeHomeRowSlots(
  client: JellyfinClient,
  shelves: OwnedShelf[],
  options: { slotCount: number; dryRun: boolean },
  log: Logger,
): Promise<SlotWriteResult | undefined> {
  const existing = asConfig(await client.getPluginConfiguration(COLLECTION_SECTIONS_PLUGIN_ID));
  if (existing === undefined) {
    log.warn("Collection Sections plugin not installed (no configuration at its plugin id); skipping home rows");
    return undefined;
  }
  const slots = buildSlots(shelves, options.slotCount);
  const { config, foreignKept } = mergeSlots(existing, slots);
  if (options.dryRun) {
    log.info(`[dry-run] would write ${slots.length} home-row slots (${foreignKept} foreign sections kept)`);
    return { written: slots.length, foreignKept };
  }
  await client.setPluginConfiguration(COLLECTION_SECTIONS_PLUGIN_ID, config);
  const status = await client.postAction(HOME_SCREEN_BUST_CACHE_PATH);
  if (status !== 200) log.warn(`Home Screen Sections cache bust returned ${status}; rows may lag up to 24 h`);
  log.info(`wrote ${slots.length} home-row slots (${foreignKept} foreign sections kept)`);
  return { written: slots.length, foreignKept };
}
```

- [ ] **Step 4: Run the slots test, then the full gate**

Run: `pnpm vitest run test/homerows && pnpm typecheck && pnpm lint && pnpm test`
Expected: green (8 slot tests).

- [ ] **Step 5: Commit**

```bash
git add src/homerows test/homerows
git commit -m "feat: write Collection Sections home-row slots"
```

---

### Task 12: runCuration — one run end to end

**Files:**
- Create: `src/run.ts`
- Test: `test/run.test.ts`

**Interfaces:**
- Consumes: everything above. Exact names: `buildCatalog`, `aggregateSignals` (Task 5), `renderCatalog` (Task 5), `validatePlan`, `ValidationResult` (Task 6), `ShelfPlanner`, `PlanUsage` (Task 7), `Shelf` (Task 6), `StateStore` (Task 8), `reconcileOwned`, `rotate` (Task 9), `applyPlan` (Task 10), `writeHomeRowSlots`, `SlotWriteResult` (Task 11), `Config` (Task 2), `Logger` (Task 2), `JellyfinClient`, `ItemKind`, `JellyfinItem` (Task 3).
- Produces: `RunOptions { dryRun; fullRefresh }`, `RunDeps { config; client; planner; store; log; now }`, `RunSummary = { outcome: "completed"; kept: string[]; retired: string[]; created: string[]; skipped: { title; reason }[]; usage: PlanUsage; estimatedCostUsd: number; homeRows?: SlotWriteResult } | { outcome: "library-too-small"; catalogSize; required }`, `runCuration(deps, options): Promise<RunSummary>`, `estimateCostUsd(usage): number`.

- [ ] **Step 1: Write the failing run test**

`test/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { COLLECTION_SECTIONS_PLUGIN_ID, CURATOR_TAG } from "../src/constants.js";
import { JellyfinHttpError } from "../src/jellyfin/client.js";
import { MemoryLogger } from "../src/log.js";
import { runCuration, type RunDeps } from "../src/run.js";
import { FakeJellyfinClient } from "./fakes/jellyfin.js";
import { chunkShelves, FakeShelfPlanner } from "./fakes/planner.js";
import { MemoryStateStore } from "./fakes/state.js";

const env = { JELLYFIN_URL: "http://fake", JELLYFIN_API_KEY: "k", CURATOR_STATE_PATH: "/unused" };

interface World {
  client: FakeJellyfinClient;
  planner: FakeShelfPlanner;
  store: MemoryStateStore;
  log: MemoryLogger;
  now: () => Date;
  advanceDay: () => void;
  deps: RunDeps;
}

function world(itemCount = 60, extraEnv: Record<string, string> = {}): World {
  const client = new FakeJellyfinClient();
  for (let i = 1; i <= itemCount; i++) {
    client.addItem({ Id: `m${i}`, Name: `Movie ${i}`, Type: i % 5 === 0 ? "Series" : "Movie", Genres: ["Drama"], Overview: `Plot ${i}` });
  }
  client.users = [{ Id: "u1", Name: "Admin" }, { Id: "u2", Name: "Guest" }];
  client.played.set("u1", new Set(["m1", "m2"]));
  client.favorites.set("u2", new Set(["m1"]));
  const planner = new FakeShelfPlanner((request) => chunkShelves(request, 8));
  const store = new MemoryStateStore();
  const log = new MemoryLogger();
  let clock = new Date("2026-09-04T04:00:00.000Z");
  const now = (): Date => clock;
  const advanceDay = (): void => {
    clock = new Date(clock.getTime() + 86_400_000);
  };
  const config = loadConfig({ ...env, ...extraEnv });
  return { client, planner, store, log, now, advanceDay, deps: { config, client, planner, store, log, now } };
}

describe("runCuration", () => {
  it("first run plans a full set, creates tagged collections and records state", async () => {
    const w = world();
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(6);
    expect(summary.retired).toEqual([]);
    expect(w.planner.requests[0]).toMatchObject({ wanted: 6, minItems: 8, maxItems: 20, avoidThemes: [] });
    expect(w.planner.requests[0]!.catalogText.split("\n")).toHaveLength(60);
    expect(w.planner.requests[0]!.catalogText).toContain("m1|M|Movie 1 (-)|Drama|-|-|||w1f1|Plot 1");
    expect(w.client.collections.size).toBe(6);
    for (const id of w.client.collections.keys()) expect((await w.client.getItem(id))!.Tags).toEqual([CURATOR_TAG]);
    expect(w.store.state.shelves).toHaveLength(6);
    expect(w.store.state.lastRun).toEqual({ at: w.now().toISOString(), inputTokens: 1000, outputTokens: 100 });
    expect(summary.estimatedCostUsd).toBeCloseTo(0.0075, 4);
    expect(w.log.lines.some((l) => l.includes('planned "Shelf 1"') && l.includes("Movie 1"))).toBe(true);
  });

  it("the next run retires the two oldest, avoids every live and retired theme, and tops up", async () => {
    const w = world();
    await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    w.advanceDay();
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.retired).toEqual(["Shelf 1", "Shelf 2"]);
    expect(summary.created).toEqual(["Shelf 7", "Shelf 8"]);
    expect(summary.kept).toEqual(["Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6"]);
    const second = w.planner.requests[1]!;
    expect(second.wanted).toBe(2);
    expect(second.avoidThemes).toEqual(["Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6", "Shelf 1", "Shelf 2"]);
    expect(w.client.deleted).toEqual(["boxset-1", "boxset-2"]);
    expect(w.store.state.shelves.map((s) => s.title)).toEqual(["Shelf 3", "Shelf 4", "Shelf 5", "Shelf 6", "Shelf 7", "Shelf 8"]);
    expect(w.store.state.retired.map((r) => r.title)).toEqual(["Shelf 1", "Shelf 2"]);
  });

  it("asks a second time when the first answer is short, then ships what survived", async () => {
    const w = world();
    let calls = 0;
    w.planner = new FakeShelfPlanner((request) => {
      calls += 1;
      return calls === 1 ? chunkShelves(request, 8).slice(0, 4) : chunkShelves(request, 8, "Extra", 5).slice(0, 1);
    });
    w.deps.planner = w.planner;
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(w.planner.requests.map((r) => r.wanted)).toEqual([6, 2]);
    expect(w.planner.requests[1]!.avoidThemes).toEqual(["Shelf 1", "Shelf 2", "Shelf 3", "Shelf 4"]);
    expect(summary.created).toEqual(["Shelf 1", "Shelf 2", "Shelf 3", "Shelf 4", "Extra 1"]);
    expect(summary.usage).toEqual({ inputTokens: 2000, outputTokens: 200 });
    expect(w.log.lines.some((l) => l.includes("still short"))).toBe(true);
  });

  it("stops before planning when the library is too small", async () => {
    const w = world(20);
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    expect(summary).toEqual({ outcome: "library-too-small", catalogSize: 20, required: 48 });
    expect(w.planner.requests).toEqual([]);
    expect(w.store.saves).toBe(0);
  });

  it("dry run plans but writes nothing anywhere", async () => {
    const w = world(60, { CURATOR_HOME_ROWS: "true" });
    w.client.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    const summary = await runCuration(w.deps, { dryRun: true, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(6);
    expect(w.client.collections.size).toBe(0);
    expect(w.store.saves).toBe(0);
    expect(w.client.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID)).toEqual({ Sections: [] });
    expect(w.client.actions).toEqual([]);
    expect(w.log.lines.filter((l) => l.includes("[dry-run]"))).toHaveLength(7);
  });

  it("writes home-row slots for the live shelves when enabled", async () => {
    const w = world(60, { CURATOR_HOME_ROWS: "true" });
    w.client.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, {
      Sections: [{ UniqueId: "trending", DisplayText: "Trending", CollectionName: "Trending", SectionType: "Collection" }],
    });
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.homeRows).toEqual({ written: 6, foreignKept: 1 });
    const config = w.client.pluginConfigs.get(COLLECTION_SECTIONS_PLUGIN_ID) as { Sections: { UniqueId: string }[] };
    expect(config.Sections.map((s) => s.UniqueId)).toEqual([
      "trending", "curator-shelf-1", "curator-shelf-2", "curator-shelf-3", "curator-shelf-4", "curator-shelf-5", "curator-shelf-6",
    ]);
    expect(w.client.actions).toEqual(["/HomeScreen/BustCache"]);
  });

  it("a home-row failure is a warning, not a failed run", async () => {
    const w = world(60, { CURATOR_HOME_ROWS: "true" });
    w.client.pluginConfigs.set(COLLECTION_SECTIONS_PLUGIN_ID, { Sections: [] });
    w.client.setPluginConfiguration = async () => {
      throw new JellyfinHttpError(500, "/Plugins/x/Configuration", "boom");
    };
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.created).toHaveLength(6);
    expect(summary.homeRows).toBeUndefined();
    expect(w.log.lines.some((l) => l.startsWith("warn") && l.includes("home rows not written"))).toBe(true);
  });

  it("adopts a tagged stranger as an orphan and retires it first", async () => {
    const w = world();
    const strangerId = await w.client.createCollection("Hand-made but tagged", ["m1"]);
    await w.client.updateItem({ ...(await w.client.getItem(strangerId))!, Tags: [CURATOR_TAG] });
    const summary = await runCuration(w.deps, { dryRun: false, fullRefresh: false });
    if (summary.outcome !== "completed") throw new Error(summary.outcome);
    expect(summary.retired).toEqual(["Hand-made but tagged"]);
    expect(w.client.deleted).toEqual([strangerId]);
    expect(w.planner.requests[0]!.wanted).toBe(6);
    expect(w.planner.requests[0]!.avoidThemes).toEqual(["Hand-made but tagged"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/run.test.ts`
Expected: FAIL, cannot find module `../src/run.js`.

- [ ] **Step 3: Write `src/run.ts`**

```ts
import { aggregateSignals, buildCatalog, type CatalogEntry } from "./catalog/build.js";
import { renderCatalog } from "./catalog/render.js";
import type { Config } from "./config.js";
import { CURATOR_TAG, OPUS_5_USD_PER_MTOK } from "./constants.js";
import { writeHomeRowSlots, type SlotWriteResult } from "./homerows/slots.js";
import type { JellyfinClient } from "./jellyfin/client.js";
import type { ItemKind, JellyfinItem } from "./jellyfin/types.js";
import type { Logger } from "./log.js";
import type { PlanUsage, ShelfPlanner } from "./planner/planner.js";
import type { Shelf } from "./planner/schema.js";
import { validatePlan, type ValidationResult } from "./planner/validate.js";
import type { StateStore } from "./state/store.js";
import { applyPlan } from "./sync/apply.js";
import { reconcileOwned } from "./sync/reconcile.js";
import { rotate } from "./sync/rotate.js";

export interface RunOptions {
  dryRun: boolean;
  fullRefresh: boolean;
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
      homeRows?: SlotWriteResult;
    }
  | { outcome: "library-too-small"; catalogSize: number; required: number };

const LIBRARY_TYPES: ItemKind[] = ["Movie", "Series"];
/** ProductionYear, CommunityRating and RunTimeTicks are in the default DTO; these are not. */
const CATALOG_FIELDS = ["Genres", "Overview", "People", "Tags", "Studios"];

export function estimateCostUsd(usage: PlanUsage): number {
  return (usage.inputTokens * OPUS_5_USD_PER_MTOK.input + usage.outputTokens * OPUS_5_USD_PER_MTOK.output) / 1_000_000;
}

function addUsage(a: PlanUsage, b: PlanUsage): PlanUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
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
  const items = await fetchLibrary(client, config.CURATOR_LIBRARY_IDS);
  const signals = await fetchSignals(client, log);
  const tagged = await client.queryItems({ includeItemTypes: ["BoxSet"], tags: [CURATOR_TAG], fields: ["Tags"] });
  const reconciled = reconcileOwned(loaded, tagged.map((t) => ({ Id: t.Id, Name: t.Name })), now());
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
  const avoidThemes = [...decision.keep, ...decision.retire].map((s) => s.title).concat(state.retired.map((r) => r.title));
  let usage: PlanUsage = { inputTokens: 0, outputTokens: 0 };
  let newShelves: Shelf[] = [];

  if (decision.wanted > 0) {
    const catalogText = renderCatalog(catalog, { includeOverviews: config.CURATOR_INCLUDE_OVERVIEWS });
    const bounds = { minItems: config.CURATOR_MIN_ITEMS, maxItems: config.CURATOR_MAX_ITEMS };
    const first = await planner.plan({ catalogText, wanted: decision.wanted, avoidThemes, ...bounds });
    usage = addUsage(usage, first.usage);
    let validated = validatePlan(first.shelves, catalogIds, { ...bounds, avoidTitles: avoidThemes });
    logValidation(validated, log);
    if (validated.shelves.length < decision.wanted) {
      const shortfall = decision.wanted - validated.shelves.length;
      log.warn(`planner returned ${validated.shelves.length}/${decision.wanted} usable shelves; asking once more for ${shortfall}`);
      const second = await planner.plan({
        catalogText,
        wanted: shortfall,
        avoidThemes: [...avoidThemes, ...validated.shelves.map((s) => s.title)],
        ...bounds,
      });
      usage = addUsage(usage, second.usage);
      validated = validatePlan([...validated.shelves, ...second.shelves], catalogIds, { ...bounds, avoidTitles: avoidThemes });
      logValidation(validated, log);
      if (validated.shelves.length < decision.wanted) log.warn(`still short: ${validated.shelves.length}/${decision.wanted}; shipping what survived`);
    }
    newShelves = validated.shelves.slice(0, decision.wanted);
    logShelves(newShelves, catalog, log);
  }

  const applied = await applyPlan(client, store, state, { retire: decision.retire, create: newShelves, dryRun: options.dryRun, now }, log);
  let finalState = applied.state;
  if (!options.dryRun) {
    finalState = { ...finalState, lastRun: { at: now().toISOString(), ...usage } };
    await store.save(finalState);
  }

  let homeRows: SlotWriteResult | undefined;
  if (config.CURATOR_HOME_ROWS) {
    try {
      homeRows = await writeHomeRowSlots(client, finalState.shelves, { slotCount: config.CURATOR_SHELF_COUNT, dryRun: options.dryRun }, log);
    } catch (err) {
      // Collections are already written; rows catch up on the next run (spec §8).
      log.warn(`home rows not written: ${err instanceof Error ? err.message : String(err)}; collections exist, rows catch up next run`);
    }
  }

  const estimatedCostUsd = estimateCostUsd(usage);
  log.info(`tokens in=${usage.inputTokens} out=${usage.outputTokens} (~$${estimatedCostUsd.toFixed(2)} at Opus 5 list price)`);
  return {
    outcome: "completed",
    kept: decision.keep.map((s) => s.title),
    retired: applied.report.retired,
    created: applied.report.created.map((c) => c.title),
    skipped: applied.report.skipped,
    usage,
    estimatedCostUsd,
    homeRows,
  };
}
```

- [ ] **Step 4: Run the run test, then the full gate**

Run: `pnpm vitest run test/run.test.ts && pnpm typecheck && pnpm lint && pnpm test`
Expected: green (8 run tests).

- [ ] **Step 5: Commit**

```bash
git add src/run.ts test/run.test.ts
git commit -m "feat: one curation run end to end"
```

---

### Task 13: CLI and entry point

**Files:**
- Create: `src/cli.ts`, `src/bin.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `Config`, `ConfigError` (Task 2), `HttpJellyfinClient`, `JellyfinHttpError`, `JellyfinClient` (Task 3), `consoleLogger`, `Logger` (Task 2), `ClaudeShelfPlanner`, `PlannerError`, `ShelfPlanner` (Task 7), `JsonFileStateStore`, `StateStore` (Task 8), `applyPlan` (Task 10), `writeHomeRowSlots` (Task 11), `runCuration`, `RunSummary` (Task 12).
- Produces: `CliCommand`, `parseCli(argv): CliCommand`, `EXIT = { ok: 0, failure: 1, jellyfin: 2, planner: 3, librarySmall: 4 }`, `USAGE`, `MainOverrides { client?; planner?; store?; now? }`, `main(argv, env?, log?, overrides?): Promise<number>`.

- [ ] **Step 1: Write the failing CLI test**

`test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EXIT, main, parseCli } from "../src/cli.js";
import { JellyfinHttpError } from "../src/jellyfin/client.js";
import { MemoryLogger } from "../src/log.js";
import { PlannerError } from "../src/planner/planner.js";
import { FakeJellyfinClient } from "./fakes/jellyfin.js";
import { chunkShelves, FakeShelfPlanner } from "./fakes/planner.js";
import { MemoryStateStore } from "./fakes/state.js";

const env = { JELLYFIN_URL: "http://fake", JELLYFIN_API_KEY: "k" };

function seededClient(count = 60): FakeJellyfinClient {
  const client = new FakeJellyfinClient();
  for (let i = 1; i <= count; i++) client.addItem({ Id: `m${i}`, Name: `Movie ${i}`, Type: "Movie" });
  return client;
}

describe("parseCli", () => {
  it("parses commands and flags", () => {
    expect(parseCli([])).toEqual({ command: "help" });
    expect(parseCli(["--help"])).toEqual({ command: "help" });
    expect(parseCli(["run"])).toEqual({ command: "run", dryRun: false, fullRefresh: false });
    expect(parseCli(["run", "--dry-run", "--full-refresh"])).toEqual({ command: "run", dryRun: true, fullRefresh: true });
    expect(parseCli(["status"])).toEqual({ command: "status" });
    expect(parseCli(["retire-all", "--yes"])).toEqual({ command: "retire-all", yes: true });
    expect(() => parseCli(["bogus"])).toThrow(/unknown command/);
  });
});

describe("main", () => {
  it("prints usage for help and fails on a bad command", async () => {
    const log = new MemoryLogger();
    expect(await main(["help"], env, log)).toBe(EXIT.ok);
    expect(log.lines[0]).toContain("Usage:");
    expect(await main(["bogus"], env, log)).toBe(EXIT.failure);
  });

  it("fails with the config problems listed", async () => {
    const log = new MemoryLogger();
    expect(await main(["status"], {}, log)).toBe(EXIT.failure);
    expect(log.lines[0]).toMatch(/JELLYFIN_URL/);
  });

  it("runs end to end with fakes and reports exit 0", async () => {
    const client = seededClient();
    const store = new MemoryStateStore();
    const log = new MemoryLogger();
    const code = await main(["run"], env, log, {
      client,
      store,
      planner: new FakeShelfPlanner((request) => chunkShelves(request, 8)),
      now: () => new Date("2026-09-04T04:00:00.000Z"),
    });
    expect(code).toBe(EXIT.ok);
    expect(store.state.shelves).toHaveLength(6);
    expect(log.lines.some((l) => l.includes("summary: kept 0, retired 0, created 6, skipped 0"))).toBe(true);
  });

  it("maps a planner failure to exit 3", async () => {
    const planner = new FakeShelfPlanner(() => {
      throw new PlannerError("boom");
    });
    const code = await main(["run"], env, new MemoryLogger(), { client: seededClient(), store: new MemoryStateStore(), planner });
    expect(code).toBe(EXIT.planner);
  });

  it("maps a Jellyfin refusal to exit 2", async () => {
    const client = seededClient();
    client.getSystemInfo = async () => {
      throw new JellyfinHttpError(401, "/System/Info", "no");
    };
    const log = new MemoryLogger();
    const code = await main(["run"], env, log, { client, store: new MemoryStateStore(), planner: new FakeShelfPlanner(() => []) });
    expect(code).toBe(EXIT.jellyfin);
    expect(log.lines.some((l) => l.includes("401"))).toBe(true);
  });

  it("maps a too-small library to exit 4", async () => {
    const code = await main(["run"], env, new MemoryLogger(), { client: seededClient(10), store: new MemoryStateStore(), planner: new FakeShelfPlanner(() => []) });
    expect(code).toBe(EXIT.librarySmall);
  });

  it("status lists owned shelves; retire-all needs --yes", async () => {
    const client = seededClient();
    const store = new MemoryStateStore();
    await main(["run"], env, new MemoryLogger(), { client, store, planner: new FakeShelfPlanner((request) => chunkShelves(request, 8)) });

    const statusLog = new MemoryLogger();
    expect(await main(["status"], env, statusLog, { client, store })).toBe(EXIT.ok);
    expect(statusLog.lines.filter((l) => l.includes("boxset-"))).toHaveLength(6);

    expect(await main(["retire-all"], env, new MemoryLogger(), { client, store })).toBe(EXIT.failure);
    expect(client.deleted).toEqual([]);

    expect(await main(["retire-all", "--yes"], env, new MemoryLogger(), { client, store })).toBe(EXIT.ok);
    expect(client.deleted).toHaveLength(6);
    expect(store.state.shelves).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/cli.test.ts`
Expected: FAIL, cannot find module `../src/cli.js`.

- [ ] **Step 3: Write `src/cli.ts`**

```ts
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type Config } from "./config.js";
import { writeHomeRowSlots } from "./homerows/slots.js";
import { HttpJellyfinClient, JellyfinHttpError, type JellyfinClient } from "./jellyfin/client.js";
import { consoleLogger, type Logger } from "./log.js";
import { ClaudeShelfPlanner, PlannerError, type ShelfPlanner } from "./planner/planner.js";
import { runCuration, type RunSummary } from "./run.js";
import { JsonFileStateStore, type StateStore } from "./state/store.js";
import { applyPlan } from "./sync/apply.js";

export type CliCommand =
  | { command: "run"; dryRun: boolean; fullRefresh: boolean }
  | { command: "status" }
  | { command: "retire-all"; yes: boolean }
  | { command: "help" };

export const EXIT = { ok: 0, failure: 1, jellyfin: 2, planner: 3, librarySmall: 4 } as const;

export const USAGE = `Usage: curator <command> [options]

Commands:
  run              plan, rotate and write collections (the nightly job)
    --dry-run        read everything, write nothing, print the plan
    --full-refresh   retire every live shelf and plan a full new set
  status           list the shelves this service owns
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
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help === true || command === undefined || command === "help") return { command: "help" };
  switch (command) {
    case "run":
      return { command: "run", dryRun: values["dry-run"] === true, fullRefresh: values["full-refresh"] === true };
    case "status":
      return { command: "status" };
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
    planner: () => overrides.planner ?? new ClaudeShelfPlanner(new Anthropic(), config.CURATOR_MODEL),
  };

  try {
    return await dispatch(cmd, runtime);
  } catch (err) {
    if (err instanceof PlannerError) {
      log.error(`planner: ${err.message}`);
      return EXIT.planner;
    }
    if (err instanceof JellyfinHttpError || (err instanceof TypeError && /fetch/i.test(err.message))) {
      log.error(`jellyfin: ${err.message} (url ${config.JELLYFIN_URL})`);
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
    case "retire-all":
      return retireAll(cmd.yes, rt);
    case "run": {
      const summary = await runCuration(
        { config: rt.config, client: rt.client, planner: rt.planner(), store: rt.store, log: rt.log, now: rt.now },
        { dryRun: cmd.dryRun, fullRefresh: cmd.fullRefresh },
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

async function retireAll(yes: boolean, rt: Runtime): Promise<number> {
  const state = await rt.store.load();
  if (!yes) {
    rt.log.error(`would delete ${state.shelves.length} collections; re-run with --yes to confirm`);
    return EXIT.failure;
  }
  const applied = await applyPlan(rt.client, rt.store, state, { retire: state.shelves, create: [], dryRun: false, now: rt.now }, rt.log);
  if (rt.config.CURATOR_HOME_ROWS) {
    await writeHomeRowSlots(rt.client, [], { slotCount: rt.config.CURATOR_SHELF_COUNT, dryRun: false }, rt.log);
  }
  rt.log.info(`retired ${applied.report.retired.length}, skipped ${applied.report.skipped.length}`);
  return applied.report.skipped.length === 0 ? EXIT.ok : EXIT.failure;
}

function report(summary: RunSummary, log: Logger): number {
  if (summary.outcome === "library-too-small") {
    log.error(
      `library has ${summary.catalogSize} movies/series but ${summary.required} are needed for the configured shelves; lower CURATOR_SHELF_COUNT or CURATOR_MIN_ITEMS`,
    );
    return EXIT.librarySmall;
  }
  for (const skipped of summary.skipped) log.warn(`skipped "${skipped.title}": ${skipped.reason}`);
  log.info(`summary: kept ${summary.kept.length}, retired ${summary.retired.length}, created ${summary.created.length}, skipped ${summary.skipped.length}`);
  return EXIT.ok;
}
```

If `tsc` reports that `dispatch` lacks an ending return statement, add `default: { const unreachable: never = cmd; throw new Error(String(unreachable)); }` to its switch.

- [ ] **Step 4: Write `src/bin.ts`**

```ts
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
```

- [ ] **Step 5: Run the CLI test, the full gate, and the real entry point**

Run: `pnpm vitest run test/cli.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm curator help`
Expected: 8 CLI tests pass; gate green; `pnpm curator help` prints the usage text and exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/bin.ts test/cli.test.ts
git commit -m "feat: curator CLI with run, status and retire-all"
```

---

### Task 14: Build, Docker, operator docs

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yml`, `.env.example`, `README.md`
- Modify: `AGENTS.md` (expand), `package.json` (no change expected; verify `build` works)

**Interfaces:**
- Consumes: `dist/bin.js` produced by `pnpm build`.

- [ ] **Step 1: Prove the production build runs**

Run: `pnpm build && node dist/bin.js help; echo "exit=$?"`
Expected: usage text, `exit=0`. If `tsc` emits into `dist/` with `.js` files importing `./x.js` paths, the run works; if it fails with a module-not-found error, the missing `.js` extension in a relative import is the cause (fix the import, do not change tsconfig).

- [ ] **Step 2: Write `Dockerfile` and `.dockerignore`**

`Dockerfile`:

```dockerfile
FROM node:26-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["run"]
```

`.dockerignore`:

```
node_modules
dist
curator-data
.env
docs
test
.git
```

- [ ] **Step 3: Write `compose.yml` and `.env.example`**

`compose.yml` (for the NAS; `jellyfin_default` is the usual name of the network the Jellyfin compose stack creates, check with `docker network ls` and adjust):

```yaml
services:
  curator:
    build: .
    image: jellyfin-curator:local
    env_file: .env
    volumes:
      - ./curator-data:/data
    networks:
      - jellyfin_default
    profiles: ["manual"]

networks:
  jellyfin_default:
    external: true
```

`.env.example`:

```
# Jellyfin (inside the Jellyfin Docker network use http://jellyfin:8096; from another machine use your server's address)
JELLYFIN_URL=http://jellyfin:8096
JELLYFIN_API_KEY=

# Anthropic (or run `ant auth login` locally and leave this unset)
ANTHROPIC_API_KEY=

# Curation
CURATOR_MODEL=claude-opus-5
CURATOR_SHELF_COUNT=6
CURATOR_ROTATE_PER_RUN=2
CURATOR_MIN_ITEMS=8
CURATOR_MAX_ITEMS=20
CURATOR_INCLUDE_OVERVIEWS=true
CURATOR_HOME_ROWS=false
CURATOR_STATE_PATH=/data/state.json
# CURATOR_LIBRARY_IDS=<comma-separated library ids to restrict to>
```

- [ ] **Step 4: Write `README.md`**

```markdown
# jellyfin-curator

Every night, read the household's Jellyfin library, ask Claude to invent a handful of themed shelves from it ("Heists that go sideways", "Small towns with secrets"), and publish them as Jellyfin collections. Optionally the same shelves appear as rows on the web home screen through the Home Screen Sections plugin family.

Design: [docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md](docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md).

## How it works

1. Fetch every movie and series with genres, overview, people, studios, tags, plus per-user played and favourite flags aggregated into household counts.
2. Render a compact one-line-per-item catalog and ask `claude-opus-5` (structured output) for N shelves: title, blurb, member ids.
3. Validate: unknown ids dropped, duplicates removed, size bounds enforced.
4. Retire the oldest shelves (default two per night), create the new ones as collections tagged `jellyfin-curator`, save state after every write.
5. If `CURATOR_HOME_ROWS=true`, rewrite the Collection Sections slots `curator-shelf-1..N` and bust the Home Screen Sections cache.

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

## Commands

```bash
pnpm curator run [--dry-run] [--full-refresh]
pnpm curator status
pnpm curator retire-all --yes
```

Exit codes: 0 ok, 1 failure, 2 Jellyfin unreachable or refused, 3 planner failed, 4 library too small.

## Deploy on the NAS

```bash
docker compose build
docker compose run --rm curator run --dry-run
docker compose run --rm curator run
```

Nightly at 04:00, on the NAS host crontab:

```
0 4 * * * cd /path/to/jellyfin-curator && docker compose run --rm curator run >> curator-data/cron.log 2>&1
```

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `JELLYFIN_URL` | required | base URL, no trailing slash |
| `JELLYFIN_API_KEY` | required | admin API key |
| `ANTHROPIC_API_KEY` | required in Docker | resolved by the SDK; locally an `ant auth login` profile also works |
| `CURATOR_MODEL` | `claude-opus-5` | |
| `CURATOR_SHELF_COUNT` | `6` | live shelves |
| `CURATOR_ROTATE_PER_RUN` | `2` | retired per run |
| `CURATOR_MIN_ITEMS` / `CURATOR_MAX_ITEMS` | `8` / `20` | per shelf |
| `CURATOR_INCLUDE_OVERVIEWS` | `true` | most of the token cost, most of the creative signal |
| `CURATOR_HOME_ROWS` | `false` | write Collection Sections slots |
| `CURATOR_STATE_PATH` | `/data/state.json` | |
| `CURATOR_LIBRARY_IDS` | all | comma-separated library ids |

## Cost

Prompt caching has a one-hour ceiling and runs are a day apart, so the catalog is paid for every run. Roughly $0.50 per run for 1 000 items with overviews, $1.40 for 3 000, at Opus 5 list price. The run logs actual tokens and an estimate. Levers: `CURATOR_INCLUDE_OVERVIEWS=false`, run weekly, or lower the effort in `src/planner/planner.ts`.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

No test touches the network. Fakes for Jellyfin, the planner and the state store live in `test/fakes/`.
```

- [ ] **Step 5: Expand `AGENTS.md`**

Replace the file with:

```markdown
# jellyfin-curator — agent guide

Nightly service: read the Jellyfin library, ask Claude for themed shelves, write them as tagged collections, optionally expose them as web home rows. Design: `docs/superpowers/specs/2026-09-04-jellyfin-curator-design.md`. Plan that built it: `docs/superpowers/plans/2026-09-04-jellyfin-curator.md`.

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
- `src/sync/apply.ts` is the only writer to Jellyfin.

## Invariants (and why)

- Only a `Type === "BoxSet"` item carrying the `jellyfin-curator` tag is ever deleted, and only when it is in state or was adopted as an orphan this run. The tag plus the state file is how we tell our collections from the ones a person made by hand; a bug here deletes someone's curation.
- Never POST a partial DTO to `/Items/{id}`. Jellyfin replaces fields wholesale, so a partial body silently blanks metadata. GET, modify, POST the whole object (`applyPlan` does this).
- Home-row slot ids `curator-shelf-<n>` are stable. Home Screen Sections shows a section only if the user enabled that id; rotation changes what a slot shows, never the id.
- The system prompt is frozen text (no dates, ids, counts). It is the cached block; within a run the second planner call reuses it.
- State is saved after every successful write, atomically. A crash mid-run must leave state truthful.
- No network in tests; inject the clock (`now: () => Date`); fixed ids.
- Never log or persist API keys. `loadConfig` drops unknown env keys on purpose.
- Versions are pinned exactly (`.npmrc` `save-exact=true`), as in the rest of this codebase.
- Relative imports carry `.js` (NodeNext). Jellyfin JSON is PascalCase; ours is camelCase; both are correct.

## Cost awareness

Every `run` that reaches the planner spends real money (roughly $0.50–$1.50 at current library sizes). Use `--dry-run` while developing prompt or catalog changes; it still calls the planner, so prefer `FakeShelfPlanner` in tests and reserve real runs for verifying the end result.
```

- [ ] **Step 6: Build the image if Docker is available**

Run: `docker info >/dev/null 2>&1 && docker build -t jellyfin-curator:local . && docker run --rm jellyfin-curator:local help || echo "docker not available here; image build is verified on the NAS in Task 15"`
Expected: either the usage text from inside the container, or the fallback message.

- [ ] **Step 7: Run the full gate and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add Dockerfile .dockerignore compose.yml .env.example README.md AGENTS.md
git commit -m "docs: deployment, operator guide and agent guide"
```

---

### Task 15: Manual integration against the NAS (no code)

This task is a checklist for the operator with the agent assisting. Nothing here is automated; each step is verified by looking.

- [ ] **Step 1: Credentials.** The operator creates the Jellyfin API key (Dashboard → API Keys) and puts it in `.env` together with `ANTHROPIC_API_KEY` (or confirms `ant auth status` shows an active profile). The agent never types or echoes either key.

- [ ] **Step 2: Dry run against the server.**

```bash
set -a && . ./.env && set +a && JELLYFIN_URL=http://nas.local:8096 CURATOR_STATE_PATH=./curator-data/state.json pnpm curator run --dry-run
```

Expected: `connected to the NAS 10.11.10 (dry run)`, a catalog count, six `planned "..."` lines with sensible members, `[dry-run] would create` × 6, a token and cost line, exit 0. Read the shelves. If they are generic ("Action Movies"), tune `SYSTEM_PROMPT` in `src/planner/prompt.ts` (Task 6 tests still pass) before the real run.

- [ ] **Step 3: Real run.** Same command without `--dry-run`. Expected: six collections appear in Jellyfin's Collections view with the blurb as overview and a collage poster; `pnpm curator status` lists them; `./curator-data/state.json` exists.

- [ ] **Step 4: Second run.** Run again (or with `--full-refresh` to see the whole set change). Expected: two retired, two created, the retired titles listed under `retired` in state.

- [ ] **Step 5: Home rows.** Install the four plugins (README §One-time setup step 2), enable Home Screen Sections, set `CURATOR_HOME_ROWS=true`, dry run, then real run. Expected: `wrote 6 home-row slots`. Each user enables `curator-shelf-1..6` in Modular Home. Reload the web home screen: six rows with the shelf titles.

- [ ] **Step 6: Deploy on the NAS.** Copy the repository to the NAS, `docker network ls` to confirm the Jellyfin network name in `compose.yml`, `docker compose build`, `.env` with `JELLYFIN_URL=http://jellyfin:8096`, `docker compose run --rm curator run --dry-run`, then the cron line from the README. Next morning: `docker compose run --rm curator status` shows the rotation happened and `curator-data/cron.log` has the summary line.

- [ ] **Step 7: Record the real cost.** Replace the estimate table in the spec §9 and the README with the logged token counts from the real library size. Commit as `docs: real per-run cost`.
