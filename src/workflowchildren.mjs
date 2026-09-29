import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A pause longer than this between two transcript entries is idle time, not work. */
export const MAX_ACTIVE_GAP_MS = 5 * 60_000;

const AGENT_FILE_PATTERN = /^agent-([\w-]+)\.meta\.json$/;
const JOURNAL_FILE_NAME = "journal.jsonl";

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line being written while we read is skipped; the next import picks it up.
    }
  }
  return entries;
}

/**
 * Spans of continuous work in a transcript: timestamps sorted, split wherever two entries are more
 * than `maxGapMs` apart. A session suspended mid-agent becomes two spans, not one long one.
 */
export function activeSegments(timestampsMs, maxGapMs = MAX_ACTIVE_GAP_MS) {
  const sorted = timestampsMs.filter(Number.isFinite).sort((left, right) => left - right);
  const segments = [];
  for (const at of sorted) {
    const current = segments[segments.length - 1];
    if (current && at - current[1] <= maxGapMs) current[1] = at;
    else segments.push([at, at]);
  }
  return segments;
}

/** Total milliseconds covered by a set of possibly overlapping [start, end] spans. */
export function unionMs(segments) {
  const sorted = [...segments].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let open = null;
  for (const [start, end] of sorted) {
    if (open && start <= open[1]) {
      open[1] = Math.max(open[1], end);
      continue;
    }
    if (open) total += open[1] - open[0];
    open = [start, end];
  }
  return open ? total + (open[1] - open[0]) : total;
}

/**
 * The agents a Workflow ran, read from its transcript directory: type, label and model from each
 * agent's meta file, timing from its own transcript, and whether the journal recorded a result.
 * Empty when the directory is missing.
 */
export function readWorkflowChildren(transcriptDir) {
  if (!transcriptDir || !statSync(transcriptDir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const finishedAgentIds = new Set(
    readJsonLines(join(transcriptDir, JOURNAL_FILE_NAME))
      .filter((entry) => entry.type === "result" && entry.agentId)
      .map((entry) => entry.agentId),
  );
  const children = [];
  for (const fileName of readdirSync(transcriptDir)) {
    const agentId = AGENT_FILE_PATTERN.exec(fileName)?.[1];
    if (!agentId) continue;
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(transcriptDir, fileName), "utf8"));
    } catch {
      // An unreadable meta file still leaves the transcript's timing.
    }
    const timestamps = readJsonLines(join(transcriptDir, `agent-${agentId}.jsonl`))
      .map((entry) => Date.parse(entry.timestamp))
      .filter(Number.isFinite);
    if (timestamps.length === 0) continue;
    const segments = activeSegments(timestamps);
    children.push({
      agentId,
      agentType: meta.agentType || null,
      label: meta.description || null,
      model: meta.model || null,
      startedAt: new Date(segments[0][0]).toISOString(),
      endedAt: new Date(segments[segments.length - 1][1]).toISOString(),
      activeMs: unionMs(segments),
      segments,
      isFinished: finishedAgentIds.has(agentId),
    });
  }
  return children;
}
