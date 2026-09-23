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
  topologyDiff,
} from "./analysis.mjs";

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
    return {
      ...run,
      node_count: nodes.length,
      totalTokens: nodes.reduce((sum, node) => sum + (node.total_tokens ?? 0), 0),
      parallelism: parallelismReport(nodes),
      ...topologyDiff({ declaredShape: run.declared_shape, nodes }),
    };
  });
}

export function selectNodes(store, runId) {
  const rows = store
    .prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY started_at")
    .all(runId);
  return dedupeNodes(rows);
}

export function getRun(store, runId) {
  const run = store.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) return null;
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
  return {
    run,
    nodes,
    edges: [...declaredEdges, ...observedEdges(nodes)],
    diff: topologyDiff({ declaredShape: run.declared_shape, nodes }),
    batches: delegationBatches(nodes),
    parallelism: parallelismReport(nodes),
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

/** Invocation feed: every event the hooks emitted, newest first. */
export function listEvents(store, limit = DEFAULT_RUN_LIMIT) {
  return store
    .prepare("SELECT id, ts, kind, session_id, run_id, payload FROM events ORDER BY ts DESC LIMIT ?")
    .all(limit)
    .map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
}
