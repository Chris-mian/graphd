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
