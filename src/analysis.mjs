const MILLISECONDS_UNKNOWN = 0;
const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * When a node actually stopped working.
 * A background agent's tool call returns in milliseconds while the agent keeps running, so
 * ended_at measures the handoff. notified_at, set from the task notification, is the real end;
 * using ended_at for async nodes makes every fan-out read as a chain of instant nodes.
 */
function nodeEndMs(node, nowMs) {
  if (node.notified_at) return Date.parse(node.notified_at);
  if (node.is_async) return null;
  if (node.ended_at) return Date.parse(node.ended_at);
  const startedMs = Date.parse(node.started_at);
  return Math.min(nowMs, startedMs + MILLISECONDS_PER_HOUR);
}

/** A node whose end time is observed rather than guessed. */
export function hasKnownEnd(node) {
  return Boolean(node.notified_at) || (!node.is_async && Boolean(node.started_at));
}

/** Only nodes that can honestly be placed on a timeline. */
function measurableNodes(nodes) {
  return nodes.filter((node) => node.started_at && hasKnownEnd(node));
}

/**
 * The bucket a node's spend is reported under. An omitted subagent_type runs general-purpose
 * ("If omitted, the general-purpose agent is used."); a Workflow is named by its script.
 * The hook stores a missing type as "", hence `||`.
 */
export function agentTypeLabel(node) {
  if (node.agent_type) return node.agent_type;
  if (node.tool === "Workflow") return node.label ? `Workflow:${node.label}` : "Workflow (unnamed)";
  return "general-purpose (default)";
}

/**
 * Coarser key for comparing run shapes: a defaulted type is the same agent as an explicit
 * general-purpose one, and every Workflow is one kind of step whatever its script.
 */
export function agentTypeShapeKey(node) {
  if (node.agent_type) return node.agent_type;
  return node.tool === "Workflow" ? "Workflow" : "general-purpose";
}

/** Wall time the node spent working, preferring the async-aware measurement. */
export function nodeDurationMs(node) {
  if (node.true_duration_ms) return node.true_duration_ms;
  if (node.is_async) return MILLISECONDS_UNKNOWN;
  return node.duration_ms ?? MILLISECONDS_UNKNOWN;
}

/**
 * Peak number of nodes running at the same instant.
 * A node with no end is still running and is held open to now; starts win ties so two nodes
 * spawned in the same millisecond read as concurrent rather than cancelling out.
 */
export function peakConcurrency(nodes, nowMs = Date.now()) {
  const boundaries = [];
  for (const node of measurableNodes(nodes)) {
    boundaries.push({ at: Date.parse(node.started_at), delta: 1 });
    boundaries.push({ at: nodeEndMs(node, nowMs), delta: -1 });
  }
  boundaries.sort((left, right) => left.at - right.at || right.delta - left.delta);

  let running = 0;
  let peak = 0;
  for (const boundary of boundaries) {
    running += boundary.delta;
    if (running > peak) peak = running;
  }
  return peak;
}

/**
 * Agent-time that ran one-after-another and could have overlapped: total node duration minus
 * the slowest single node. Counts only time agents were actually running, so gaps where the
 * session was waiting on a human are excluded.
 */
export function serializationCostMs(nodes) {
  if (measurableNodes(nodes).length < nodes.length) return MILLISECONDS_UNKNOWN;
  const durations = nodes
    .map((node) => nodeDurationMs(node))
    .filter((duration) => duration > MILLISECONDS_UNKNOWN);
  if (durations.length < 2) return MILLISECONDS_UNKNOWN;
  if (peakConcurrency(nodes) > 1) return MILLISECONDS_UNKNOWN;
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  return totalMs - Math.max(...durations);
}

/**
 * Serialization edges derived from timing: B's immediate predecessor is the latest node that
 * had already finished when B started. Nodes that overlap something get no incoming edge,
 * which is what makes a real fan-out visibly edgeless.
 */
