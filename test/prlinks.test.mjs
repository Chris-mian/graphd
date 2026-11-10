import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { activeMsToOpen, pickOriginal, pullRequestsIn, workflowModeFromInput } from "../src/prlinks.mjs";

const IMPORTER_PATH = join(import.meta.dirname, "..", "bin", "graph-import.mjs");
const SESSION_ID = "33333333-1111-2222-3333-444444444444";
// Sorts before SESSION_ID, so the copy cannot win by being read first.
const COPY_SESSION_ID = "00000000-1111-2222-3333-444444444444";
const PR_URL = "https://github.com/suno-ai/glockenspiel/pull/123";
const SECOND_PR_URL = "https://github.com/suno-ai/glockenspiel/pull/124";
const MINUTE_MS = 60_000;
const START_MS = Date.parse("2026-11-01T10:00:00.000Z");

const at = (minute) => new Date(START_MS + minute * MINUTE_MS).toISOString();

function prCreateCall({ id, minute, sessionId = SESSION_ID }) {
  return {
    sessionId,
    cwd: "/work/repo",
    type: "assistant",
    timestamp: at(minute),
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "gh pr create --draft --title x" } }] },
  };
}

function toolResult({ id, minute, text, toolUseResult, sessionId = SESSION_ID }) {
  return {
    sessionId,
    type: "user",
    timestamp: at(minute),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  };
}

function editCall({ minute, sessionId = SESSION_ID }) {
  return {
    sessionId,
    type: "assistant",
    timestamp: at(minute),
    message: { content: [{ type: "tool_use", id: `edit-${minute}`, name: "Edit", input: { file_path: "/x" } }] },
  };
}

test("a PR URL is read from stdout, or from the result block when there is no toolUseResult", () => {
  const fromStdout = pullRequestsIn([
    prCreateCall({ id: "a", minute: 0 }),
    toolResult({ id: "a", minute: 1, text: "", toolUseResult: { stdout: `${PR_URL}\n`, stderr: "" } }),
  ]);
  const fromBlock = pullRequestsIn([prCreateCall({ id: "b", minute: 0 }), toolResult({ id: "b", minute: 1, text: PR_URL })]);
  for (const opened of [fromStdout, fromBlock]) {
    assert.equal(opened.length, 1);
    assert.deepEqual(
      { url: opened[0].url, repo: opened[0].repo, number: opened[0].number, openedAt: opened[0].openedAt },
      { url: PR_URL, repo: "suno-ai/glockenspiel", number: 123, openedAt: at(0) },
    );
  }
});

test("a blocked gh pr create opens nothing", () => {
  const blocked = pullRequestsIn([
    prCreateCall({ id: "c", minute: 0 }),
    toolResult({ id: "c", minute: 0, text: "PreToolUse:Bash hook error: Blocked by the comm-style gate" }),
  ]);
  assert.deepEqual(blocked, []);
});

test("a gh pr create refused because the PR exists opens nothing", () => {
  const text = `a pull request for branch "x" into branch "main" already exists:\n${PR_URL}`;
  assert.deepEqual(pullRequestsIn([prCreateCall({ id: "e", minute: 0 }), toolResult({ id: "e", minute: 1, text })]), []);
});

test("a chained command that prints other PRs first links the PR it created", () => {
  const text = "https://github.com/suno-ai/glockenspiel/pull/1\nhttps://github.com/suno-ai/glockenspiel/pull/2\n" + PR_URL;
  const opened = pullRequestsIn([prCreateCall({ id: "f", minute: 0 }), toolResult({ id: "f", minute: 1, text })]);
  assert.equal(opened[0].number, 123);
});

