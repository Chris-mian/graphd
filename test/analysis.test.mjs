import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dedupeNodes,
  delegationBatches,
  observedShape,
  parallelismReport,
  peakConcurrency,
  topologyDiff,
} from "../src/analysis.mjs";
import { parseTaskNotifications } from "../src/tasknotify.mjs";
import { completeNode, insertNode, upsertRun } from "../src/db.mjs";

const RUN_ID = "run-1";

function asyncNode(id, startedAt, notifiedAt = null, label = id) {
  return {
    id,
    run_id: RUN_ID,
    tool: "Agent",
    label,
    started_at: startedAt,
    ended_at: startedAt,
    notified_at: notifiedAt,
    is_async: 1,
    status: "async_launched",
  };
}

test("an async node with no notification never manufactures overlap", () => {
  const nodes = [
    asyncNode("a", "2026-09-21T09:00:00.000Z"),
    asyncNode("b", "2026-09-21T09:00:30.000Z"),
  ];
  assert.equal(peakConcurrency(nodes), 0);
  assert.equal(observedShape(nodes), "unknown");
  assert.equal(topologyDiff({ declaredShape: "fanout", nodes }).isMismatch, null);
  assert.equal(topologyDiff({ declaredShape: "fanout", nodes }).unmeasurableNodeCount, 2);
});

test("notified async nodes that overlap read as a fan-out", () => {
  const nodes = [
    asyncNode("a", "2026-09-21T09:00:00.000Z", "2026-09-21T09:09:00.000Z"),
    asyncNode("b", "2026-09-21T09:00:30.000Z", "2026-09-21T09:09:00.000Z"),
  ];
  assert.equal(peakConcurrency(nodes), 2);
  assert.equal(observedShape(nodes), "fanout");
  assert.equal(parallelismReport(nodes).verdict, "parallel");
});

test("an unmeasurable member does not split a batch", () => {
  const nodes = [
    asyncNode("a", "2026-09-21T09:00:00.000Z"),
    asyncNode("b", "2026-09-21T09:00:10.000Z"),
    asyncNode("c", "2026-09-21T09:00:20.000Z"),
  ];
  const batches = delegationBatches(nodes);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].size, 3);
  assert.equal(batches[0].isMeasured, false);
  assert.equal(parallelismReport(nodes).verdict, "attempted, end times unknown");
});

test("dedupe merges the hook row with the backfill row but keeps real retries apart", () => {
  const hookRow = { ...asyncNode("hash-1", "2026-09-21T09:00:00.100Z", null, "PR C"), is_async: 0 };
  const backfillRow = asyncNode("toolu_1", "2026-09-21T09:00:00.000Z", "2026-09-21T09:06:00.000Z", "PR C");
  const retryRow = asyncNode("toolu_2", "2026-09-21T09:20:00.000Z", "2026-09-21T09:26:00.000Z", "PR C");

  const merged = dedupeNodes([hookRow, backfillRow, retryRow]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].notified_at, "2026-09-21T09:06:00.000Z");
  assert.equal(merged[0].is_async, 1);
});

test("notifications are read from queue-operation and attachment entries, not just user", () => {
  const notification = (id) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<result>done</result>`;
  const entries = [
    { type: "user", timestamp: "2026-09-21T09:01:00.000Z", message: { content: notification("t-user") } },
    { type: "queue-operation", timestamp: "2026-09-21T09:02:00.000Z", content: notification("t-queue") },
    { type: "attachment", timestamp: "2026-09-21T09:03:00.000Z", attachment: { prompt: notification("t-attach") } },
  ];
  const found = parseTaskNotifications(entries).flatMap((entry) => entry.taskIds);
  assert.deepEqual(found, ["t-user", "t-queue", "t-attach"]);
});

test("a batched notification claims every task id but attributes no result text", () => {
  const text =
    "<task-notification>\n<task-id>t-1</task-id>\n<task-id>t-2</task-id>\n<result>ambiguous</result>";
  const [notification] = parseTaskNotifications([
    { type: "queue-operation", timestamp: "2026-09-21T09:04:00.000Z", content: text },
  ]);
  assert.deepEqual(notification.taskIds, ["t-1", "t-2"]);
  assert.equal(notification.resultText, null);
  assert.equal(notification.isBatched, true);
});

test("completeNode records true_duration_ms for a synchronous agent", () => {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  upsertRun(store, { runId: RUN_ID, sessionId: RUN_ID });
  insertNode(store, { id: "n1", runId: RUN_ID, tool: "Agent", label: "sync" });

  completeNode(store, { nodeId: "n1", status: "ok", result: { durationMs: 5000, isAsync: false } });
  const row = store.prepare("SELECT duration_ms, true_duration_ms FROM nodes WHERE id = 'n1'").get();
  assert.equal(row.duration_ms, 5000);
  assert.equal(row.true_duration_ms, 5000);
});

test("a hook row with an empty label still collapses into its transcript twin", () => {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  upsertRun(store, { runId: RUN_ID, sessionId: RUN_ID });
  const startedAt = "2026-09-25T10:00:00.000Z";
  insertNode(store, { id: "0123456789abcdef-x", runId: RUN_ID, tool: "Workflow", agentType: "", label: "", startedAt });
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, label, started_at, status)
       VALUES ('toolu_twin', ?, 'Workflow', NULL, ?, 'ok')`,
    )
    .run(RUN_ID, startedAt);
  const rows = store.prepare("SELECT * FROM nodes").all();
  assert.equal(rows.find((row) => row.id === "0123456789abcdef-x").label, null);
  assert.equal(dedupeNodes(rows).length, 1);
});

test("an agent a Workflow ran never collapses into a same-labelled backfill row", () => {
  const startedAt = "2026-09-25T10:00:00.000Z";
  const backfillRow = { id: "toolu_lead", run_id: RUN_ID, tool: "Agent", label: "verify", started_at: startedAt };
  const workflowChild = { ...backfillRow, id: "wf:wf_run:a1", parent_node_id: "toolu_workflow" };
  assert.equal(dedupeNodes([backfillRow, workflowChild]).length, 2);
});

test("dedupe keeps the backfill row's billed usage when the earlier hook row has none", () => {
  const hookRow = { ...asyncNode("hash-1", "2026-09-21T08:59:59.900Z", null, "PR C"), is_async: 0 };
  const backfillRow = {
    ...asyncNode("toolu_1", "2026-09-21T09:00:00.000Z", "2026-09-21T09:06:00.000Z", "PR C"),
    billed_usage: '{"claude-opus-5-5":{}}',
    billed_share: 0.5,
  };
  const [merged] = dedupeNodes([{ ...hookRow, billed_usage: null, billed_share: null }, backfillRow]);
  assert.equal(merged.id, "hash-1", "the earlier row is the one kept");
  assert.equal(merged.billed_usage, '{"claude-opus-5-5":{}}');
  assert.equal(merged.billed_share, 0.5);
});
