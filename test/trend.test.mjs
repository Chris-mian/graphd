import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { estimateCost } from "../src/pricing.mjs";
import { routeGet } from "../src/server.mjs";
import { computeTrend } from "../src/trend.mjs";

const MINUTE_MS = 60_000;

const TOKENS_PER_NODE = 10_000;
const MODEL = "claude-opus-5";

function addRun(store, { runId, startedAt, declaredShape = null, nodes }) {
  store
    .prepare("INSERT INTO runs (id, session_id, started_at, declared_shape) VALUES (?, ?, ?, ?)")
    .run(runId, runId, startedAt, declaredShape);
  const insert = store.prepare(
    `INSERT INTO nodes (id, run_id, tool, started_at, ended_at, status, duration_ms, true_duration_ms, total_tokens, model)
     VALUES (?, ?, 'Agent', ?, ?, 'ok', ?, ?, ?, ?)`,
  );
  nodes.forEach(([startOffsetMs, durationMs], index) => {
    const startMs = Date.parse(startedAt) + startOffsetMs;
    insert.run(`${runId}-n${index}`, runId, new Date(startMs).toISOString(), new Date(startMs + durationMs).toISOString(), durationMs, durationMs, TOKENS_PER_NODE, MODEL);
  });
}

test("each week reports how many multi-agent runs overlapped, and how much", () => {
  const store = openStore(":memory:");
  // Week one: a two-agent run that overlapped fully, declared up front.
  addRun(store, { runId: "fan", startedAt: "2026-09-15T10:00:00.000Z", declaredShape: "pipeline", nodes: [[0, 10 * MINUTE_MS], [0, 10 * MINUTE_MS]] });
  // Week two: a two-agent chain and a solo run.
  addRun(store, { runId: "chain", startedAt: "2026-09-22T10:00:00.000Z", nodes: [[0, 5 * MINUTE_MS], [6 * MINUTE_MS, 5 * MINUTE_MS]] });
  // A declared solo run is not a multi-agent run, so it adds nothing to declared or serialized.
  addRun(store, { runId: "solo", startedAt: "2026-09-23T10:00:00.000Z", declaredShape: "chain", nodes: [[0, MINUTE_MS]] });

  const [first, second] = computeTrend(store);
  assert.equal(first.week, "2026-W37");
  assert.deepEqual([first.multiAgentRuns, first.parallelRuns, first.declaredRuns], [1, 1, 1]);
  assert.equal(first.averageConcurrency, 2);
  assert.equal(second.week, "2026-W38");
  assert.deepEqual([second.runs, second.multiAgentRuns, second.parallelRuns, second.declaredRuns], [2, 1, 0, 0]);
  const nodeCost = estimateCost({ totalTokens: TOKENS_PER_NODE, model: MODEL }).estimate;
  assert.ok(nodeCost > 0);
  assert.ok(Math.abs(second.costUsd - 3 * nodeCost) < 1e-9);
  assert.equal(second.serializedMs, 5 * MINUTE_MS);
  assert.equal(second.averageConcurrency, 1);
});

test("a week's concurrency weights every multi-agent run by its time and leaves solo runs out", () => {
  const store = openStore(":memory:");
  const start = Date.parse("2026-09-15T10:00:00.000Z");
  const at = (offsetMinutes) => new Date(start + offsetMinutes * MINUTE_MS).toISOString();
  addRun(store, { runId: "overlap", startedAt: at(0), nodes: [[0, 10 * MINUTE_MS], [0, 10 * MINUTE_MS]] });
  addRun(store, { runId: "chain", startedAt: at(100), nodes: [[0, 15 * MINUTE_MS], [15 * MINUTE_MS, 15 * MINUTE_MS]] });
  addRun(store, { runId: "solo", startedAt: at(200), nodes: [[0, 60 * MINUTE_MS]] });
  // 50 agent-minutes over 40 busy minutes; an unweighted mean would read 1.5, counting solo 1.1.
  assert.equal(computeTrend(store)[0].averageConcurrency, 50 / 40);
});

test("human interventions per session join on the same week keys, and a week with only sessions is listed", () => {
  const store = openStore(":memory:");
  addRun(store, { runId: "late-sunday", startedAt: "2026-09-20T23:59:59.000Z", nodes: [[0, MINUTE_MS]] });
  const addSession = store.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)");
  addSession.run("s1", "2026-09-21T00:00:00.000Z");
  addSession.run("s2", "2026-09-22T09:00:00.000Z");
  const addIntervention = store.prepare("INSERT INTO interventions (id, run_id, ts, kind, quote) VALUES (?, 's1', ?, ?, 'q')");
  addIntervention.run("i1", "2026-09-21T10:00:00.000Z", "interrupt");
  addIntervention.run("i2", "2026-09-21T11:00:00.000Z", "correction");
  addIntervention.run("i3", "2026-09-21T12:00:00.000Z", "self_correction");

  const byWeek = Object.fromEntries(computeTrend(store).map((week) => [week.week, week]));
  assert.deepEqual(Object.keys(byWeek), ["2026-W37", "2026-W38"]);
  assert.equal(byWeek["2026-W37"].humanInterventionsPerSession, null);
  // Two sessions and two human interventions; the self-correction is not the human's.
  assert.equal(byWeek["2026-W38"].runs, 0);
  assert.equal(byWeek["2026-W38"].humanInterventionsPerSession, 1);
});

test("the daemon serves the trend as weeks", () => {
  const store = openStore(":memory:");
  addRun(store, { runId: "fan", startedAt: "2026-09-15T10:00:00.000Z", nodes: [[0, MINUTE_MS], [0, MINUTE_MS]] });
  const response = routeGet(store, {}, new URL("http://127.0.0.1/v1/trend"));
  assert.deepEqual(Object.keys(response), ["weeks"]);
  assert.equal(response.weeks[0].parallelRuns, 1);
});
