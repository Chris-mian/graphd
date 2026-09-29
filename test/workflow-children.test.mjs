import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { activeSegments, MAX_ACTIVE_GAP_MS, MAX_TOOL_CALL_MS, readWorkflowChildren, unionMs } from "../src/workflowchildren.mjs";

const IMPORTER_PATH = join(import.meta.dirname, "..", "bin", "graph-import.mjs");
const SESSION_ID = "22222222-3333-4444-5555-666666666666";
const FORK_SESSION_ID = "99999999-3333-4444-5555-666666666666";
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

test("a long gap while a tool call is in flight is work, unless it outlasts any tool call", () => {
  const waiting = { at: 0, toolInFlight: true };
  const answered = { at: 10 * MINUTE_MS, toolInFlight: false };
  assert.deepEqual(activeSegments([waiting, answered]), [[0, 10 * MINUTE_MS]]);
  const resumedDaysLater = { at: MAX_TOOL_CALL_MS + MINUTE_MS, toolInFlight: false };
  assert.equal(activeSegments([waiting, resumedDaysLater]).length, 2);
  assert.equal(activeSegments([{ at: 0, toolInFlight: false }, answered]).length, 2);
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

/** A home dir whose lead transcript launched the fixture Workflow, optionally with its notification. */
function homeWithWorkflow({ notified = false, forked = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "graphd-wf-import-"));
  const stateDir = join(home, "state");
  const projectDir = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateDir);
  const transcriptDir = workflowDir(join(projectDir, SESSION_ID, "subagents", "workflows"));
  const entriesFor = (sessionId) => {
    const shared = { sessionId, cwd: "/work/repo" };
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
    if (notified) {
      // The lead saw the result a day later: the runtime's duration counts the whole wait.
      const usage = `<usage><subagent_tokens>1234</subagent_tokens><duration_ms>${DAY_MS + 7 * MINUTE_MS}</duration_ms></usage>`;
      entries.push({
        ...shared,
        type: "user",
        timestamp: iso(DAY_MS + 7 * MINUTE_MS),
        message: { content: `<task-notification>\n<task-id>wtask</task-id>\n<tool-use-id>toolu_wf</tool-use-id>\n<status>completed</status>\n${usage}` },
      });
    }
    return entries.map((entry) => JSON.stringify(entry)).join("\n");
  };
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), entriesFor(SESSION_ID));
  if (forked) writeFileSync(join(projectDir, `${FORK_SESSION_ID}.jsonl`), entriesFor(FORK_SESSION_ID));
  return { home, stateDir, transcriptDir };
}

function runImporter({ home, stateDir }) {
  const imported = spawnSync(process.execPath, [IMPORTER_PATH], {
    env: { ...process.env, HOME: home, GRAPHD_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
}

function readNodes({ stateDir }) {
  const reader = new DatabaseSync(join(stateDir, "graph.db"), { readOnly: true });
  const children = reader.prepare("SELECT * FROM nodes WHERE parent_node_id = 'toolu_wf' ORDER BY id").all();
  const parent = reader.prepare("SELECT * FROM nodes WHERE id = 'toolu_wf'").get();
  reader.close();
  return { children, parent, byAgent: Object.fromEntries(children.map((child) => [child.agent_id, child])) };
}

test("the importer records a workflow's agents under it and gives it their active time", () => {
  const fixture = homeWithWorkflow();
  runImporter(fixture);
  runImporter(fixture);
  const { children, parent, byAgent } = readNodes(fixture);

  assert.deepEqual(children.map((child) => child.id), ["wf:wf_test-run:a1", "wf:wf_test-run:a2", "wf:wf_test-run:a3"]);
  assert.deepEqual(children.map((child) => child.status), ["ok", "ok", "running"]);
  assert.ok(children.every((child) => child.total_tokens === null));
  // a1 and a2 overlap across minutes 1-4, a3 adds minute 5-6; the suspended day is not counted.
  assert.equal(parent.true_duration_ms, 4 * MINUTE_MS);
  // A suspended agent ends at its last entry; only its active time leaves the suspension out.
  assert.equal(byAgent.a3.ended_at, iso(6 * MINUTE_MS + DAY_MS));
  assert.equal(byAgent.a3.duration_ms, DAY_MS + MINUTE_MS);
  assert.equal(byAgent.a3.true_duration_ms, MINUTE_MS);
});

test("a notification seen in the same import does not replace the workflow's active time", () => {
  const fixture = homeWithWorkflow({ notified: true });
  runImporter(fixture);
  const { parent } = readNodes(fixture);
  assert.equal(parent.true_duration_ms, 4 * MINUTE_MS);
  assert.equal(parent.total_tokens, 1234);
});

test("a later import moves an agent that has since finished", () => {
  const fixture = homeWithWorkflow();
  runImporter(fixture);
  appendFileSync(join(fixture.transcriptDir, "agent-a3.jsonl"), "\n" + JSON.stringify({ timestamp: iso(8 * MINUTE_MS + DAY_MS) }));
  appendFileSync(join(fixture.transcriptDir, "journal.jsonl"), "\n" + JSON.stringify({ type: "result", agentId: "a3" }));
  runImporter(fixture);
  const { parent, byAgent } = readNodes(fixture);
  assert.equal(byAgent.a3.status, "ok");
  assert.equal(byAgent.a3.ended_at, iso(8 * MINUTE_MS + DAY_MS));
  // Its work after the suspension, minute 6 to 8 of the next day, now counts too.
  assert.equal(byAgent.a3.true_duration_ms, 3 * MINUTE_MS);
  assert.equal(parent.true_duration_ms, 6 * MINUTE_MS);
});

test("a forked session repeating the workflow leaves its agents in the parent's run", () => {
  const fixture = homeWithWorkflow({ forked: true });
  runImporter(fixture);
  const { children, parent } = readNodes(fixture);
  assert.equal(children.length, 3);
  assert.ok(children.every((child) => child.run_id === parent.run_id));
});
