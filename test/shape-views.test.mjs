import { test } from "node:test";
import assert from "node:assert/strict";
import { averageConcurrency, shapeNodes, spendNodes } from "../src/analysis.mjs";
import { openStore } from "../src/db.mjs";
import { getRun, listRuns } from "../src/routes.mjs";
import { computeStats } from "../src/stats.mjs";

const RUN_ID = "33333333-4444-5555-6666-777777777777";
const MINUTE_MS = 60_000;
const START_MS = Date.parse("2026-09-25T10:00:00.000Z");
const iso = (offsetMs) => new Date(START_MS + offsetMs).toISOString();

const workflow = { id: "toolu_wf", tool: "Workflow", parent_node_id: null };
const childA = { id: "wf:r:a", tool: "Agent", parent_node_id: "toolu_wf" };
const childB = { id: "wf:r:b", tool: "Agent", parent_node_id: "toolu_wf" };
const lead = { id: "toolu_lead", tool: "Agent", parent_node_id: null };
const emptyWorkflow = { id: "toolu_empty", tool: "Workflow", parent_node_id: null };

test("the shape view replaces a Workflow with its children and keeps one with none", () => {
  const ids = shapeNodes([workflow, childA, childB, lead, emptyWorkflow]).map((node) => node.id);
  assert.deepEqual(ids, ["wf:r:a", "wf:r:b", "toolu_lead", "toolu_empty"]);
});

test("the spend view drops a Workflow's children, whose tokens the Workflow holds", () => {
  const ids = spendNodes([workflow, childA, childB, lead]).map((node) => node.id);
  assert.deepEqual(ids, ["toolu_wf", "toolu_lead"]);
});

test("average concurrency counts only time some agent was running", () => {
  const span = (startMinute, endMinute) => ({
    started_at: iso(startMinute * MINUTE_MS),
    ended_at: iso(endMinute * MINUTE_MS),
    is_async: 0,
  });
  // Two agents overlap fully for 10 minutes, then an hour of nothing, then one agent for 10.
  const nodes = [span(0, 10), span(0, 10), span(70, 80)];
  assert.equal(averageConcurrency(nodes), 30 / 20);
});

/** A run with a lead agent, then a Workflow whose three verifiers ran at once. */
function storeWithWorkflowRun() {
  const store = openStore(":memory:");
  store.prepare("INSERT INTO runs (id, session_id, started_at, declared_shape) VALUES (?, ?, ?, 'pipeline')").run(RUN_ID, RUN_ID, iso(0));
  const insert = store.prepare(
    `INSERT INTO nodes (id, run_id, parent_node_id, tool, agent_type, label, started_at, ended_at,
       status, duration_ms, true_duration_ms, total_tokens, resolved_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
  );
  const minutes = (count) => count * MINUTE_MS;
  insert.run("toolu_lead", RUN_ID, null, "Agent", "plan-pressure-tester", "plan", iso(0), iso(minutes(5)), minutes(5), minutes(5), 100_000, "claude-opus-5");
  insert.run("toolu_wf", RUN_ID, null, "Workflow", null, "implement-verify", iso(minutes(6)), iso(minutes(6)), 400, minutes(10), 900_000, null);
  for (const letter of ["a", "b", "c"]) {
    insert.run(`wf:r:${letter}`, RUN_ID, "toolu_wf", "Agent", "impl-pressure-tester", `verify:${letter}`, iso(minutes(6)), iso(minutes(16)), minutes(10), minutes(10), null, null);
  }
  return store;
}

test("a run's parallelism comes from the agents inside its Workflow, its spend from the Workflow", () => {
  const store = storeWithWorkflowRun();
  const [run] = listRuns(store, 1);
  assert.equal(run.node_count, 4);
  assert.equal(run.peakConcurrency, 3);
  assert.equal(run.observedShape, "fanout");
  assert.equal(run.totalTokens, 1_000_000);

  const detail = getRun(store, RUN_ID);
  assert.equal(detail.nodes.length, 5);
  assert.equal(detail.parallelism.verdict, "parallel");
  assert.ok(detail.nodes.find((node) => node.id === "toolu_wf").costUsd > 0);
  assert.equal(detail.nodes.find((node) => node.id === "wf:r:a").costUsd, 0);
});

test("stats keep a Workflow run's shape as a Workflow step and tally its agents apart", () => {
  const stats = computeStats(storeWithWorkflowRun());
  assert.equal(stats.nodeCount, 2);
  assert.equal(stats.workflowAgentCount, 3);
  assert.equal(stats.parallelRunCount, 1);
  assert.equal(stats.totalTokens, 1_000_000);
  assert.deepEqual(stats.byWorkflowAgentType.map((bucket) => [bucket.key, bucket.count]), [["impl-pressure-tester", 3]]);
  assert.ok(!stats.byAgentType.some((bucket) => bucket.key === "impl-pressure-tester"));
});
