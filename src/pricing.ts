/**
 * Cost estimation from token usage and model pricing.
 * Prices represent equivalent API cost — not what subscription plans actually charge.
 */

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

// Static pricing table - last verified 2026-03-08
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4": { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5, cacheWritePerMillion: 18.75 },
  "claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  "claude-haiku-4": { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
  "claude-3-5-sonnet": { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  "claude-3-5-haiku": { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
};

// Keys sorted longest-first so "claude-sonnet-4" matches before a hypothetical shorter prefix
const SORTED_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

/**
 * Look up pricing for a model name using startsWith matching, longest key first.
 */
export function lookupPricing(modelName: string): ModelPricing | null {
  for (const key of SORTED_KEYS) {
    if (modelName.startsWith(key)) {
      return PRICING[key]!;
    }
  }
  return null;
}

/**
 * Estimate the equivalent API cost in dollars for a given token usage.
 * Returns { cost, known } where known=false means the model wasn't in the pricing table.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): { cost: number; known: boolean } {
  const pricing = lookupPricing(model);
  if (!pricing) {
    return { cost: 0, known: false };
  }
  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMillion;
  return { cost, known: true };
}

/**
 * Format a dollar amount as $X.XX or $X,XXX.XX.
 */
export function formatCost(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
