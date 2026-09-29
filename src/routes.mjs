import { createHash, timingSafeEqual } from "node:crypto";
import {
  classifyTargetRef,
  completeNode,
  insertNode,
  insertResumption,
  isTopologySubstantive,
  nowIso,
  recordEvent,
  recordTopology,
  resolveRunningNodeId,
  resumptionsForRun,
  upsertRun,
} from "./db.mjs";
import { decideSpawn } from "./policy.mjs";
import {
  dedupeNodes,
  delegationBatches,
  observedEdges,
  parallelismReport,
  shapeNodes,
  spendNodes,
  topologyDiff,
} from "./analysis.mjs";
import { estimateCost } from "./pricing.mjs";

const DEFAULT_RUN_LIMIT = 50;
const PROMPT_SHA_ALGORITHM = "sha256";
const PROMPT_SHA_LENGTH = 12;
const MAX_TEXT_CHARS = 4000;

export function hashPrompt(prompt) {
  if (!prompt) return null;
  return createHash(PROMPT_SHA_ALGORITHM).update(prompt).digest("hex").slice(0, PROMPT_SHA_LENGTH);
}

/** Constant-time bearer-token comparison. */
export function isTokenValid(presented, expected) {
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** A run is the session unless the caller supplies a workflow run id. */
function resolveRunId({ runId, sessionId }) {
  return runId ?? sessionId;
}

export function handleNodeSpawn(store, body) {
  const runId = resolveRunId(body);
  upsertRun(store, { runId, sessionId: body.sessionId, cwd: body.cwd });
  insertNode(store, {
    id: body.nodeId,
    runId,
    parentNodeId: body.parentNodeId,
    tool: body.tool,
    agentType: body.agentType,
    label: body.label,
    name: body.name,
    model: body.model,
    promptSha: hashPrompt(body.prompt),
    promptText: body.prompt ? body.prompt.slice(0, MAX_TEXT_CHARS) : null,
  });
  return { runId, nodeId: body.nodeId };
}

export function handleNodeEnd(store, body) {
  const nodeId = resolveRunningNodeId(store, {
    runId: resolveRunId(body),
    promptSha: hashPrompt(body.prompt),
    nodeId: body.nodeId,
  });
  completeNode(store, { nodeId, status: body.status ?? "unknown", result: body.result ?? {} });
  return { nodeId };
}

/**
 * Stores a declared topology, rejecting one that says nothing.
 * Rejecting at the POST rather than at the next spawn means the declaration fails where it
 * was written, not three agents later.
 */
export function handleTopology(store, body) {
  const runId = resolveRunId(body);
  const topology = body.topology ?? {};
  if (!isTopologySubstantive(topology)) {
    return {
      runId,
      accepted: false,
      shape: null,
      reason:
        "graphd: topology not stored — it needs at least one node or edge, and every edge " +
        "needs from, to, and a `carries` naming the artifact that crosses it. An edge that " +
        "carries nothing is not an edge, and those nodes run concurrently.",
    };
  }
  upsertRun(store, { runId, sessionId: body.sessionId, cwd: body.cwd });
  recordTopology(store, { runId, topology });
  return { runId, accepted: true, shape: topology.shape ?? null };
}

/** Records a message sent to a running agent. The lead thread is the sender unless one is named. */
export function handleResumption(store, body) {
  const runId = resolveRunId(body);
  upsertRun(store, { runId, sessionId: body.sessionId, cwd: body.cwd });
  const changes = insertResumption(store, {
    id: body.resumptionId ?? `${runId}-${hashPrompt(`${body.targetRef}${nowIso()}`)}`,
    runId,
    ts: nowIso(),
    targetRef: body.targetRef ?? null,
    targetKind: classifyTargetRef(body.targetRef),
    sender: body.senderRef ? "agent" : "lead",
    senderRef: body.senderRef ?? null,
  });
  return { runId, accepted: changes > 0 };
}

export function handlePolicyCheck(store, config, body) {
  const runId = resolveRunId(body);
  upsertRun(store, { runId, sessionId: body.sessionId, cwd: body.cwd });
  return decideSpawn(store, config, { runId, sessionId: body.sessionId, tool: body.tool });
}

export function handleEvent(store, config, body) {
  recordEvent(store, {
    kind: body.kind,
    sessionId: body.sessionId,
    runId: resolveRunId(body),
    payload: body,
  });
  switch (body.kind) {
    case "node_spawn":
      return handleNodeSpawn(store, body);
    case "node_end":
      return handleNodeEnd(store, body);
    case "topology":
      return handleTopology(store, body);
    case "resumption":
      return handleResumption(store, body);
    default:
      return { accepted: true };
  }
}

export function listRuns(store, limit = DEFAULT_RUN_LIMIT) {
  const runs = store
    .prepare(
      `SELECT r.id, r.session_id, r.cwd, r.started_at, r.declared_shape,
              COUNT(n.id) AS node_count
         FROM runs r
         LEFT JOIN nodes n ON n.run_id = r.id
        GROUP BY r.id
        ORDER BY r.started_at DESC
        LIMIT ?`,
    )
    .all(limit);
  return runs.map((run) => {
    const nodes = selectNodes(store, run.id);
    const ranNodes = shapeNodes(nodes);
    return {
      ...run,
      node_count: ranNodes.length,
      totalTokens: spendNodes(nodes).reduce((sum, node) => sum + (node.total_tokens ?? 0), 0),
      parallelism: parallelismReport(ranNodes),
      ...topologyDiff({ declaredShape: run.declared_shape, nodes: ranNodes }),
    };
  });
}

export function selectNodes(store, runId) {
  const rows = store
    .prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY started_at")
    .all(runId);
  return dedupeNodes(rows);
}

/** `graph runs` prints this many characters of a run id, so a prefix this long is accepted. */
export const MIN_RUN_ID_PREFIX_LENGTH = 8;
export const AMBIGUOUS_RUN_ID = "ambiguous run id";

/**
 * The run with this exact id, else the single run whose id starts with it. Returns
 * `{ ambiguous: [ids] }` when several match, and null for a prefix shorter than the printed one.
 */
function resolveRun(store, runIdOrPrefix) {
  const exact = store.prepare("SELECT * FROM runs WHERE id = ?").get(runIdOrPrefix);
  if (exact) return { run: exact };
  if (runIdOrPrefix.length < MIN_RUN_ID_PREFIX_LENGTH) return null;
  const matches = store
    .prepare("SELECT * FROM runs WHERE substr(id, 1, length(?1)) = ?1 ORDER BY started_at DESC")
    .all(runIdOrPrefix);
  if (matches.length === 1) return { run: matches[0] };
  return matches.length > 1 ? { ambiguous: matches.map((match) => match.id) } : null;
}

/** The words `graph show` prints for a failed lookup, from the daemon's "<status> <body>" error. */
export function describeRunLookupFailure(errorMessage, runIdOrPrefix) {
  const [status, ...body] = String(errorMessage).split(" ");
  if (status === "404") return `no run matches ${runIdOrPrefix}`;
  if (status === "409") {
    const { matches } = JSON.parse(body.join(" "));
    return `${runIdOrPrefix} matches ${matches.length} runs: ${matches.join(", ")}`;
  }
  return null;
}

export function getRun(store, runIdOrPrefix) {
  const resolved = resolveRun(store, runIdOrPrefix);
  if (!resolved) return null;
  if (resolved.ambiguous) return { error: AMBIGUOUS_RUN_ID, matches: resolved.ambiguous };
  const { run } = resolved;
  const runId = run.id;
  const nodes = selectNodes(store, runId);
  const declaredEdges = store
    .prepare("SELECT * FROM edges WHERE run_id = ? AND kind = 'declared'")
    .all(runId);
  const checks = store
    .prepare("SELECT * FROM policy_checks WHERE run_id = ? ORDER BY ts")
    .all(runId);
  const interventions = store
    .prepare("SELECT * FROM interventions WHERE run_id = ? ORDER BY ts")
    .all(runId);
  // Timing views read the agents that ran, with a Workflow replaced by its children; the node
  // list keeps both so the timeline can nest children under their Workflow.
  const ranNodes = shapeNodes(nodes);
  return {
    run,
    nodes: nodes.map((node) => ({
      ...node,
      costUsd: estimateCost({ totalTokens: node.total_tokens, model: node.resolved_model ?? node.model }).estimate,
    })),
    edges: [...declaredEdges, ...observedEdges(ranNodes)],
    diff: topologyDiff({ declaredShape: run.declared_shape, nodes: ranNodes }),
    batches: delegationBatches(ranNodes),
    parallelism: parallelismReport(ranNodes),
    topology: run.topology_json ? JSON.parse(run.topology_json) : null,
    checks,
    interventions,
    resumptions: resumptionsForRun(store, runId),
  };
}

export function listPolicyChecks(store, limit = DEFAULT_RUN_LIMIT) {
  return store
    .prepare("SELECT * FROM policy_checks ORDER BY ts DESC LIMIT ?")
    .all(limit);
}

/**
 * Recent messages to running agents, newest first.
 * Joins to the target node so the UI can name who was resumed rather than print a raw ref.
 */
export function listResumptions(store, limit = DEFAULT_RUN_LIMIT) {
  return store
    .prepare(
      `SELECT r.*, n.label AS target_label, n.agent_type AS target_agent_type
         FROM resumptions r
         LEFT JOIN nodes n ON n.id = r.node_id
        ORDER BY r.ts DESC LIMIT ?`,
    )
    .all(limit);
}

/** Invocation feed: every event the hooks emitted, newest first. */
export function listEvents(store, limit = DEFAULT_RUN_LIMIT) {
  return store
    .prepare("SELECT id, ts, kind, session_id, run_id, payload FROM events ORDER BY ts DESC LIMIT ?")
    .all(limit)
    .map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
}