test("an agent's first edit made while the lead waits on it starts the clock at the edit", () => {
  const waitingOnAgent = { at: START_MS + MINUTE_MS, toolInFlight: true };
  const agentReturned = { at: START_MS + 21 * MINUTE_MS, toolInFlight: false };
  const { activeMs } = activeMsToOpen({
    leadPoints: [waitingOnAgent, agentReturned],
    editTimesMs: [START_MS + 2 * MINUTE_MS],
    openedAtMs: START_MS + 22 * MINUTE_MS,
  });
  assert.equal(activeMs, 20 * MINUTE_MS);
});

test("within one session the first call to print a URL opened the PR", () => {
  const opened = { url: PR_URL, sessionId: SESSION_ID, openedAt: at(1) };
  const retried = { url: PR_URL, sessionId: SESSION_ID, openedAt: at(9) };
  assert.deepEqual(pickOriginal([retried, opened], new Map([[SESSION_ID, START_MS]])), [opened]);
});

test("a URL printed by some other command is not a PR this session opened", () => {
  const viewCall = {
    sessionId: SESSION_ID,
    type: "assistant",
    timestamp: at(0),
    message: { content: [{ type: "tool_use", id: "d", name: "Bash", input: { command: "gh pr view 123" } }] },
  };
  assert.deepEqual(pullRequestsIn([viewCall, toolResult({ id: "d", minute: 1, text: PR_URL })]), []);
});

test("work time starts at the first edit after the previous PR and skips idle gaps", () => {
  const leadPoints = [0, 2, 4, 200, 202].map((minute) => ({ at: START_MS + minute * MINUTE_MS, toolInFlight: false }));
  const { workStartedAtMs, activeMs } = activeMsToOpen({
    leadPoints,
    editTimesMs: [START_MS - 30 * MINUTE_MS, START_MS + 2 * MINUTE_MS],
    openedAtMs: START_MS + 202 * MINUTE_MS,
    previousOpenedAtMs: START_MS - 10 * MINUTE_MS,
  });
  assert.equal(workStartedAtMs, START_MS + 2 * MINUTE_MS);
  assert.equal(activeMs, 4 * MINUTE_MS);
});

test("a PR with no edit before it has no work time", () => {
  const result = activeMsToOpen({ leadPoints: [], editTimesMs: [START_MS + MINUTE_MS], openedAtMs: START_MS });
  assert.deepEqual(result, { workStartedAtMs: null, activeMs: null });
});

test("the session that started first owns a PR copied into another session", () => {
  const original = { url: PR_URL, sessionId: SESSION_ID, openedAt: at(5) };
  const copy = { url: PR_URL, sessionId: COPY_SESSION_ID, openedAt: at(5) };
  const starts = new Map([
    [SESSION_ID, START_MS],
    [COPY_SESSION_ID, START_MS + 60 * MINUTE_MS],
  ]);
  assert.deepEqual(pickOriginal([copy, original], starts), [original]);
});

test("workflow mode is read from object args, string args, and the bare-array form", () => {
  assert.equal(workflowModeFromInput({ args: { units: [], mode: "parallel" } }), "parallel");
  assert.equal(workflowModeFromInput({ args: '{"units":[],"mode":"parallel"}' }), "parallel");
  assert.equal(workflowModeFromInput({ args: [] }), "verify-only");
  assert.equal(workflowModeFromInput({ args: { units: [] } }), null);
  assert.equal(workflowModeFromInput({ resumeFromRunId: "wf_x" }), null);
});

function writeJsonLines(path, entries) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function workflowCall({ id, minute, input }) {
  return {
    sessionId: SESSION_ID,
    cwd: "/work/repo",
    type: "assistant",
    timestamp: at(minute),
    message: { content: [{ type: "tool_use", id, name: "Workflow", input: { name: "implement-verify", ...input } }] },
  };
}

function workflowResult({ id, minute, runId }) {
  return {
    sessionId: SESSION_ID,
    type: "user",
    timestamp: at(minute),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
    toolUseResult: { runId, workflowName: "implement-verify", content: "{}" },
  };
}

