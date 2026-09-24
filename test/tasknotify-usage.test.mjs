import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskNotifications, parseUsage } from "../src/tasknotify.mjs";
import { recordTaskCompletion } from "../src/db.mjs";

const USAGE = "<usage><subagent_tokens>185862</subagent_tokens>"
  + "<tool_uses>29</tool_uses><duration_ms>433668</duration_ms></usage>";

function notificationEntry(text) {
  return { type: "user", timestamp: "2026-09-24T12:00:00Z", message: { content: text } };
}

function freshStore() {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  store
    .prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)")
    .run("run-1", "session-1", "2026-09-24T11:00:00Z");
  return store;
}

function addAsyncNode(store, { taskId, notifiedAt = null }) {
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, started_at, status, task_id, is_async, notified_at)
       VALUES (?, 'run-1', 'Agent', '2026-09-24T11:00:00Z', 'async_launched', ?, 1, ?)`,
    )
    .run(`node-${taskId}`, taskId, notifiedAt);
}

function nodeRow(store, taskId) {
  return store.prepare("SELECT * FROM nodes WHERE task_id = ?").get(taskId);
}

test("a notification's usage block is the only accounting a background agent produces", () => {
  assert.deepEqual(parseUsage(`<task-notification>${USAGE}</task-notification>`), {
    totalTokens: 185862,
    toolUseCount: 29,
    durationMs: 433668,
  });
});

test("a background command reports no usage and is not invented", () => {
  assert.equal(parseUsage("<task-notification><status>completed</status></task-notification>"), null);
  assert.equal(parseUsage("<usage></usage>"), null);
});

test("a batched notification cannot attribute usage to one task", () => {
  const [notification] = parseTaskNotifications([
    notificationEntry(
      `<task-notification><task-id>a</task-id><task-id>b</task-id>${USAGE}</task-notification>`,
    ),
  ]);
  assert.equal(notification.isBatched, true);
  assert.equal(notification.usage, null);
});

test("a single notification carries its usage through to the node", () => {
  const store = freshStore();
  addAsyncNode(store, { taskId: "t1" });
  const [notification] = parseTaskNotifications([
    notificationEntry(`<task-notification><task-id>t1</task-id>${USAGE}</task-notification>`),
  ]);
  recordTaskCompletion(store, { taskId: "t1", ...notification });

  const node = nodeRow(store, "t1");
  assert.equal(node.total_tokens, 185862);
  assert.equal(node.tool_use_count, 29);
  assert.equal(node.true_duration_ms, 433668);
});

test("a node reconciled before usage was read still gains its tokens", () => {
  const store = freshStore();
  addAsyncNode(store, { taskId: "t2", notifiedAt: "2026-09-24T12:00:00Z" });
  recordTaskCompletion(store, {
    taskId: "t2",
    notifiedAt: "2026-09-24T12:00:00Z",
    resultText: null,
    usage: { totalTokens: 500, toolUseCount: 2, durationMs: 1000 },
  });
  assert.equal(nodeRow(store, "t2").total_tokens, 500);
});

test("a notification without usage falls back to notify minus launch", () => {
  const store = freshStore();
  addAsyncNode(store, { taskId: "t3" });
  recordTaskCompletion(store, {
    taskId: "t3",
    notifiedAt: "2026-09-24T12:00:00Z",
    resultText: null,
    usage: null,
  });
  const node = nodeRow(store, "t3");
  assert.equal(node.total_tokens, null);
  // julianday arithmetic is float, so the hour lands a millisecond short
  assert.ok(Math.abs(node.true_duration_ms - 3600000) <= 1, node.true_duration_ms);
});

import { pruneSupersededHookNodes } from "../src/db.mjs";

function addNode(store, { id, promptSha, runId = "run-1" }) {
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, prompt_sha, started_at, status)
       VALUES (?, ?, 'Agent', ?, '2026-09-24T11:00:00Z', 'ok')`,
    )
    .run(id, runId, promptSha);
}

test("a hook node the importer has since recorded is dropped as a duplicate", () => {
  const store = freshStore();
  addNode(store, { id: "abc123-ffff", promptSha: "unused-by-the-hook" });
  addNode(store, { id: "toolu_01real", promptSha: "abc123" });

  assert.equal(pruneSupersededHookNodes(store), 1);
  const remaining = store.prepare("SELECT id FROM nodes").all().map((row) => row.id);
  assert.deepEqual(remaining, ["toolu_01real"]);
});

test("a hook node with no imported twin is kept", () => {
  const store = freshStore();
  addNode(store, { id: "orphan1-ffff", promptSha: "x" });
  assert.equal(pruneSupersededHookNodes(store), 0);
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM nodes").get().n, 1);
});

test("a twin in another run is not a twin", () => {
  const store = freshStore();
  store
    .prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)")
    .run("run-2", "session-2", "2026-09-24T11:00:00Z");
  addNode(store, { id: "abc123-ffff", promptSha: "x" });
  addNode(store, { id: "toolu_01other", promptSha: "abc123", runId: "run-2" });
  assert.equal(pruneSupersededHookNodes(store), 0);
});

test("a resumption pointing at the dropped node is repointed, not orphaned", () => {
  const store = freshStore();
  addNode(store, { id: "abc123-ffff", promptSha: "x" });
  addNode(store, { id: "toolu_01real", promptSha: "abc123" });
  store
    .prepare(
      `INSERT INTO resumptions (id, run_id, ts, target_ref, target_kind, sender, node_id)
       VALUES ('r1', 'run-1', '2026-09-24T12:00:00Z', 'agent', 'name', 'lead', 'abc123-ffff')`,
    )
    .run();

  pruneSupersededHookNodes(store);
  assert.equal(store.prepare("SELECT node_id FROM resumptions WHERE id='r1'").get().node_id, "toolu_01real");
});

test("a pair sharing a task id is deduped across runs, since a task id is unique", () => {
  const store = freshStore();
  store
    .prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)")
    .run("run-2", "session-2", "2026-09-24T11:00:00Z");
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, prompt_sha, task_id, started_at, status, total_tokens)
       VALUES ('aaaa-bbbb', 'run-1', 'Agent', 'hook-hash', 'task-9',
               '2026-09-24T11:00:00Z', 'ok', 97156)`,
    )
    .run();
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, prompt_sha, task_id, started_at, status, total_tokens)
       VALUES ('toolu_01x', 'run-2', 'Agent', 'other-hash', 'task-9',
               '2026-09-24T11:00:00Z', 'ok', 97156)`,
    )
    .run();

  assert.equal(pruneSupersededHookNodes(store), 1);
  assert.equal(store.prepare("SELECT SUM(total_tokens) AS t FROM nodes").get().t, 97156);
});