export function observedEdges(nodes, nowMs = Date.now()) {
  const ordered = measurableNodes(nodes).sort(
    (left, right) => Date.parse(left.started_at) - Date.parse(right.started_at),
  );
  const edges = [];
  for (const node of ordered) {
    const startedMs = Date.parse(node.started_at);
    const finishedBefore = ordered.filter(
      (candidate) => candidate.id !== node.id && nodeEndMs(candidate, nowMs) <= startedMs,
    );
    if (finishedBefore.length === 0) continue;
    const isOverlappingSomething = ordered.some(
      (candidate) =>
        candidate.id !== node.id &&
        Date.parse(candidate.started_at) < nodeEndMs(node, nowMs) &&
        startedMs < nodeEndMs(candidate, nowMs),
    );
    if (isOverlappingSomething) continue;
    const predecessor = finishedBefore.reduce((latest, candidate) =>
      nodeEndMs(candidate, nowMs) > nodeEndMs(latest, nowMs) ? candidate : latest,
    );
    edges.push({ kind: "observed", from_ref: predecessor.id, to_ref: node.id, carries: null });
  }
  return edges;
}

const BATCH_WINDOW_MS = 180_000;
const DUPLICATE_START_TOLERANCE_MS = 5_000;
const MERGEABLE_FIELDS = [
  "agent_type",
  "model",
  "resolved_model",
  "agent_id",
  "ended_at",
  "duration_ms",
  "total_tokens",
  "tool_use_count",
  "task_id",
  "output_file",
  "notified_at",
  "true_duration_ms",
  "prompt_text",
  "result_text",
];

const BACKFILL_ID_PREFIX = "toolu_";

const isBackfillRow = (node) => String(node.id ?? "").startsWith(BACKFILL_ID_PREFIX);

function isSameSpawn(left, right) {
  // A twin is by construction one live-hook row and one backfill row. Without this, two real
  // agents dispatched in the same assistant message — which share a label AND an identical
  // transcript timestamp, so the time tolerance never separates them — collapse into one.
  if (isBackfillRow(left) === isBackfillRow(right)) return false;
  if (left.run_id !== right.run_id) return false;
  if ((left.label ?? null) !== (right.label ?? null)) return false;
  if (left.tool !== right.tool) return false;
  const gapMs = Math.abs(Date.parse(left.started_at) - Date.parse(right.started_at));
  return gapMs <= DUPLICATE_START_TOLERANCE_MS;
}

/**
 * Collapses the two rows one spawn produces: the live hook writes a node keyed by prompt hash
 * and the transcript backfill writes another keyed by tool_use id. Left uncollapsed, every
 * agent counts twice and a solo spawn reads as a fan-out of two.
 */
export function dedupeNodes(nodes) {
  const merged = [];
  for (const node of [...nodes].sort(
    (left, right) => Date.parse(left.started_at) - Date.parse(right.started_at),
  )) {
    const twin = merged.find((candidate) => isSameSpawn(candidate, node));
    if (!twin) {
      merged.push({ ...node });
      continue;
    }
    for (const field of MERGEABLE_FIELDS) {
      if (twin[field] === null || twin[field] === undefined || twin[field] === 0) {
        twin[field] = node[field] ?? twin[field];
      }
    }
    twin.is_async = twin.is_async || node.is_async;
    if (twin.status === "running" || twin.status === "unknown") twin.status = node.status;
  }
  return merged;
}

/**
 * True only when every member reported a finish time and they all report the same one.
 * Comparing raw notified_at values would call a batch of nulls "completed together".
 */
function didCompleteTogether(members) {
  const finishTimes = members.map((member) => member.notified_at);
  if (finishTimes.some((finishTime) => !finishTime)) return false;
  return new Set(finishTimes).size === 1;
}

/**
 * Spawns grouped into delegation batches: agents launched close together with no completion
 * in between were dispatched as one fan-out, whether or not the lead said so.
 */
