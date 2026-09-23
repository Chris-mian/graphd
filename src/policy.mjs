import { countRecentAgentNodes, hasDeclaredTopology, recordPolicyCheck } from "./db.mjs";
import { isEnforcementEnabled } from "./config.mjs";

export const RULE_REQUIRE_TOPOLOGY = "requireTopologyBeyondNAgents";

const WORKFLOW_TOOL = "Workflow";
const AGENT_TOOL = "Agent";
const DEFAULT_WINDOW_MINUTES = 30;

const DENY_REASON_TEMPLATE = [
  "graphd: {agentCount} agents spawned in the last {windowMinutes} minutes with no declared topology.",
  "",
  "Declare the shape before spawning more. Emit a TOPOLOGY block naming, for every edge,",
  "the artifact that crosses it — a variable, file, or list. An edge that carries nothing",
  "is not an edge, and those nodes run concurrently.",
  "",
  "  Shape:     pipeline",
  "  Nodes:     plan -> [impl x4] -> [verify x4] -> report",
  "  Edges:     plan->impl carries UNIT[]; impl->verify carries that unit's diff",
  "  Barriers:  report only",
  "  Because:   report is the only node that reads all units at once",
  "",
  "Then POST it to graphd (/v1/topology) or re-run: the check passes once a topology exists.",
  "Schema: ~/.claude/workflows/lib/contracts.md. Kill switch: touch ~/.graphd/DISABLED",
].join("\n");

/**
 * Evaluates the spawn against the single topology rule.
 * Workflow spawns are never denied: a workflow script is itself a declared topology.
 */
export function evaluateSpawn(store, config, { runId, tool }) {
  const rule = config.rules?.[RULE_REQUIRE_TOPOLOGY];
  if (!rule?.enabled) return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  if (tool === WORKFLOW_TOOL) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }
  if (tool !== AGENT_TOOL) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }

  const windowMinutes = rule.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const agentCount = countRecentAgentNodes(store, runId, windowMinutes);
  if (agentCount < rule.threshold) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }
  if (hasDeclaredTopology(store, runId)) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }
  return {
    wouldDeny: true,
    rule: RULE_REQUIRE_TOPOLOGY,
    reason: DENY_REASON_TEMPLATE.replace("{agentCount}", String(agentCount)).replace(
      "{windowMinutes}",
      String(windowMinutes),
    ),
  };
}

/**
 * Decides a spawn and records the decision.
 * A rule that would deny is always recorded; it only denies when enforcement is on, so
 * shadow rows measure the false-positive rate before enforcement is flipped.
 */
export function decideSpawn(store, config, request) {
  const verdict = evaluateSpawn(store, config, request);
  const isEnforced = verdict.wouldDeny && isEnforcementEnabled(config);
  recordPolicyCheck(store, {
    sessionId: request.sessionId,
    runId: request.runId,
    tool: request.tool,
    rule: verdict.rule,
    wouldDeny: verdict.wouldDeny,
    isEnforced,
    reason: verdict.reason,
  });
  return {
    isAllowed: !isEnforced,
    wouldDeny: verdict.wouldDeny,
    rule: verdict.rule,
    reason: isEnforced ? verdict.reason : null,
  };
}
