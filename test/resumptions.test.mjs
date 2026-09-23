import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyTargetRef,
  insertNode,
  insertResumption,
  resumptionsForRun,
  upsertRun,
} from "../src/db.mjs";

const RUN_ID = "run-resume";
const AGENT_ID = "a1d45572fd0d599";
const AGENT_NAME = "ws5-monitors";

function freshStore() {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  upsertRun(store, { runId: RUN_ID, sessionId: RUN_ID });
  return store;
}

test("an id-addressed message resolves to the node carrying that agent_id", () => {
  const store = freshStore();
  insertNode(store, { id: "n1", runId: RUN_ID, tool: "Agent", label: "verifier" });
  store.prepare("UPDATE nodes SET agent_id = ? WHERE id = 'n1'").run(AGENT_ID);

  insertResumption(store, {
    id: "toolu_send_1",
    runId: RUN_ID,
    ts: "2026-09-23T10:00:00.000Z",
    targetRef: AGENT_ID,
    targetKind: "agent_id",
    sender: "lead",
  });
  const [row] = resumptionsForRun(store, RUN_ID);
  assert.equal(row.node_id, "n1");
  assert.equal(row.target_kind, "agent_id");
});

test("a name-addressed message resolves through nodes.name", () => {
  const store = freshStore();
  insertNode(store, {
    id: "n2",
    runId: RUN_ID,
    tool: "Agent",
    label: "Watch the monitors",
    name: AGENT_NAME,
  });

  insertResumption(store, {
    id: "toolu_send_2",
    runId: RUN_ID,
    ts: "2026-09-23T10:01:00.000Z",
    targetRef: AGENT_NAME,
    targetKind: "name",
    sender: "lead",
  });
  const [row] = resumptionsForRun(store, RUN_ID);
  assert.equal(row.node_id, "n2");
  assert.equal(row.target_kind, "name");
});

test("name survives a spawn that also supplied a description", () => {
  const store = freshStore();
  insertNode(store, {
    id: "n3",
    runId: RUN_ID,
    tool: "Agent",
    label: "Watch the monitors",
    name: AGENT_NAME,
  });
  const row = store.prepare("SELECT label, name FROM nodes WHERE id = 'n3'").get();
  assert.equal(row.label, "Watch the monitors");
  assert.equal(row.name, AGENT_NAME);
});

test("an agent messaging a peer is recorded with sender 'agent'", () => {
  const store = freshStore();
  insertResumption(store, {
    id: "toolu_send_3",
    runId: RUN_ID,
    ts: "2026-09-23T10:02:00.000Z",
    targetRef: AGENT_ID,
    targetKind: "agent_id",
    sender: "agent",
    senderRef: "a223b556f280ca2b3",
  });
  const [row] = resumptionsForRun(store, RUN_ID);
  assert.equal(row.sender, "agent");
  assert.equal(row.sender_ref, "a223b556f280ca2b3");
});

test("an unresolvable target is still recorded, with a null node", () => {
  const store = freshStore();
  insertResumption(store, {
    id: "toolu_send_4",
    runId: RUN_ID,
    ts: "2026-09-23T10:03:00.000Z",
    targetRef: "nobody-here",
    targetKind: "name",
    sender: "lead",
  });
  const [row] = resumptionsForRun(store, RUN_ID);
  assert.equal(row.node_id, null);
});

test("the same message is not counted twice", () => {
  const store = freshStore();
  const resumption = {
    id: "toolu_send_5",
    runId: RUN_ID,
    ts: "2026-09-23T10:04:00.000Z",
    targetRef: AGENT_ID,
    targetKind: "agent_id",
    sender: "lead",
  };
  assert.equal(insertResumption(store, resumption), 1);
  assert.equal(insertResumption(store, resumption), 0);
  assert.equal(resumptionsForRun(store, RUN_ID).length, 1);
});

test("target refs are classified by shape", () => {
  assert.equal(classifyTargetRef("a1d45572fd0d59916"), "agent_id");
  assert.equal(classifyTargetRef("team-lead"), "name");
  assert.equal(classifyTargetRef(""), "unknown");
  assert.equal(classifyTargetRef(null), "unknown");
});
