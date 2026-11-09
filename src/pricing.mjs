const TOKENS_PER_MILLION = 1_000_000;

/** Cache writes cost a multiple of the input rate, by how long the entry lives. */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
/** Cache reads cost ~0.1x input unless a model's published rate says otherwise. */
const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;

/**
 * Published Anthropic API list rates in USD per million tokens, standard context (source: the
 * Claude API pricing table, platform.claude.com/docs/en/about-claude/pricing).
 * `cacheRead` is given only where it is not 0.1x input. Longest key wins a prefix match, so
 * `claude-opus-5-5` is not priced as `claude-opus-5`. Long-context and Haiku 5.5's past-100K
 * surcharges are not modelled.
 */
export const DEFAULT_MODEL_RATES = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const FALLBACK_RATE = { input: 5, output: 25 };

/** Spawn-time model aliases, for a node whose resolved model was never recorded. */
const MODEL_ALIASES = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/**
 * Share of a subagent's tokens assumed to be input.
 * Applies only to a node priced from the harness's combined total, which has no split.
 */
export const DEFAULT_INPUT_SHARE = 0.9;

const KNOWN_MODELS_LONGEST_FIRST = Object.keys(DEFAULT_MODEL_RATES).sort(
  (left, right) => right.length - left.length,
);

export function ratesFor(modelId) {
  if (!modelId) return FALLBACK_RATE;
  const resolved = MODEL_ALIASES[modelId] ?? modelId;
  const exactMatch = DEFAULT_MODEL_RATES[resolved];
  if (exactMatch) return exactMatch;
  const prefixMatch = KNOWN_MODELS_LONGEST_FIRST.find((known) => resolved.startsWith(known));
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

/** The empty per-model usage record that transcript usage is summed into. */
export function emptyUsage() {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, turns: 0 };
}

/** Every token a usage record billed, cache traffic included. */
export function usageTokens(usage) {
  return usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead + usage.output;
}

/** Exact USD for usage keyed by model, as summed from transcript turns. */
export function usageCost(usageByModel) {
  let total = 0;
  for (const [model, usage] of Object.entries(usageByModel ?? {})) {
    const rates = ratesFor(model);
    const cacheReadRate = rates.cacheRead ?? rates.input * DEFAULT_CACHE_READ_MULTIPLIER;
    total +=
      (usage.input * rates.input +
        usage.cacheWrite5m * rates.input * CACHE_WRITE_5M_MULTIPLIER +
        usage.cacheWrite1h * rates.input * CACHE_WRITE_1H_MULTIPLIER +
        usage.cacheRead * cacheReadRate +
        usage.output * rates.output) /
      TOKENS_PER_MILLION;
  }
  return total;
}

/** A node's billed usage by model, or null when no transcript priced it. */
export function billedUsage(node) {
  if (!node?.billed_usage) return null;
  try {
    const parsed = typeof node.billed_usage === "string" ? JSON.parse(node.billed_usage) : node.billed_usage;
    return parsed && Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Share of a Workflow's agents whose transcripts were billed; 1 for a node priced in full. */
function billedShare(node) {
  const share = node?.billed_share;
  return typeof share === "number" && share > 0 && share < 1 ? share : 1;
}

/**
 * How a node is priced: `billed` from its own transcript's turns, `partial` when only some of a
 * Workflow's agents left transcripts, `context` from the harness's total (the agent's final
 * context size, not what it billed), or `none`.
 */
export function pricingBasis(node) {
  if (billedUsage(node)) return billedShare(node) < 1 ? "partial" : "billed";
  if (node?.total_tokens) return "context";
  return "none";
}

/**
 * A node's cost. Exact when its transcript was read, so the bounds collapse onto the figure. A
 * partial Workflow keeps the billed sum as its floor and scales it up by the share billed.
 * Otherwise the old estimate on the harness total, which is a context size and understates spend.
 */
export function nodeCost(node) {
  const usage = billedUsage(node);
  if (usage) {
    const billed = usageCost(usage);
    const scaled = billed / billedShare(node);
    return { low: billed, high: scaled, estimate: scaled };
  }
  return estimateCost({ totalTokens: node?.total_tokens, model: node?.resolved_model ?? node?.model });
}

/** Tokens a node billed when its transcript was read, else the harness total. */
export function nodeTokens(node) {
  const usage = billedUsage(node);
  if (usage) return Object.values(usage).reduce((sum, entry) => sum + usageTokens(entry), 0);
  return node?.total_tokens ?? 0;
}

export function formatUsd(amount) {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}
