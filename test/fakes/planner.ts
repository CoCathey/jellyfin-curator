import type { PlanRequest, PlanResult, ShelfPlanner } from "../../src/planner/planner.js";
import type { Shelf } from "../../src/planner/schema.js";

/** Scripted planner: records every request and answers with whatever the test decides. */
export class FakeShelfPlanner implements ShelfPlanner {
  readonly requests: PlanRequest[] = [];

  constructor(private readonly respond: (request: PlanRequest) => Shelf[]) {}

  async plan(request: PlanRequest): Promise<PlanResult> {
    this.requests.push(request);
    return {
      shelves: this.respond(request),
      usage: { inputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 100 },
    };
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
