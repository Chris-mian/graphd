import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const IMPORTER_PATH = join(import.meta.dirname, "..", "bin", "graph-import.mjs");
const SESSION_ID = "aaaaaaaa-2222-3333-4444-555555555555";
const SHARED = { sessionId: SESSION_ID, cwd: "/work/repo" };
const TURN_USAGE = { input_tokens: 10, cache_read_input_tokens: 1_000, output_tokens: 100 };
const DENY_TEXT = "Error: PreToolUse:Agent hook error: graphd: 2 agents spawned with no declared topology.";

function at(second) {
  return `2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`;
}

function spawnEntries({ toolUseId, input, result, second }) {
  return [
    {
      ...SHARED,
      type: "assistant",
      timestamp: at(second),
      message: { id: `lead-${toolUseId}`, content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }] },
    },
    {
      ...SHARED,
      type: "user",
      timestamp: at(second + 1),
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      toolUseResult: result,
    },
  ];
}

function agentTurn({ messageId, second }) {
  return {
    ...SHARED,
    isSidechain: true,
    type: "assistant",
    timestamp: at(second),
    message: { id: messageId, model: "claude-opus-5-5", usage: TURN_USAGE, content: [] },
  };
}

function writeJsonLines(path, entries) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/** A HOME with a lead transcript spawning a sync agent, a fork, a teammate and a denied agent. */
function billingFixture() {
  const home = mkdtempSync(join(tmpdir(), "graphd-billing-"));
  const stateDir = join(home, "state");
  const projectDir = join(home, ".claude", "projects", "-work-repo");
  const subagentDir = join(projectDir, SESSION_ID, "subagents");
  mkdirSync(subagentDir, { recursive: true });
  mkdirSync(stateDir);

  writeJsonLines(join(projectDir, `${SESSION_ID}.jsonl`), [
    ...spawnEntries({
      toolUseId: "toolu_sync",
      input: { description: "sync", prompt: "a", subagent_type: "general-purpose" },
      result: { status: "completed", totalTokens: 1_110, agentId: "sync1" },
      second: 0,
    }),
    ...spawnEntries({
      toolUseId: "toolu_fork",
      input: { description: "fork", prompt: "b" },
      result: { status: "completed", totalTokens: 1_110, agentId: "fork1" },
      second: 10,
    }),
    ...spawnEntries({
      toolUseId: "toolu_mate",
      input: { description: "mate", prompt: "c", name: "helper", team_name: "t" },
      result: { status: "teammate_spawned", name: "helper", model: "claude-opus-5-5" },
      second: 20,
    }),
    ...spawnEntries({
      toolUseId: "toolu_denied",
      input: { description: "denied", prompt: "d" },
      result: DENY_TEXT,
      second: 30,
    }),
  ]);

  writeFileSync(join(subagentDir, "agent-sync1.meta.json"), JSON.stringify({ toolUseId: "toolu_sync" }));
  writeJsonLines(join(subagentDir, "agent-sync1.jsonl"), [
    agentTurn({ messageId: "sync-1", second: 2 }),
    agentTurn({ messageId: "sync-2", second: 3 }),
  ]);
  writeFileSync(join(subagentDir, "agent-fork1.meta.json"), JSON.stringify({ toolUseId: "toolu_fork", isFork: true }));
  writeJsonLines(join(subagentDir, "agent-fork1.jsonl"), [
    { ...agentTurn({ messageId: "lead-toolu_fork", second: 10 }), isSidechain: true },
    agentTurn({ messageId: "fork-own", second: 12 }),
  ]);
  writeFileSync(join(subagentDir, "agent-ahelper-1.meta.json"), JSON.stringify({ name: "helper", teamName: "t" }));
  writeJsonLines(join(subagentDir, "agent-ahelper-1.jsonl"), [agentTurn({ messageId: "mate-1", second: 22 })]);

  // The lead's own turn that spawned the fork carries usage too, so the fork's copy must be excluded.
  const leadPath = join(projectDir, `${SESSION_ID}.jsonl`);
  const leadTurn = {
    ...SHARED,
    type: "assistant",
    timestamp: at(10),
    message: { id: "lead-toolu_fork", model: "claude-opus-5-5", usage: TURN_USAGE, content: [] },
  };
  writeFileSync(leadPath, `${JSON.stringify(leadTurn)}\n`, { flag: "a" });
  return { home, stateDir };
}

