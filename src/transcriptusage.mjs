import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { emptyUsage } from "./pricing.mjs";

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

/** One response's billed counts; a response of several iterations reports only the last at top level. */
function usageCounts(usage) {
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (iterations.length <= 1) return singleUsageCounts(usage);
  const summed = singleUsageCounts({});
  for (const iteration of iterations) {
    for (const [field, count] of Object.entries(singleUsageCounts(iteration))) summed[field] += count;
  }
  return summed;
}

/**
 * Billed counts per response in a transcript, keyed by message id. One response is written as
 * several entries sharing an id, with the same input counts and a growing output count, so each
 * id keeps its largest output.
 */
export function messageUsage(entries) {
  const countsByMessage = new Map();
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const { message } = entry;
    if (!message?.usage || !message.model || message.model === SYNTHETIC_MODEL) continue;
    const messageKey = message.id ?? entry.uuid;
    const counts = usageCounts(message.usage);
    const seen = countsByMessage.get(messageKey);
    if (seen) seen.counts.output = Math.max(seen.counts.output, counts.output);
    else countsByMessage.set(messageKey, { model: message.model, counts });
  }
  return countsByMessage;
}

/** Per-response counts summed by model, skipping ids in `excludedMessageIds`. */
export function aggregateUsage(countsByMessage, excludedMessageIds = new Set()) {
  const byModel = {};
  for (const [messageKey, { model, counts }] of countsByMessage) {
    if (excludedMessageIds.has(messageKey)) continue;
    const total = (byModel[model] ??= emptyUsage());
    for (const [field, count] of Object.entries(counts)) total[field] += count;
    total.turns += 1;
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
