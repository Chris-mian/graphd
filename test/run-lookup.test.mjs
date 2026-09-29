import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { AMBIGUOUS_RUN_ID, getRun } from "../src/routes.mjs";

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

test("a run is found by the 8-character prefix graph runs prints", () => {
  const store = storeWithRuns(["3a7e22d4-6910-42f0-954b-e21516fabf28", "aa6e0da5-0000-0000-0000-000000000000"]);
  assert.equal(getRun(store, "3a7e22d4").run.id, "3a7e22d4-6910-42f0-954b-e21516fabf28");
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
