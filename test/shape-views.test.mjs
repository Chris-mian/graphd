import { test } from "node:test";
import assert from "node:assert/strict";
import { averageConcurrency, peakConcurrency, shapeNodes, spendNodes } from "../src/analysis.mjs";
import { openStore } from "../src/db.mjs";
import { getRun, listRuns } from "../src/routes.mjs";
import { spendByProject } from "../src/projects.mjs";
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

test("a Workflow agent suspended overnight counts only its working spans", () => {
  const day = 24 * 60 * MINUTE_MS;
  const spans = [[START_MS, START_MS + 10 * MINUTE_MS], [START_MS + day, START_MS + day + 10 * MINUTE_MS]];
  const suspended = { started_at: iso(0), ended_at: iso(day + 10 * MINUTE_MS), is_async: 0, parent_node_id: "toolu_wf", active_segments: JSON.stringify(spans) };
  const sibling = { started_at: iso(0), ended_at: iso(10 * MINUTE_MS), is_async: 0, parent_node_id: "toolu_wf" };
  // Next morning another agent runs; it never overlapped the suspended one's work.
  const morning = { started_at: iso(12 * 60 * MINUTE_MS), ended_at: iso(12 * 60 * MINUTE_MS + MINUTE_MS), is_async: 0 };
  assert.equal(peakConcurrency([suspended, sibling, morning]), 2);
  assert.equal(averageConcurrency([suspended, sibling, morning]), (10 + 10 + 10 + 1) / (10 + 10 + 1));
});

/** A run with a lead agent, then a Workflow whose verifiers (three by default) ran at once. */
function storeWithWorkflowRun({ runId = RUN_ID, store = openStore(":memory:"), verifiers = ["a", "b", "c"], childTokens = 50 } = {}) {
  store.prepare("INSERT INTO runs (id, session_id, started_at, declared_shape) VALUES (?, ?, ?, 'pipeline')").run(runId, runId, iso(0));
  const insert = store.prepare(
    `INSERT INTO nodes (id, run_id, parent_node_id, tool, agent_type, label, started_at, ended_at,
       status, duration_ms, true_duration_ms, total_tokens, resolved_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
  );
  const minutes = (count) => count * MINUTE_MS;
  const id = (name) => (runId === RUN_ID ? name : `${name}-${runId.slice(0, 4)}`);
  insert.run(id("toolu_lead"), runId, null, "Agent", "plan-pressure-tester", "plan", iso(0), iso(minutes(5)), minutes(5), minutes(5), 100_000, "claude-opus-5");
  insert.run(id("toolu_wf"), runId, null, "Workflow", null, "implement-verify", iso(minutes(6)), iso(minutes(6)), 400, minutes(10), 900_000, null);
  // Children's tokens are what the Workflow already holds, so the spend view must drop them.
  for (const letter of verifiers) {
    insert.run(id(`wf:r:${letter}`), runId, id("toolu_wf"), "Agent", "impl-pressure-tester", `verify:${letter}`, iso(minutes(6)), iso(minutes(16)), minutes(10), minutes(10), childTokens, null);
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

test("a single-agent Workflow run reads as a chain, with the Workflow nowhere in its timing views", () => {
  const store = storeWithWorkflowRun({ verifiers: ["a"] });
  const detail = getRun(store, RUN_ID);
  assert.notEqual(detail.parallelism.verdict, "parallel");
  assert.equal(detail.diff.observedShape, "chain");
  const batchIds = detail.batches.flatMap((batch) => batch.nodeIds);
  assert.ok(batchIds.includes("wf:r:a"));
  assert.ok(!batchIds.includes("toolu_wf"));
  assert.ok(!detail.edges.some((edge) => edge.from === "toolu_wf" || edge.to === "toolu_wf"));
});

test("repeated Workflow runs are a harvest shape by their Workflow step, and a lone Workflow is none", () => {
  const store = storeWithWorkflowRun();
  storeWithWorkflowRun({ store, runId: "44444444-4444-5555-6666-777777777777" });
  assert.deepEqual(computeStats(store).repeatedSequences.map((bucket) => bucket.shape), ["Workflow + plan-pressure-tester"]);

  const lone = openStore(":memory:");
  for (const runId of ["55555555-4444-5555-6666-777777777777", "66666666-4444-5555-6666-777777777777"]) {
    lone.prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)").run(runId, runId, iso(0));
    const insert = lone.prepare("INSERT INTO nodes (id, run_id, parent_node_id, tool, agent_type, label, started_at, ended_at, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)");
    insert.run(`toolu_${runId}`, runId, null, "Workflow", null, "implement-verify", iso(0), iso(0), 0);
    for (const letter of ["a", "b"]) insert.run(`wf:${runId}:${letter}`, runId, `toolu_${runId}`, "Agent", "impl-pressure-tester", letter, iso(0), iso(MINUTE_MS), MINUTE_MS);
  }
  assert.deepEqual(computeStats(lone).repeatedSequences, []);
});

test("projects count a Workflow's spend once, not again for its agents", () => {
  const spend = spendByProject(storeWithWorkflowRun(), "/nonexistent/picks.sqlite3");
  assert.equal(spend.unattributedTokens, 1_000_000);
  assert.equal(spend.unattributedNodes, 2);
});

test("stats keep a Workflow run's shape as a Workflow step and tally its agents apart", () => {
  const stats = computeStats(storeWithWorkflowRun());
  // Four agents ran over 15 minutes busy: the lead for 5, then three verifiers together for 10.
  assert.equal(stats.averageConcurrency, 35 / 15);
  assert.equal(stats.nodeCount, 2);
  assert.equal(stats.workflowAgentCount, 3);
  assert.equal(stats.parallelRunCount, 1);
  assert.equal(stats.totalTokens, 1_000_000);
  assert.deepEqual(stats.byWorkflowAgentType.map((bucket) => [bucket.key, bucket.count]), [["impl-pressure-tester", 3]]);
  assert.ok(!stats.byAgentType.some((bucket) => bucket.key === "impl-pressure-tester"));
});
