// What a model call costs, from the tokens it used. The ledger (`app.llm_spend`) feeds the budgets, so a line priced at zero would make every
// budget blind: the platform prices each call here and the gate (`preflight`) reads the sum. Prices are US dollars per million tokens and are
// deliberately on the high side (prompt-cache reads are billed as normal prompt tokens), so a budget is reached a little early, never late.
// A model that is not listed costs the DEFAULT price, never zero: an unknown model must not escape a budget. A model that runs inside the
// deployment (a provider the admin marked local) costs nothing and is priced by the caller, not here.

export interface ModelPrice {
  /** USD per million prompt tokens. */
  inUsd: number;
  /** USD per million completion tokens. */
  outUsd: number;
}

/** The price of a model nobody listed. */
export const DEFAULT_PRICE: ModelPrice = { inUsd: 5, outUsd: 25 };

/** First match wins; matched against the model string without its provider prefix (`anthropic/claude-sonnet-5-5` -> `claude-sonnet-5-5`). */
const PRICES: ReadonlyArray<{ match: RegExp; price: ModelPrice }> = [
  { match: /^claude-(?:.*-)?haiku/i, price: { inUsd: 1, outUsd: 5 } },
  { match: /^claude-(?:.*-)?sonnet/i, price: { inUsd: 3, outUsd: 15 } },
  { match: /^claude-(?:.*-)?opus/i, price: { inUsd: 5, outUsd: 25 } },
  { match: /^claude-(?:.*-)?fable/i, price: { inUsd: 5, outUsd: 25 } },
];

export function priceOfModel(model: string | null): ModelPrice {
  const bare = (model ?? '').includes('/') ? (model as string).slice((model as string).lastIndexOf('/') + 1) : (model ?? '');
  return PRICES.find((p) => p.match.test(bare))?.price ?? DEFAULT_PRICE;
}

/** The cost in USD of one call, from the tokens it reported. */
export function costOfCall(model: string | null, promptTokens: number, completionTokens: number): number {
  const p = priceOfModel(model);
  return (promptTokens * p.inUsd + completionTokens * p.outUsd) / 1_000_000;
}
