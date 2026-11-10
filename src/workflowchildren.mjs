import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unionMs } from "./analysis.mjs";
import { usageByModel } from "./transcriptusage.mjs";

export { unionMs };

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
 * A gap with a tool call in flight is the agent waiting on its own tool, which is work. Past this
 * long it is a session suspended mid-call instead; the longest shell call the runtime allows is 10
 * minutes.
 */
export const MAX_TOOL_CALL_MS = 30 * 60_000;

/**
 * Spans of continuous work in a transcript: entries sorted by time, split wherever two are more than
 * `maxGapMs` apart, unless the earlier one left a tool call in flight for under MAX_TOOL_CALL_MS.
 * A session suspended mid-agent becomes two spans, not one long one. Each point is a timestamp in
 * ms, or `{ at, toolInFlight }`.
 */
export function activeSegments(points, maxGapMs = MAX_ACTIVE_GAP_MS) {
  const sorted = points
    .map((point) => (typeof point === "number" ? { at: point, toolInFlight: false } : point))
    .filter((point) => Number.isFinite(point.at))
    .sort((left, right) => left.at - right.at);
  const segments = [];
  let previous = null;
  for (const point of sorted) {
    const current = segments[segments.length - 1];
    const gapMs = previous ? point.at - previous.at : Infinity;
    const isBusy = gapMs <= maxGapMs || (previous?.toolInFlight && gapMs <= MAX_TOOL_CALL_MS);
    if (current && isBusy) current[1] = point.at;
    else segments.push([point.at, point.at]);
    previous = point;
  }
  return segments;
}

/**
 * Each entry's time, and whether a tool call it or an earlier entry started is still unanswered.
 * Walked in time order, not file order: a notification that arrived during a tool call is written
 * after the call's result but stamped with its arrival time.
 */
export function activityPoints(entries) {
  const openToolUseIds = new Set();
  const points = [];
  const timed = entries
    .map((entry) => ({ entry, at: Date.parse(entry.timestamp) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at);
  for (const { entry, at } of timed) {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.id) openToolUseIds.add(block.id);
      if (block?.type === "tool_result" && block.tool_use_id) openToolUseIds.delete(block.tool_use_id);
    }
    points.push({ at, toolInFlight: openToolUseIds.size > 0 });
  }
  return points;
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
    const entries = readJsonLines(join(transcriptDir, `agent-${agentId}.jsonl`));
    const points = activityPoints(entries);
    if (points.length === 0) continue;
    const segments = activeSegments(points);
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
      usage: usageByModel(entries),
    });
  }
  return children;
}

/** How many agents a Workflow's transcript directory has meta for, transcript or not. */
export function countWorkflowAgents(transcriptDir) {
  if (!transcriptDir || !statSync(transcriptDir, { throwIfNoEntry: false })?.isDirectory()) return 0;
  return readdirSync(transcriptDir).filter((fileName) => AGENT_FILE_PATTERN.test(fileName)).length;
}
