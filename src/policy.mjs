import { countRecentAgentNodes, hasDeclaredTopology, recordPolicyCheck } from "./db.mjs";
import { isEnforcementEnabled } from "./config.mjs";

export const RULE_REQUIRE_TOPOLOGY = "requireTopologyBeyondNAgents";

const WORKFLOW_TOOL = "Workflow";
const AGENT_TOOL = "Agent";
const DEFAULT_WINDOW_MINUTES = 30;

/**
 * Agent types the topology gate never denies and never counts toward its threshold. These are
 * agent definitions with no Edit/Write tool (several do carry Bash), so they gather or review
 * rather than implement. An empty or missing type is general-purpose and is not exempt.
 */
export const TOPOLOGY_EXEMPT_AGENT_TYPES = [
  "Explore",
  "Plan",
  "web-fetch",
  "claude-code-guide",
  "caveman:cavecrew-investigator",
  "caveman:cavecrew-reviewer",
  "plan-pressure-tester",
  "impl-pressure-tester",
  "tracker-consulter-perms-v2",
];

/** The one-liner that satisfies this rule, quoted for a shell and shared with the CLI usage text. */
export const TOPOLOGY_COMMAND_EXAMPLE = `graph topology '${JSON.stringify({
  shape: "pipeline",
  edges: [{ from: "plan", to: "impl", carries: "UNIT[]" }],
  barriers: ["report"],
  barrierJustification: "only node reading all units",
})}'`;

const DENY_REASON_TEMPLATE = [
  "graphd: {agentCount} agents spawned in the last {windowMinutes} minutes with no declared topology.",
  "Research/gathering fan-out should use `Explore` (one per source, spawned in one message), which never needs a topology.",
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
  "Then register it and re-run — the check passes once a topology exists:",
  "",
  `  ${TOPOLOGY_COMMAND_EXAMPLE}`,
  "",
  "Schema: ~/.claude/workflows/lib/contracts.md. Kill switch: touch ~/.graphd/DISABLED",
].join("\n");

/**
 * Evaluates the spawn against the single topology rule.
 * Workflow spawns are never denied: a workflow script is itself a declared topology.
 * Spawns of a TOPOLOGY_EXEMPT_AGENT_TYPES type are never denied and never counted.
 */
export function evaluateSpawn(store, config, { runId, tool, agentType }) {
  const rule = config.rules?.[RULE_REQUIRE_TOPOLOGY];
  if (!rule?.enabled) return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  if (tool === WORKFLOW_TOOL) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }
  if (tool !== AGENT_TOOL) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }
  if (agentType && TOPOLOGY_EXEMPT_AGENT_TYPES.includes(agentType)) {
    return { wouldDeny: false, rule: RULE_REQUIRE_TOPOLOGY, reason: null };
  }

  const windowMinutes = rule.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const agentCount = countRecentAgentNodes(
    store,
    runId,
    windowMinutes,
    TOPOLOGY_EXEMPT_AGENT_TYPES,
  );
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
    agentType: request.agentType,
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
