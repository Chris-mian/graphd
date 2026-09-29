import { autonomyTrend } from "./lessons.mjs";
import { selectRunsWithNodes, summarizeRun } from "./stats.mjs";

const MULTI_AGENT_THRESHOLD = 2;

function emptyWeek(week) {
  return {
    week,
    runs: 0,
    multiAgentRuns: 0,
    parallelRuns: 0,
    declaredRuns: 0,
    serializedMs: 0,
    agentMs: 0,
    busyMs: 0,
    costUsd: 0,
  };
}

/**
 * Parallelism, waste and spend per week, over the same `%Y-W%W` weeks `graph lessons` uses, with
 * that series' human interventions per session alongside. A run falls in the week it started; a
 * week with sessions but no runs is listed with zero runs.
 */
export function computeTrend(store) {
  const weekOf = store.prepare("SELECT strftime('%Y-W%W', ?) AS week");
  const weeks = new Map();
  for (const summary of selectRunsWithNodes(store).map(summarizeRun)) {
    const { week } = weekOf.get(summary.startedAt);
    const bucket = weeks.get(week) ?? emptyWeek(week);
    bucket.runs += 1;
    bucket.costUsd += summary.costUsd;
    if (summary.nodeCount >= MULTI_AGENT_THRESHOLD) {
      bucket.multiAgentRuns += 1;
      if (summary.peak > 1) bucket.parallelRuns += 1;
      if (summary.declaredShape) bucket.declaredRuns += 1;
      bucket.serializedMs += summary.serializedMs;
      bucket.agentMs += summary.agentMs;
      bucket.busyMs += summary.busyMs;
    }
    weeks.set(week, bucket);
  }
  const autonomyByWeek = new Map(autonomyTrend(store).map((row) => [row.week, row]));
  // A week with sessions but no agent spawned still has an intervention rate worth showing.
  for (const week of autonomyByWeek.keys()) if (!weeks.has(week)) weeks.set(week, emptyWeek(week));
  return [...weeks.values()]
    .sort((left, right) => left.week.localeCompare(right.week))
    .map(({ agentMs, busyMs, ...bucket }) => ({
      ...bucket,
      averageConcurrency: busyMs > 0 ? agentMs / busyMs : null,
      humanInterventionsPerSession: autonomyByWeek.get(bucket.week)?.perSession ?? null,
    }));
}
