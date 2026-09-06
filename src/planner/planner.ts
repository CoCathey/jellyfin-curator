import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SYSTEM_PROMPT, buildCatalogBlock, buildUserMessage, type PlanRequest } from "./prompt.js";
import { PlanSchema, type Shelf } from "./schema.js";

export type { PlanRequest } from "./prompt.js";

export interface PlanUsage {
  /** Every input token the call was billed for, cached ones included. */
  inputTokens: number;
  /** The slice of inputTokens written into the cache, billed at 1.25x. */
  cacheCreationInputTokens: number;
  /** The slice of inputTokens served from the cache, billed at 0.1x. */
  cacheReadInputTokens: number;
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlannerError";
  }
}

/** A shelf costs roughly 300 output tokens (title, blurb, rationale, up to 20
 * ids); adaptive thinking wants far more, and wants more still as the avoid list
 * grows — six shelves against nineteen live themes overran a 16k cap. max_tokens
 * is a ceiling, not a reservation: an unused one costs nothing, while hitting it
 * throws away a call that was billed in full. So the floor is generous and the
 * ceiling stays well under the model's own output limit. */
export function maxTokensFor(wanted: number): number {
  return Math.min(48_000, Math.max(32_000, 4_000 + wanted * 1_500));
}

export class ClaudeShelfPlanner implements ShelfPlanner {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly options: { cacheCatalog?: boolean } = {},
  ) {}

  async plan(request: PlanRequest): Promise<PlanResult> {
    // Streamed, not because anything reads the tokens as they arrive, but because
    // the SDK refuses a non-streaming request whose max_tokens implies it could
    // run past ten minutes (over ~21k). The final message is identical.
    const response = await this.client.messages
      .stream({
        model: this.model,
        max_tokens: maxTokensFor(request.wanted),
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: zodOutputFormat(PlanSchema) },
        // Two blocks; the optional breakpoint goes on the second. The frozen prompt
        // is far below the 512-token minimum cacheable prefix, so caching it alone
        // was a no-op. Caching the catalog only pays when a shortfall retry follows
        // within the window: a write bills at 1.25x, so it is off unless asked for.
        system: [
          { type: "text", text: SYSTEM_PROMPT },
          (request.cacheCatalog ?? this.options.cacheCatalog)
            ? { type: "text", text: buildCatalogBlock(request.catalogText), cache_control: { type: "ephemeral" } }
            : { type: "text", text: buildCatalogBlock(request.catalogText) },
        ],
        messages: [{ role: "user", content: buildUserMessage(request) }],
      })
      .finalMessage()
      .catch(rethrowAsPlannerError);

    if (response.stop_reason === "refusal") {
      const explanation = response.stop_details?.explanation;
      throw new PlannerError(`model refused the request${explanation ? `: ${explanation}` : ""}`);
    }
    if (response.stop_reason === "max_tokens") throw new PlannerError("model output was cut off at max_tokens");
    if (!response.parsed_output) throw new PlannerError("model answer did not match the plan schema");

    const usage = response.usage;
    const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
    const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
    return {
      shelves: response.parsed_output.shelves,
      usage: {
        inputTokens: usage.input_tokens + cacheCreationInputTokens + cacheReadInputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        outputTokens: usage.output_tokens,
      },
    };
  }
}

/** Every SDK failure is a planner failure, not a bug in this service: the spec
 * (§8) wants exit 3 for a 429 or 5xx after the SDK's retries, a 401 from a bad
 * key and a 400 from an over-long prompt alike. `APIError` covers the responses;
 * its parent `AnthropicError` also covers client-side failures such as a missing
 * key or an aborted request. Anything else is a real bug and is left to bubble. */
function rethrowAsPlannerError(err: unknown): never {
  if (err instanceof Anthropic.APIError || err instanceof Anthropic.AnthropicError) {
    throw new PlannerError(`Anthropic API: ${err.message}`, { cause: err });
  }
  throw err;
}
