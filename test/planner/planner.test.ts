import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeShelfPlanner, PlannerError, maxTokensFor, type PlanRequest } from "../../src/planner/planner.js";
import { SYSTEM_PROMPT } from "../../src/planner/prompt.js";

const request: PlanRequest = {
  catalogText: "m1|M|Heat (1995)|Crime|8.3|170|WB||w0f0|x",
  wanted: 2,
  minItems: 8,
  maxItems: 20,
  avoidThemes: [],
  seasonContext: "Today is Saturday 5 September 2026, autumn in the northern hemisphere: first cool evenings. Nothing on the calendar in the next eight weeks.",
  seasonalMin: 1,
};
const shelves = [{ title: "Heists that go sideways", blurb: "b", itemIds: ["m1"], rationale: "r" }];

function clientWith(response: unknown): { client: Anthropic; parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn().mockReturnValue({ finalMessage: () => Promise.resolve(response) });
  return { client: { messages: { stream: parse } } as unknown as Anthropic, parse };
}

function clientRejecting(error: unknown): Anthropic {
  return { messages: { stream: () => ({ finalMessage: () => Promise.reject(error) }) } } as unknown as Anthropic;
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
    expect(result.usage).toEqual({ inputTokens: 150, cacheCreationInputTokens: 50, cacheReadInputTokens: 0, outputTokens: 20 });

    const params = parse.mock.calls[0]![0];
    expect(params.model).toBe("claude-opus-5");
    expect(params.max_tokens).toBe(32_000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config.effort).toBe("high");
    expect(params.output_config.format).toBeDefined();
    // The frozen prompt is far below the 512-token minimum cacheable prefix, so
    // the breakpoint has to sit after the catalog for anything to cache at all.
    expect(params.system[0].text).toBe(SYSTEM_PROMPT);
    expect(params.system[0].cache_control).toBeUndefined();
    // Off by default: a cache write costs 1.25x and only pays off on a shortfall retry.
    expect(params.system[1].cache_control).toBeUndefined();
    expect(params.system[1].text).toContain("Catalog (1 items)");
  });

  it("marks the catalog block for caching only when asked", async () => {
    const { client, parse } = clientWith({
      stop_reason: "end_turn",
      parsed_output: { shelves },
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await new ClaudeShelfPlanner(client, "claude-opus-5", { cacheCatalog: true }).plan(request);
    const params = parse.mock.calls[0]![0];
    expect(params.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[1].text).toContain(request.catalogText);
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toContain("Invent 2 shelves");
    expect(params.messages[0].content).toContain("Today's context: Today is Saturday 5 September 2026");
    expect(params.messages[0].content).not.toContain(request.catalogText);
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
  it("turns an Anthropic API error into a PlannerError so the CLI exits 3, not 1", async () => {
    const apiError = Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "rate limited" } }, undefined, new Headers());
    const planner = new ClaudeShelfPlanner(clientRejecting(apiError), "claude-opus-5");
    await expect(planner.plan(request)).rejects.toThrow(PlannerError);
    await expect(planner.plan(request)).rejects.toThrow(/Anthropic API: .*rate limited/);
    await expect(planner.plan(request)).rejects.toMatchObject({ cause: apiError });
  });

  it("turns an SDK-level AnthropicError, such as a missing key, into a PlannerError", async () => {
    const sdkError = new Anthropic.AnthropicError("The ANTHROPIC_API_KEY environment variable is missing");
    const planner = new ClaudeShelfPlanner(clientRejecting(sdkError), "claude-opus-5");
    await expect(planner.plan(request)).rejects.toThrow(PlannerError);
    await expect(planner.plan(request)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("lets an unrelated failure through untouched", async () => {
    const bug = new TypeError("not the planner's fault");
    await expect(new ClaudeShelfPlanner(clientRejecting(bug), "claude-opus-5").plan(request)).rejects.toBe(bug);
  });
});

describe("maxTokensFor", () => {
  it.each([
    { wanted: 1, expected: 32_000 },
    { wanted: 2, expected: 32_000 },
    { wanted: 21, expected: 35_500 },
    { wanted: 100, expected: 48_000 },
  ])("leaves room for $wanted shelves", ({ wanted, expected }) => {
    expect(maxTokensFor(wanted)).toBe(expected);
  });

  it("is what a catch-up run asks the model for", async () => {
    const { client, parse } = clientWith({
      stop_reason: "end_turn",
      parsed_output: { shelves },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    await new ClaudeShelfPlanner(client, "claude-sonnet-5").plan({ ...request, wanted: 21 });
    expect(parse.mock.calls[0]![0].max_tokens).toBe(35_500);
  });
});
