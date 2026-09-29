import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { AMBIGUOUS_RUN_ID, describeRunLookupFailure, getRun } from "../src/routes.mjs";
import { statusForResult } from "../src/server.mjs";

function storeWithRuns(runIds) {
  const store = openStore(":memory:");
  const insert = store.prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)");
  runIds.forEach((runId, index) => insert.run(runId, runId, `2026-09-2${index}T00:00:00Z`));
  return store;
}

test("a run is found by its full id", () => {
  const store = storeWithRuns(["3a7e22d4-6910-42f0-954b-e21516fabf28"]);
  assert.equal(getRun(store, "3a7e22d4-6910-42f0-954b-e21516fabf28").run.id, "3a7e22d4-6910-42f0-954b-e21516fabf28");
});

test("a run found by the 8-character prefix graph runs prints carries its full detail", () => {
  const fullId = "3a7e22d4-6910-42f0-954b-e21516fabf28";
  const store = storeWithRuns([fullId, "aa6e0da5-0000-0000-0000-000000000000"]);
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, started_at, status)
       VALUES ('toolu_one', ?, 'Agent', '2026-09-20T00:00:01Z', 'ok')`,
    )
    .run(fullId);
  const detail = getRun(store, "3a7e22d4");
  assert.equal(detail.run.id, fullId);
  assert.deepEqual(detail.nodes.map((node) => node.run_id), [fullId]);
});

test("a prefix shared by several runs reports every match instead of picking one", () => {
  const store = storeWithRuns(["3a7e22d4-aaaa", "3a7e22d4-bbbb"]);
  const result = getRun(store, "3a7e22d4");
  assert.equal(result.error, AMBIGUOUS_RUN_ID);
  assert.deepEqual([...result.matches].sort(), ["3a7e22d4-aaaa", "3a7e22d4-bbbb"]);
});

test("a prefix shorter than the printed one, or empty, matches nothing", () => {
  const store = storeWithRuns(["3a7e22d4-6910-42f0-954b-e21516fabf28"]);
  assert.equal(getRun(store, "3a7e22"), null);
  assert.equal(getRun(store, ""), null);
});

test("prefix matching is literal: SQL wildcards in the argument match nothing", () => {
  const store = storeWithRuns(["3a7e22d4-6910-42f0-954b-e21516fabf28"]);
  assert.equal(getRun(store, "3a7e22%_"), null);
});

test("the daemon answers 404 for no run, 409 for an ambiguous prefix, 200 otherwise", () => {
  assert.equal(statusForResult(null), 404);
  assert.equal(statusForResult({ error: AMBIGUOUS_RUN_ID, matches: ["a", "b"] }), 409);
  assert.equal(statusForResult({ run: {} }), 200);
});

test("graph show describes a missing or ambiguous run in words", () => {
  assert.equal(describeRunLookupFailure('404 {"error":"not found"}', "3a7e22d4"), "no run matches 3a7e22d4");
  assert.equal(
    describeRunLookupFailure(`409 ${JSON.stringify({ error: AMBIGUOUS_RUN_ID, matches: ["3a7e22d4-a", "3a7e22d4-b"] })}`, "3a7e22d4"),
    "3a7e22d4 matches 2 runs: 3a7e22d4-a, 3a7e22d4-b",
  );
  assert.equal(describeRunLookupFailure("500 boom", "3a7e22d4"), null);
});