function runImport({ home, stateDir }) {
  const run = spawnSync(process.execPath, [IMPORTER_PATH], {
    env: { ...process.env, HOME: home, GRAPHD_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function nodesById(stateDir) {
  const store = new DatabaseSync(join(stateDir, "graph.db"));
  const rows = store.prepare("SELECT * FROM nodes").all();
  store.close();
  return new Map(rows.map((row) => [row.id, row]));
}

function billedTurns(node) {
  return JSON.parse(node.billed_usage)["claude-opus-5-5"].turns;
}

test("each agent is billed from its own transcript, and re-importing does not accumulate", () => {
  const fixture = billingFixture();
  runImport(fixture);
  runImport(fixture);
  const nodes = nodesById(fixture.stateDir);

  assert.equal(billedTurns(nodes.get("toolu_sync")), 2);
  assert.equal(JSON.parse(nodes.get("toolu_sync").billed_usage)["claude-opus-5-5"].cacheRead, 2_000);
  assert.equal(billedTurns(nodes.get("toolu_fork")), 1, "the fork's inherited parent turn is not its spend");
  assert.equal(billedTurns(nodes.get("toolu_mate")), 1, "a teammate joins on its name");
  assert.equal(nodes.get("toolu_mate").resolved_model, "claude-opus-5-5");
});

test("a spawn answered with an error string is rejected, keeps its reason, and bills nothing", () => {
  const fixture = billingFixture();
  runImport(fixture);
  const denied = nodesById(fixture.stateDir).get("toolu_denied");
  assert.equal(denied.status, "rejected");
  assert.equal(denied.result_text, DENY_TEXT);
  assert.equal(denied.billed_usage, null);
});

function openFixtureStore(stateDir) {
  return new DatabaseSync(join(stateDir, "graph.db"));
}

test("re-importing a store whose denied spawn was filed as ok marks it rejected", () => {
  const fixture = billingFixture();
  runImport(fixture);
  const store = openFixtureStore(fixture.stateDir);
  store.prepare("UPDATE nodes SET status = 'ok', result_text = NULL WHERE id = 'toolu_denied'").run();
  store.close();
  runImport(fixture);
  const denied = nodesById(fixture.stateDir).get("toolu_denied");
  assert.equal(denied.status, "rejected");
  assert.equal(denied.result_text, DENY_TEXT);
});

test("a teammate with no name in its input takes the name its result reports", () => {
  const fixture = billingFixture();
  const leadPath = join(fixture.home, ".claude", "projects", "-work-repo", `${SESSION_ID}.jsonl`);
  writeFileSync(
    leadPath,
    spawnEntries({
      toolUseId: "toolu_unnamed",
      input: { description: "unnamed", prompt: "e", team_name: "t" },
      result: { status: "teammate_spawned", name: "late-name", model: "claude-opus-5-5" },
      second: 40,
    })
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    { flag: "a" },
  );
  runImport(fixture);
  assert.equal(nodesById(fixture.stateDir).get("toolu_unnamed").name, "late-name");
});

test("a Workflow answered with an error string is an error, not a rejected spawn", () => {
  const fixture = billingFixture();
  const leadPath = join(fixture.home, ".claude", "projects", "-work-repo", `${SESSION_ID}.jsonl`);
  const entries = spawnEntries({
    toolUseId: "toolu_wf_error",
    input: { description: "wf", prompt: "f" },
    result: "Error: The journal for workflow run wf_x is not on disk",
    second: 45,
  });
  entries[0].message.content[0].name = "Workflow";
  writeFileSync(leadPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "a" });
  runImport(fixture);
  assert.equal(nodesById(fixture.stateDir).get("toolu_wf_error").status, "error");
});

test("a message from an agent named but not identified is filed as the agent's, and old rows are repaired", () => {
  const fixture = billingFixture();
  const subagentPath = join(fixture.home, ".claude", "projects", "-work-repo", SESSION_ID, "subagents", "agent-ahelper-1.jsonl");
  const message = {
    ...SHARED,
    isSidechain: true,
    agentName: "helper",
    type: "assistant",
    timestamp: at(50),
    message: { id: "mate-send", content: [{ type: "tool_use", id: "toolu_send", name: "SendMessage", input: { to: "team-lead" } }] },
  };
  writeFileSync(subagentPath, `${JSON.stringify(message)}\n`, { flag: "a" });
  runImport(fixture);
  const store = openFixtureStore(fixture.stateDir);
  store
    .prepare(
      `INSERT INTO resumptions (id, run_id, ts, target_ref, target_kind, sender, sender_ref)
       VALUES ('old-teammate', ?, ?, 'team-lead', 'name', 'lead', 'carol'),
              ('old-lead', ?, ?, 'helper', 'name', 'lead', NULL)`,
    )
    .run(SESSION_ID, at(51), SESSION_ID, at(52));
  store.close();
  runImport(fixture);
  const reader = openFixtureStore(fixture.stateDir);
  const senders = Object.fromEntries(
    reader.prepare("SELECT id, sender, sender_ref FROM resumptions").all().map((row) => [row.id, [row.sender, row.sender_ref]]),
  );
  reader.close();
  assert.deepEqual(senders.toolu_send, ["agent", "helper"]);
  assert.deepEqual(senders["old-teammate"], ["agent", "carol"]);
  assert.deepEqual(senders["old-lead"], ["lead", null]);
});

test("a resumed Workflow and its original each own only the agents they ran", () => {
  const fixture = billingFixture();
  const projectDir = join(fixture.home, ".claude", "projects", "-work-repo");
  const workflowDir = join(projectDir, SESSION_ID, "subagents", "workflows", "wf_run");
  mkdirSync(workflowDir, { recursive: true });
  for (const [agentId, second] of [["early", 53], ["late", 57]]) {
    writeFileSync(join(workflowDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "impl-pressure-tester" }));
    writeJsonLines(join(workflowDir, `agent-${agentId}.jsonl`), [agentTurn({ messageId: `wf-${agentId}`, second })]);
  }
  const workflowCall = (toolUseId, second) => {
    const entries = spawnEntries({
      toolUseId,
      input: { description: "verify", script: "x" },
      result: { status: "ok", transcriptDir: workflowDir, runId: "wf_run" },
      second,
    });
    entries[0].message.content[0].name = "Workflow";
    return entries;
  };
  const leadPath = join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(
    leadPath,
    [...workflowCall("toolu_wf_original", 52), ...workflowCall("toolu_wf_resumed", 56)]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    { flag: "a" },
  );
  runImport(fixture);
  runImport(fixture);
  const nodes = nodesById(fixture.stateDir);
  assert.equal(billedTurns(nodes.get("toolu_wf_original")), 1);
  assert.equal(billedTurns(nodes.get("toolu_wf_resumed")), 1);
  assert.equal(nodes.get("wf:wf_run:early").parent_node_id, "toolu_wf_original");
  assert.equal(nodes.get("wf:wf_run:late").parent_node_id, "toolu_wf_resumed");
});
