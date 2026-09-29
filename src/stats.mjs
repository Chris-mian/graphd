import { spendByProject } from "./projects.mjs";
import {
  agentTypeLabel,
  agentTypeShapeKey,
  concurrencyTotals,
  dedupeNodes,
  nodeDurationMs,
  peakConcurrency,
  serializationCostMs,
  shapeNodes,
  spendNodes,
} from "./analysis.mjs";
import { estimateCost } from "./pricing.mjs";

const MULTI_AGENT_THRESHOLD = 2;
const TOP_LIST_LENGTH = 8;

/** Every run that recorded a node, with its deduplicated nodes. */
export function selectRunsWithNodes(store) {
  const nodesByRun = new Map();
  for (const node of dedupeNodes(store.prepare("SELECT * FROM nodes ORDER BY started_at").all())) {
    if (!nodesByRun.has(node.run_id)) nodesByRun.set(node.run_id, []);
    nodesByRun.get(node.run_id).push(node);
  }
  return store
    .prepare("SELECT * FROM runs")
    .all()
    .map((run) => ({ run, nodes: nodesByRun.get(run.id) ?? [] }))
    .filter((entry) => entry.nodes.length > 0);
}

/** One run's shape from the agents that ran, and its spend from the nodes that carry tokens. */
export function summarizeRun({ run, nodes }) {
  const ranNodes = shapeNodes(nodes);
  const spentNodes = spendNodes(nodes);
  const totalTokens = spentNodes.reduce((sum, node) => sum + (node.total_tokens ?? 0), 0);
  const costs = spentNodes.map((node) =>
    estimateCost({ totalTokens: node.total_tokens, model: node.resolved_model ?? node.model }),
  );
  const sumOfCosts = (field) => costs.reduce((sum, cost) => sum + cost[field], 0);
  return {
    runId: run.id,
    cwd: run.cwd,
    startedAt: run.started_at,
    declaredShape: run.declared_shape ?? null,
    nodeCount: ranNodes.length,
    peak: peakConcurrency(ranNodes),
    serializedMs: serializationCostMs(ranNodes),
    ...concurrencyTotals(ranNodes),
    totalTokens,
    costUsd: sumOfCosts("estimate"),
    costLowUsd: sumOfCosts("low"),
    costHighUsd: sumOfCosts("high"),
    // Spend nodes, so a Workflow run keeps its Workflow step rather than reading as the
    // verifiers inside it, which would make every implement-verify run a harvest candidate.
    agentTypes: spentNodes.map(agentTypeShapeKey),
  };
}

/** Runs that spawned several agents but never ran two at once. */
export function sequentialFanouts(summaries) {
  return summaries
    .filter((entry) => entry.nodeCount >= MULTI_AGENT_THRESHOLD && entry.peak <= 1)
    .sort((left, right) => right.serializedMs - left.serializedMs);
}

/** Nodes grouped by key; Workflow nodes add no durationMs and are counted in untimedCount. */
function tallyBy(nodes, keyOf) {
  const tally = new Map();
  for (const node of nodes) {
    const key = keyOf(node) ?? "unknown";
    const bucket = tally.get(key) ?? {
      key,
      count: 0,
      untimedCount: 0,
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
    };
    bucket.count += 1;
    bucket.tokens += node.total_tokens ?? 0;
    // A Workflow's duration runs until the lead saw its notice, which an idle session stretches
    // across days. It is not agent time.
    if (node.tool === "Workflow") bucket.untimedCount += 1;
    else bucket.durationMs += nodeDurationMs(node);
    bucket.costUsd += estimateCost({
      totalTokens: node.total_tokens,
      model: node.resolved_model ?? node.model,
    }).estimate;
    tally.set(key, bucket);
  }
  return [...tally.values()].sort((left, right) => right.costUsd - left.costUsd);
}

/** Agent-type sequences seen in more than one run — the harvest candidates. */
export function repeatedSequences(summaries) {
  const byShape = new Map();
  for (const entry of summaries) {
    if (entry.nodeCount < MULTI_AGENT_THRESHOLD) continue;
    const shape = [...new Set(entry.agentTypes)].sort().join(" + ");
    const bucket = byShape.get(shape) ?? { shape, runs: 0, sequentialRuns: 0, serializedMs: 0 };
    bucket.runs += 1;
    if (entry.peak <= 1) bucket.sequentialRuns += 1;
    bucket.serializedMs += entry.serializedMs;
    byShape.set(shape, bucket);
  }
  return [...byShape.values()]
    .filter((bucket) => bucket.runs > 1)
    .sort((left, right) => right.serializedMs - left.serializedMs)
    .slice(0, TOP_LIST_LENGTH);
}

/** Aggregate view over every recorded run: shape, waste, spend, and repeat candidates. */
export function computeStats(store) {
  const summaries = selectRunsWithNodes(store).map(summarizeRun);
  const dedupedNodes = dedupeNodes(store.prepare("SELECT * FROM nodes").all());
  const allNodes = spendNodes(dedupedNodes);
  const workflowAgents = dedupedNodes.filter((node) => node.parent_node_id);
  const multiAgent = summaries.filter((entry) => entry.nodeCount >= MULTI_AGENT_THRESHOLD);
  const multiAgentBusyMs = multiAgent.reduce((sum, entry) => sum + entry.busyMs, 0);
  const sequential = sequentialFanouts(summaries);

  return {
    projectSpend: spendByProject(store),
    runCount: summaries.length,
    nodeCount: allNodes.length,
    workflowAgentCount: workflowAgents.length,
    multiAgentRunCount: multiAgent.length,
    parallelRunCount: multiAgent.filter((entry) => entry.peak > 1).length,
    averageConcurrency:
      multiAgentBusyMs > 0
        ? multiAgent.reduce((sum, entry) => sum + entry.agentMs, 0) / multiAgentBusyMs
        : null,
    sequentialRunCount: sequential.length,
    totalTokens: summaries.reduce((sum, entry) => sum + entry.totalTokens, 0),
    totalCostUsd: summaries.reduce((sum, entry) => sum + entry.costUsd, 0),
    totalCostLowUsd: summaries.reduce((sum, entry) => sum + entry.costLowUsd, 0),
    totalCostHighUsd: summaries.reduce((sum, entry) => sum + entry.costHighUsd, 0),
    sequentialSerializedMs: sequential.reduce((sum, entry) => sum + entry.serializedMs, 0),
    sequentialCostUsd: sequential.reduce((sum, entry) => sum + entry.costUsd, 0),
    byAgentType: tallyBy(allNodes, agentTypeLabel).slice(0, TOP_LIST_LENGTH),
    byModel: tallyBy(allNodes, (node) => node.resolved_model ?? node.model).slice(0, TOP_LIST_LENGTH),
    byWorkflowAgentType: tallyBy(workflowAgents, agentTypeLabel)
      .sort((left, right) => right.count - left.count)
      .slice(0, TOP_LIST_LENGTH),
    worstSequential: sequential.slice(0, TOP_LIST_LENGTH),
    repeatedSequences: repeatedSequences(summaries),
  };
}
