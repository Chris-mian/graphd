const TOKENS_PER_MILLION = 1_000_000;

/** Published Anthropic API rates in USD per million tokens. */
export const DEFAULT_MODEL_RATES = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const FALLBACK_RATE = { input: 5, output: 25 };

/**
 * Share of a subagent's tokens assumed to be input.
 * Agent results report one combined total, so a split has to be assumed; agent traffic is
 * input-dominated because the full context is resent on every turn.
 */
export const DEFAULT_INPUT_SHARE = 0.9;

function ratesFor(modelId) {
  if (!modelId) return FALLBACK_RATE;
  const exactMatch = DEFAULT_MODEL_RATES[modelId];
  if (exactMatch) return exactMatch;
  const prefixMatch = Object.keys(DEFAULT_MODEL_RATES).find((known) => modelId.startsWith(known));
  return prefixMatch ? DEFAULT_MODEL_RATES[prefixMatch] : FALLBACK_RATE;
}

/**
 * Estimates USD for a node's combined token count.
 * Returns a point estimate plus the bounds implied by an all-input or all-output split, since
 * the harness reports only a combined total.
 */
export function estimateCost({ totalTokens, model, inputShare = DEFAULT_INPUT_SHARE }) {
  const tokens = totalTokens ?? 0;
  const rates = ratesFor(model);
  const millions = tokens / TOKENS_PER_MILLION;
  return {
    low: millions * rates.input,
    high: millions * rates.output,
    estimate: millions * (rates.input * inputShare + rates.output * (1 - inputShare)),
  };
}

export function formatUsd(amount) {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}