export function delegationBatches(nodes, nowMs = Date.now()) {
  const ordered = [...nodes].sort(
    (left, right) => Date.parse(left.started_at) - Date.parse(right.started_at),
  );
  const batches = [];
  for (const node of ordered) {
    const startedMs = Date.parse(node.started_at);
    const current = batches.at(-1);
    // A null end means unknown, not zero — comparing it numerically would read as "already
    // finished" and split a genuine fan-out into one batch per agent.
    const hasMemberFinished = (member) => {
      const memberEndMs = nodeEndMs(member, nowMs);
      return memberEndMs !== null && memberEndMs <= startedMs;
    };
    const isSameBatch =
      current &&
      startedMs - current.lastStartMs <= BATCH_WINDOW_MS &&
      !current.members.some(hasMemberFinished);
    if (isSameBatch) {
      current.members.push(node);
      current.lastStartMs = startedMs;
    } else {
      batches.push({ members: [node], firstStartMs: startedMs, lastStartMs: startedMs });
    }
  }
  return batches.map((batch, index) => ({
    index,
    spawnedAt: new Date(batch.firstStartMs).toISOString(),
    size: batch.members.length,
    nodeIds: batch.members.map((member) => member.id),
    peakConcurrency: peakConcurrency(batch.members, nowMs),
    completedTogether: didCompleteTogether(batch.members),
    isMeasured: batch.members.every((member) => hasKnownEnd(member)),
  }));
}

/**
 * Whether the run tried to parallelize and whether it succeeded.
 * A batch of two or more spawns is an attempt; overlapping execution is the achievement.
 * The gap between them is the thing worth acting on — intent was right, execution was not.
 */
export function parallelismReport(nodes, nowMs = Date.now()) {
  const batches = delegationBatches(nodes, nowMs);
  const attemptedBatches = batches.filter((batch) => batch.size > 1);
  const measuredBatches = attemptedBatches.filter((batch) => batch.isMeasured);
  const achievedBatches = measuredBatches.filter((batch) => batch.peakConcurrency > 1);
  const unmeasurable = nodes.filter((node) => node.is_async && !node.notified_at).length;
  const serialBatches = measuredBatches.length - achievedBatches.length;
  return {
    batchCount: batches.length,
    attemptedCount: attemptedBatches.length,
    measuredCount: measuredBatches.length,
    achievedCount: achievedBatches.length,
    largestBatch: batches.reduce((widest, batch) => Math.max(widest, batch.size), 0),
    unmeasurableNodeCount: unmeasurable,
    verdict:
      attemptedBatches.length === 0
        ? "one at a time"
        : measuredBatches.length === 0
          ? "attempted, end times unknown"
          : serialBatches > 0
            ? "attempted, ran serial"
            : "parallel",
  };
}

/**
 * Shape inferred from what actually ran, independent of what was declared.
 * Returns "unknown" when a node's end time was never observed: calling that a chain invents a
 * mismatch, and calling it a fan-out invents the overlap this system exists to check for.
 */
export function observedShape(nodes) {
  if (nodes.length === 0) return "empty";
  if (nodes.some((node) => node.tool === "Workflow")) return "workflow";
  const measurable = measurableNodes(nodes);
  if (measurable.length < nodes.length && peakConcurrency(measurable) < 2) return "unknown";
  return peakConcurrency(measurable) > 1 ? "fanout" : "chain";
}

/**
 * Compares the declared shape against what ran.
 * A declared fan-out that executed one node at a time is the defect this whole system exists
 * to surface.
 */
export function topologyDiff({ declaredShape, nodes }) {
  const observed = observedShape(nodes);
  const isConcurrentDeclared = declaredShape === "pipeline" || declaredShape === "fanout";
  const unmeasurableNodeCount = nodes.length - measurableNodes(nodes).length;
  return {
    declaredShape: declaredShape ?? null,
    observedShape: observed,
    peakConcurrency: peakConcurrency(nodes),
    serializationCostMs: serializationCostMs(nodes),
    unmeasurableNodeCount,
    isMismatch:
      observed === "unknown"
        ? null
        : Boolean(declaredShape) && isConcurrentDeclared && observed === "chain",
    isUndeclared: !declaredShape && nodes.length > 1,
  };
}
