import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { computeTrend } from "../src/trend.mjs";

const MINUTE_MS = 60_000;

function addRun(store, { runId, startedAt, declaredShape = null, nodes }) {
  store
    .prepare("INSERT INTO runs (id, session_id, started_at, declared_shape) VALUES (?, ?, ?, ?)")
    .run(runId, runId, startedAt, declaredShape);
  const insert = store.prepare(
    `INSERT INTO nodes (id, run_id, tool, started_at, ended_at, status, duration_ms, true_duration_ms)
     VALUES (?, ?, 'Agent', ?, ?, 'ok', ?, ?)`,
  );
  nodes.forEach(([startOffsetMs, durationMs], index) => {
    const startMs = Date.parse(startedAt) + startOffsetMs;
    insert.run(`${runId}-n${index}`, runId, new Date(startMs).toISOString(), new Date(startMs + durationMs).toISOString(), durationMs, durationMs);
  });
}

test("each week reports how many multi-agent runs overlapped, and how much", () => {
  const store = openStore(":memory:");
  // Week one: a two-agent run that overlapped fully, declared up front.
  addRun(store, { runId: "fan", startedAt: "2026-09-15T10:00:00.000Z", declaredShape: "pipeline", nodes: [[0, 10 * MINUTE_MS], [0, 10 * MINUTE_MS]] });
  // Week two: a two-agent chain and a solo run.
  addRun(store, { runId: "chain", startedAt: "2026-09-22T10:00:00.000Z", nodes: [[0, 5 * MINUTE_MS], [6 * MINUTE_MS, 5 * MINUTE_MS]] });
  addRun(store, { runId: "solo", startedAt: "2026-09-23T10:00:00.000Z", nodes: [[0, MINUTE_MS]] });

  const [first, second] = computeTrend(store);
  assert.equal(first.week, "2026-W37");
  assert.deepEqual([first.multiAgentRuns, first.parallelRuns, first.declaredRuns], [1, 1, 1]);
  assert.equal(first.averageConcurrency, 2);
  assert.equal(second.week, "2026-W38");
  assert.deepEqual([second.runs, second.multiAgentRuns, second.parallelRuns], [2, 1, 0]);
  assert.equal(second.serializedMs, 5 * MINUTE_MS);
  assert.equal(second.averageConcurrency, 1);
});
