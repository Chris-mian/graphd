import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { activeSegments, MAX_ACTIVE_GAP_MS, readWorkflowChildren, unionMs } from "../src/workflowchildren.mjs";

const IMPORTER_PATH = join(import.meta.dirname, "..", "bin", "graph-import.mjs");
const SESSION_ID = "22222222-3333-4444-5555-666666666666";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const START_MS = Date.parse("2026-09-25T10:00:00.000Z");

const iso = (offsetMs) => new Date(START_MS + offsetMs).toISOString();

test("a pause longer than the gap limit splits work into two spans", () => {
  const segments = activeSegments([0, MINUTE_MS, 2 * MINUTE_MS, 2 * MINUTE_MS + DAY_MS, 3 * MINUTE_MS + DAY_MS]);
  assert.deepEqual(segments, [
    [0, 2 * MINUTE_MS],
    [2 * MINUTE_MS + DAY_MS, 3 * MINUTE_MS + DAY_MS],
  ]);
  assert.equal(unionMs(segments), 3 * MINUTE_MS);
});

test("timestamps out of order are sorted before spans are built", () => {
  assert.deepEqual(activeSegments([2 * MINUTE_MS, 0, MINUTE_MS]), [[0, 2 * MINUTE_MS]]);
});

test("overlapping spans from two agents are counted once", () => {
  assert.equal(unionMs([[0, 10], [5, 20], [30, 40]]), 30);
  assert.ok(MAX_ACTIVE_GAP_MS >= MINUTE_MS);
});

/** A workflow transcript dir with two finished agents and one still running. */
function workflowDir(root) {
  const dir = join(root, "wf_test-run");
  mkdirSync(dir, { recursive: true });
  const agents = [
    { id: "a1", meta: { agentType: "impl-pressure-tester", description: "verify:U1:correctness", model: "opus" }, at: [MINUTE_MS, 3 * MINUTE_MS] },
    { id: "a2", meta: { agentType: "impl-pressure-tester", description: "verify:U1:repro" }, at: [2 * MINUTE_MS, 4 * MINUTE_MS] },
    // The merge agent was suspended for a day mid-run.
    { id: "a3", meta: { agentType: "general-purpose", description: "merge" }, at: [5 * MINUTE_MS, 6 * MINUTE_MS, 6 * MINUTE_MS + DAY_MS] },
  ];
  for (const agent of agents) {
    writeFileSync(join(dir, `agent-${agent.id}.meta.json`), JSON.stringify(agent.meta));
    writeFileSync(join(dir, `agent-${agent.id}.jsonl`), agent.at.map((offset) => JSON.stringify({ timestamp: iso(offset) })).join("\n"));
  }
  writeFileSync(
    join(dir, "journal.jsonl"),
    [{ type: "result", agentId: "a1" }, { type: "result", agentId: "a2" }].map((entry) => JSON.stringify(entry)).join("\n"),
  );
  return dir;
}

test("each agent in a workflow directory is read with its type, timing and finish state", () => {
  const children = readWorkflowChildren(workflowDir(mkdtempSync(join(tmpdir(), "graphd-wf-"))));
  const byId = Object.fromEntries(children.map((child) => [child.agentId, child]));
  assert.equal(byId.a1.agentType, "impl-pressure-tester");
  assert.equal(byId.a1.model, "opus");
  assert.equal(byId.a2.model, null);
  assert.equal(byId.a1.activeMs, 2 * MINUTE_MS);
  assert.equal(byId.a3.activeMs, MINUTE_MS);
  assert.equal(byId.a3.isFinished, false);
  assert.equal(byId.a1.isFinished, true);
});

test("a missing workflow directory yields no children", () => {
  assert.deepEqual(readWorkflowChildren(join(tmpdir(), "graphd-no-such-wf")), []);
});

test("the importer records a workflow's agents under it and gives it their active time", () => {
  const home = mkdtempSync(join(tmpdir(), "graphd-wf-import-"));
  const stateDir = join(home, "state");
  const projectDir = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateDir);
  const transcriptDir = workflowDir(join(projectDir, SESSION_ID, "subagents", "workflows"));
  const shared = { sessionId: SESSION_ID, cwd: "/work/repo" };
  const entries = [
    { ...shared, type: "assistant", timestamp: iso(0), message: { content: [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { description: "implement-verify" } }] } },
    {
      ...shared,
      type: "user",
      timestamp: iso(500),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf" }] },
      toolUseResult: { status: "async_launched", runId: "wf_test-run", transcriptDir },
    },
  ];
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));

  for (let pass = 0; pass < 2; pass += 1) {
    const imported = spawnSync(process.execPath, [IMPORTER_PATH], {
      env: { ...process.env, HOME: home, GRAPHD_STATE_DIR: stateDir },
      encoding: "utf8",
    });
    assert.equal(imported.status, 0, imported.stderr);
  }

  const reader = new DatabaseSync(join(stateDir, "graph.db"), { readOnly: true });
  const children = reader.prepare("SELECT * FROM nodes WHERE parent_node_id = 'toolu_wf' ORDER BY id").all();
  const parent = reader.prepare("SELECT * FROM nodes WHERE id = 'toolu_wf'").get();
  reader.close();

  assert.deepEqual(children.map((child) => child.id), ["wf:wf_test-run:a1", "wf:wf_test-run:a2", "wf:wf_test-run:a3"]);
  assert.deepEqual(children.map((child) => child.status), ["ok", "ok", "running"]);
  assert.ok(children.every((child) => child.total_tokens === null));
  // a1 and a2 overlap across minutes 1-4, a3 adds minute 5-6; the suspended day is not counted.
  assert.equal(parent.true_duration_ms, 4 * MINUTE_MS);
});
