import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTypeLabel, agentTypeShapeKey } from "../src/analysis.mjs";
import { openStore } from "../src/db.mjs";
import { computeStats } from "../src/stats.mjs";

const SIXTY_EIGHT_HOURS_MS = 68 * 3_600_000;

function addNode(store, { id, runId, tool = "Agent", agentType = null, label = null, durationMs = 1000, startedAt }) {
  store
    .prepare("INSERT OR IGNORE INTO runs (id, session_id, started_at) VALUES (?, ?, ?)")
    .run(runId, runId, startedAt);
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, agent_type, label, started_at, status, duration_ms,
         true_duration_ms, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, 1000)`,
    )
    .run(id, runId, tool, agentType, label, startedAt, durationMs, durationMs);
}

test("an Agent spawn with no subagent_type is labelled as the defaulted general-purpose agent", () => {
  assert.equal(agentTypeLabel({ tool: "Agent", agent_type: null }), "general-purpose (default)");
  // The hook records a missing type as "" rather than null.
  assert.equal(agentTypeLabel({ tool: "Agent", agent_type: "" }), "general-purpose (default)");
  assert.equal(agentTypeLabel({ tool: "Agent", agent_type: "Explore" }), "Explore");
});

test("a Workflow is labelled by its script name, and by a placeholder when it has none", () => {
  assert.equal(
    agentTypeLabel({ tool: "Workflow", agent_type: "", label: "implement-verify" }),
    "Workflow:implement-verify",
  );
  assert.equal(agentTypeLabel({ tool: "Workflow", agent_type: null, label: null }), "Workflow (unnamed)");
});

test("the shape key treats a defaulted type as general-purpose and every Workflow as one kind", () => {
  assert.equal(agentTypeShapeKey({ tool: "Agent", agent_type: "" }), "general-purpose");
  assert.equal(agentTypeShapeKey({ tool: "Agent", agent_type: "general-purpose" }), "general-purpose");
  assert.equal(agentTypeShapeKey({ tool: "Workflow", agent_type: null, label: "x" }), "Workflow");
});

test("stats report no unknown bucket, and no minutes for a Workflow container", () => {
  const store = openStore(":memory:");
  addNode(store, { id: "a", runId: "r1", startedAt: "2026-09-24T11:00:00Z" });
  addNode(store, {
    id: "w",
    runId: "r1",
    tool: "Workflow",
    agentType: "",
    label: "implement-verify",
    durationMs: SIXTY_EIGHT_HOURS_MS,
    startedAt: "2026-09-24T11:05:00Z",
  });
  addNode(store, {
    id: "g",
    runId: "r2",
    agentType: "general-purpose",
    startedAt: "2026-09-24T12:00:00Z",
  });
  addNode(store, { id: "h", runId: "r2", startedAt: "2026-09-24T12:10:00Z" });

  const buckets = Object.fromEntries(computeStats(store).byAgentType.map((bucket) => [bucket.key, bucket]));
  assert.equal(buckets.unknown, undefined);
  assert.equal(buckets["general-purpose (default)"].count, 2);
  assert.equal(buckets["general-purpose (default)"].durationMs, 2000);
  assert.equal(buckets["Workflow:implement-verify"].durationMs, null);

  // Explicit and defaulted general-purpose are one agent in a run's shape, not two.
  const stats = computeStats(store);
  assert.ok(stats.repeatedSequences.every((bucket) => !bucket.shape.includes("(default)")));
});