test("the importer links a PR to its original session and labels workflow modes", () => {
  const home = mkdtempSync(join(tmpdir(), "graphd-prs-"));
  const stateDir = join(home, "state");
  const projectDir = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateDir);
  const leadEntries = [
    { sessionId: SESSION_ID, cwd: "/work/repo", type: "user", timestamp: at(0), message: { content: "go" } },
    workflowCall({ id: "toolu_wf1", minute: 1, input: { args: '{"units":[],"mode":"parallel"}', description: "implement-verify" } }),
    workflowResult({ id: "toolu_wf1", minute: 2, runId: "wf_one" }),
    workflowCall({ id: "toolu_wf2", minute: 3, input: { resumeFromRunId: "wf_one", description: "implement-verify" } }),
    workflowResult({ id: "toolu_wf2", minute: 4, runId: "wf_one" }),
    editCall({ minute: 5 }),
    prCreateCall({ id: "toolu_pr", minute: 8 }),
    toolResult({ id: "toolu_pr", minute: 8, text: PR_URL }),
    workflowCall({ id: "toolu_wf3", minute: 10, input: { args: { units: [] }, description: "implement-verify" } }),
    { ...workflowResult({ id: "toolu_wf3", minute: 11, runId: "wf_two" }), toolUseResult: { runId: "wf_two", content: '{"mode":"parallel","unitCount":2' } },
    workflowCall({ id: "toolu_wf4", minute: 13, input: { args: { units: [] }, description: "implement-verify" } }),
    workflowResult({ id: "toolu_wf4", minute: 14, runId: "wf_three" }),
    prCreateCall({ id: "toolu_pr2", minute: 15 }),
    toolResult({ id: "toolu_pr2", minute: 15, text: SECOND_PR_URL }),
  ];
  writeJsonLines(join(projectDir, `${SESSION_ID}.jsonl`), leadEntries);
  const copyEntries = [
    { sessionId: COPY_SESSION_ID, cwd: "/work/repo", type: "user", timestamp: at(60), message: { content: "fork" } },
    prCreateCall({ id: "toolu_pr", minute: 8, sessionId: COPY_SESSION_ID }),
    toolResult({ id: "toolu_pr", minute: 8, text: PR_URL, sessionId: COPY_SESSION_ID }),
  ];
  writeJsonLines(join(projectDir, `${COPY_SESSION_ID}.jsonl`), copyEntries);
  const workflowAgentDir = join(projectDir, SESSION_ID, "subagents", "workflows", "wf_two");
  mkdirSync(workflowAgentDir, { recursive: true });
  writeJsonLines(join(workflowAgentDir, "agent-impl1.jsonl"), [{ ...editCall({ minute: 12 }), isSidechain: true }]);

  const run = spawnSync(process.execPath, [IMPORTER_PATH], {
    env: { ...process.env, HOME: home, GRAPHD_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const store = new DatabaseSync(join(stateDir, "graph.db"), { readOnly: true });
  const rows = store.prepare("SELECT number, session_id, opened_by, work_started_at, active_ms_to_open FROM prs ORDER BY number").all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { number: 123, session_id: SESSION_ID, opened_by: "lead", work_started_at: at(5), active_ms_to_open: 3 * MINUTE_MS },
      // The only edit after the first PR is a workflow agent's, at minute 12.
      { number: 124, session_id: SESSION_ID, opened_by: "lead", work_started_at: at(12), active_ms_to_open: 3 * MINUTE_MS },
    ],
  );
  const modes = store.prepare("SELECT id, workflow_mode FROM nodes WHERE tool = 'Workflow' ORDER BY id").all();
  assert.deepEqual(
    modes.map((row) => ({ ...row })),
    [
      { id: "toolu_wf1", workflow_mode: "parallel" },
      { id: "toolu_wf2", workflow_mode: "parallel" },
      { id: "toolu_wf3", workflow_mode: "parallel" },
      { id: "toolu_wf4", workflow_mode: "verify-only" },
    ],
  );
});
