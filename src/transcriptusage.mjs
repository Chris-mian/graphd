import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { emptyUsage, pricedModelKey } from "./pricing.mjs";

/** The harness writes placeholder assistant turns under this model; they bill nothing. */
const SYNTHETIC_MODEL = "<synthetic>";
const SUBAGENT_TRANSCRIPT_PATTERN = /^agent-([\w-]+)\.jsonl$/;

function singleUsageCounts(usage) {
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: usage.input_tokens ?? 0,
    cacheWrite5m: Math.max(cacheCreation - oneHour, 0),
    cacheWrite1h: oneHour,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
}

function promptTokens(counts) {
  return counts.input + counts.cacheWrite5m + counts.cacheWrite1h + counts.cacheRead;
}

/**
 * One response's billed counts as `[pricedModel, counts]` pairs. A response of several iterations
 * reports only the last at top level, so its iterations are read one by one, each under its own
 * model when a fallback changed it.
 */
function responseUsage(message) {
  const iterations = Array.isArray(message.usage.iterations) ? message.usage.iterations : [];
  const parts = iterations.length > 1 ? iterations : [message.usage];
  return parts.map((part) => {
    const model = part.model ?? message.model;
    const counts = singleUsageCounts(part);
    return [pricedModelKey(model, promptTokens(counts)), counts];
  });
}

function totalOutput(pairs) {
  return pairs.reduce((sum, [, counts]) => sum + counts.output, 0);
}

/**
 * Billed counts per response in a transcript, keyed by message id. One response is written as
 * several entries sharing an id, with the same input counts and a growing output count, so each
 * id keeps the entry with the largest output.
 */
export function messageUsage(entries) {
  const usageByMessage = new Map();
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const { message } = entry;
    if (!message?.usage || !message.model || message.model === SYNTHETIC_MODEL) continue;
    const messageKey = message.id ?? entry.uuid;
    const pairs = responseUsage(message);
    const seen = usageByMessage.get(messageKey);
    if (!seen || totalOutput(pairs) > totalOutput(seen)) usageByMessage.set(messageKey, pairs);
  }
  return usageByMessage;
}

/** Per-response counts summed by model, skipping ids in `excludedMessageIds`. */
export function aggregateUsage(usageByMessage, excludedMessageIds = new Set()) {
  const byModel = {};
  for (const [messageKey, pairs] of usageByMessage) {
    if (excludedMessageIds.has(messageKey)) continue;
    pairs.forEach(([model, counts], index) => {
      const total = (byModel[model] ??= emptyUsage());
      for (const [field, count] of Object.entries(counts)) total[field] += count;
      if (index === 0) total.turns += 1;
    });
  }
  return byModel;
}

/** Billed usage per model over a transcript's assistant turns. */
export function usageByModel(entries, excludedMessageIds = new Set()) {
  return aggregateUsage(messageUsage(entries), excludedMessageIds);
}

/** Message ids of a transcript's own assistant turns; sidechain entries belong to a subagent. */
export function assistantMessageIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (entry.type === "assistant" && !entry.isSidechain && entry.message?.id) ids.add(entry.message.id);
  }
  return ids;
}

/** Usage records added together, model by model. */
export function mergeUsage(usageRecords) {
  const merged = {};
  for (const record of usageRecords) {
    for (const [model, usage] of Object.entries(record ?? {})) {
      const total = (merged[model] ??= emptyUsage());
      for (const field of Object.keys(total)) total[field] += usage[field] ?? 0;
    }
  }
  return merged;
}

/**
 * The meta file beside a top-level subagent transcript, with the session that spawned it.
 * Null for a main-thread transcript, a Workflow agent (priced through its Workflow), or a
 * transcript without readable meta.
 */
export function subagentMeta(transcriptPath) {
  const agentId = SUBAGENT_TRANSCRIPT_PATTERN.exec(basename(transcriptPath))?.[1];
  const subagentDir = dirname(transcriptPath);
  if (!agentId || basename(subagentDir) !== "subagents") return null;
  const metaPath = join(subagentDir, `agent-${agentId}.meta.json`);
  if (!statSync(metaPath, { throwIfNoEntry: false })) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      agentId,
      sessionId: basename(dirname(subagentDir)),
      toolUseId: meta.toolUseId ?? null,
      name: meta.name ?? null,
      isFork: Boolean(meta.isFork),
    };
  } catch {
    return null;
  }
}
