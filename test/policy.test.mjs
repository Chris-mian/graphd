import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RULE_REQUIRE_TOPOLOGY, decideSpawn, evaluateSpawn } from "../src/policy.mjs";
import { isTopologySubstantive, recordTopology, upsertRun } from "../src/db.mjs";
import { handleTopology } from "../src/routes.mjs";

const RUN_ID = "run-policy";
const THRESHOLD = 2;
const ENFORCING_CONFIG = {
  enforce: true,
  rules: { [RULE_REQUIRE_TOPOLOGY]: { enabled: true, threshold: THRESHOLD, windowMinutes: 30 } },
};

/**
 * The canonical declaration the eng-task skill tells callers to POST. Pinned verbatim so the
 * validator can never reject the shape the documentation hands people.
 */
const SKILL_TOPOLOGY = {
  shape: "pipeline",
  edges: [{ from: "plan", to: "impl", carries: "UNIT[]" }],
  barriers: ["report"],
  barrierJustification: "only node reading all units",
};

function freshStore() {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  upsertRun(store, { runId: RUN_ID, sessionId: RUN_ID });
  return store;
}

/** Adds `count` live-hook Agent nodes; ids avoid the `toolu_` prefix the gate excludes. */
function spawnAgents(store, count) {
  for (let index = 0; index < count; index += 1) {
    store
      .prepare(
        `INSERT INTO nodes (id, run_id, tool, started_at, status)
         VALUES (?, ?, 'Agent', datetime('now'), 'ok')`,
      )
      .run(`hook-node-${index}`, RUN_ID);
  }
}

test("the third Agent with no topology is denied", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD);
  const verdict = evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Agent" });
  assert.equal(verdict.wouldDeny, true);
});

test("the denial hands back a command whose own topology clears the gate", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD);
  const verdict = evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Agent" });
  assert.match(verdict.reason, /graph topology '/);
  const quoted = verdict.reason.match(/graph topology '(.+)'/)[1];
  assert.equal(handleTopology(store, { sessionId: RUN_ID, topology: JSON.parse(quoted) }).accepted, true);
  assert.equal(evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Agent" }).wouldDeny, false);
});

test("a spawn below the threshold is allowed", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD - 1);
  assert.equal(
    evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Agent" }).wouldDeny,
    false,
  );
});

test("Workflow is never denied: the script is itself a declared topology", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD + 3);
  assert.equal(
    evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Workflow" }).wouldDeny,
    false,
  );
});

test("a declared topology clears the gate", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD);
  recordTopology(store, { runId: RUN_ID, topology: SKILL_TOPOLOGY });
  assert.equal(
    evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Agent" }).wouldDeny,
    false,
  );
});

test("an empty topology does not clear the gate", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD);
  recordTopology(store, { runId: RUN_ID, topology: {} });
  assert.equal(
    evaluateSpawn(store, ENFORCING_CONFIG, { runId: RUN_ID, tool: "Agent" }).wouldDeny,
    true,
  );
});

test("shadow mode records the would-deny without denying", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD);
  const shadowConfig = { ...ENFORCING_CONFIG, enforce: false };
  const decision = decideSpawn(store, shadowConfig, { runId: RUN_ID, tool: "Agent" });
  assert.equal(decision.isAllowed, true);
  assert.equal(decision.wouldDeny, true);
  const row = store.prepare("SELECT would_deny, enforced FROM policy_checks").get();
  assert.equal(row.would_deny, 1);
  assert.equal(row.enforced, 0);
});

test("a disabled rule never denies", () => {
  const store = freshStore();
  spawnAgents(store, THRESHOLD + 2);
  const disabledConfig = {
    enforce: true,
    rules: { [RULE_REQUIRE_TOPOLOGY]: { enabled: false, threshold: THRESHOLD } },
  };
  assert.equal(
    evaluateSpawn(store, disabledConfig, { runId: RUN_ID, tool: "Agent" }).wouldDeny,
    false,
  );
});

test("the skill's documented topology is accepted", () => {
  const store = freshStore();
  const result = handleTopology(store, { sessionId: RUN_ID, topology: SKILL_TOPOLOGY });
  assert.equal(result.accepted, true);
  assert.equal(result.shape, "pipeline");
});

test("a straight-line topology is still accepted: serial work must stay declarable", () => {
  const chain = {
    shape: "chain",
    nodes: ["one", "two", "three"],
    edges: [
      { from: "one", to: "two", carries: "parsed rows" },
      { from: "two", to: "three", carries: "summary" },
    ],
    barriers: [],
    barrierJustification: "none",
  };
  assert.equal(isTopologySubstantive(chain), true);
});

test("a POST with no topology is rejected and stores nothing", () => {
  const store = freshStore();
  const result = handleTopology(store, { sessionId: RUN_ID });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /carries/);
  assert.equal(store.prepare("SELECT topology_json FROM runs WHERE id = ?").get(RUN_ID)
    .topology_json, null);
});

test("an edge carrying nothing is rejected", () => {
  assert.equal(
    isTopologySubstantive({ shape: "pipeline", edges: [{ from: "a", to: "b" }] }),
    false,
  );
});

test("a topology with no edges and no nodes is rejected", () => {
  assert.equal(isTopologySubstantive({ shape: "pipeline", edges: [] }), false);
  assert.equal(isTopologySubstantive({}), false);
  assert.equal(isTopologySubstantive(null), false);
});
