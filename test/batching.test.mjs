import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MCP_READ_PATTERN, READ_TOOL_NAMES, isReadTool, leadBatching } from "../src/batching.mjs";
import { openStore } from "../src/db.mjs";
import { computeOutcomes } from "../src/outcomereport.mjs";
import { computeTrend } from "../src/trend.mjs";

const IMPORTER_PATH = join(import.meta.dirname, "..", "bin", "graph-import.mjs");
const SESSION_ID = "bbbbbbbb-2222-3333-4444-555555555555";

let lineCount = 0;

/** One transcript line per tool call, all sharing the message id, as Claude Code writes them. */
function message(messageId, toolNames, { isSidechain = false } = {}) {
  const blocks = toolNames.length ? toolNames.map((name) => ({ type: "tool_use", id: `toolu_${name}_${lineCount}`, name })) : [{ type: "text", text: "thinking aloud" }];
  return blocks.map((block) => {
    lineCount += 1;
    return {
      type: "assistant",
      isSidechain,
      sessionId: SESSION_ID,
      cwd: "/work/repo",
      timestamp: `2026-11-12T10:00:${String(lineCount % 60).padStart(2, "0")}.000Z`,
      uuid: `u${lineCount}`,
      message: { id: messageId, content: [block] },
    };
  });
}

test("calls split across lines are one message when they share message.id", () => {
  const entries = [...message("m1", ["Read", "Grep", "Bash"]), ...message("m2", ["Edit"])];
  assert.deepEqual(leadBatching(entries), { toolCalls: 4, batchedCalls: 3, serialReadCalls: 0 });
});

test("a line with no message.id stands alone", () => {
  const entries = [...message(undefined, ["Read"]), ...message(undefined, ["Read"])];
  assert.deepEqual(leadBatching(entries), { toolCalls: 2, batchedCalls: 0, serialReadCalls: 0 });
});

test("sidechain entries are a subagent's, not the lead's", () => {
  const entries = [...message("lead", ["Read"]), ...message("side", ["Read", "Grep"], { isSidechain: true })];
  assert.deepEqual(leadBatching(entries), { toolCalls: 1, batchedCalls: 0, serialReadCalls: 0 });
});

test("a run of exactly three single reads counts three; a run of two counts none", () => {
  const runOfThree = [...message("a", ["Read"]), ...message("b", ["Grep"]), ...message("c", ["Glob"])];
  assert.equal(leadBatching(runOfThree).serialReadCalls, 3);
  const runOfTwo = [...message("a", ["Read"]), ...message("b", ["Grep"]), ...message("c", ["Edit"])];
  assert.equal(leadBatching(runOfTwo).serialReadCalls, 0);
});

test("a text-only message, a batch, or a non-read call ends a run", () => {
  const brokenByText = [
    ...message("a", ["Read"]),
    ...message("b", ["Read"]),
    ...message("t", []),
    ...message("c", ["Read"]),
    ...message("d", ["Read"]),
  ];
  assert.equal(leadBatching(brokenByText).serialReadCalls, 0);
  const brokenByBatch = [...message("a", ["Read"]), ...message("b", ["Read"]), ...message("x", ["Read", "Read"]), ...message("c", ["Read"])];
  assert.equal(leadBatching(brokenByBatch).serialReadCalls, 0);
  const runThenRun = [...message("a", ["Read"]), ...message("b", ["Read"]), ...message("c", ["Read"]), ...message("w", ["Write"]), ...message("d", ["Read"]), ...message("e", ["Read"]), ...message("f", ["Read"]), ...message("g", ["Read"])];
  assert.equal(leadBatching(runThenRun).serialReadCalls, 7);
});

test("Bash is not a read, since a command line can write", () => {
  assert.equal(isReadTool("Bash"), false);
  assert.equal(READ_TOOL_NAMES.has("Bash"), false);
  const bashRun = [...message("a", ["Bash"]), ...message("b", ["Bash"]), ...message("c", ["Bash"])];
  assert.equal(leadBatching(bashRun).serialReadCalls, 0);
});

test("an MCP tool is a read when its own name says get, list, search, query, fetch or read", () => {
  assert.equal(MCP_READ_PATTERN.test("datadog_query_metric"), true);
  assert.equal(isReadTool("mcp__plugin_suno_linear__get_issue"), true);
  assert.equal(isReadTool("mcp__claude_ai_Notion__notion-search"), true);
  assert.equal(isReadTool("mcp__plugin_suno_suno-toolshed__read_page"), true);
  assert.equal(isReadTool("mcp__plugin_suno_linear__save_issue"), false);
  // The server's name does not make its tools reads.
  assert.equal(isReadTool("mcp__claude_ai_CourtListener__authenticate"), false);
  assert.equal(isReadTool("getSomething"), false);
  // The verb must be a whole word: "thread" holds "read", "widget" holds "get".
  assert.equal(isReadTool("mcp__claude_ai_Hex__create_thread"), false);
  assert.equal(isReadTool("mcp__slack__post_thread_reply"), false);
  assert.equal(isReadTool("mcp__visualize__show_widget"), false);
  assert.equal(isReadTool("mcp__plugin_suno_statsig__Get_Gate_Details_by_ID"), true);
});

function writeTranscript(projectDir, entries) {
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

function runImporter(home, stateDir) {
  const imported = spawnSync(process.execPath, [IMPORTER_PATH], {
    env: { ...process.env, HOME: home, GRAPHD_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  const reader = new DatabaseSync(join(stateDir, "graph.db"), { readOnly: true });
  const row = reader
    .prepare("SELECT tool_calls, batched_calls, serial_read_calls, turn_count FROM sessions WHERE id = ?")
    .get(SESSION_ID);
  reader.close();
  return { ...row };
}

test("an import fills the session's batching columns, and a shorter re-read never lowers them", () => {
  const home = mkdtempSync(join(tmpdir(), "graphd-batching-"));
  const stateDir = join(home, "state");
  const projectDir = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateDir);
  const full = [
    ...message("m1", ["Read", "Grep"]),
    ...message("m2", ["Read"]),
    ...message("m3", ["mcp__plugin_suno_linear__get_issue"]),
    ...message("m4", ["Glob"]),
    ...message("m5", ["Bash"]),
  ];
  writeTranscript(projectDir, full);
  const first = runImporter(home, stateDir);
  assert.deepEqual(first, { tool_calls: 6, batched_calls: 2, serial_read_calls: 3, turn_count: 6 });

  writeTranscript(projectDir, message("m1", ["Read", "Grep"]));
  assert.deepEqual(runImporter(home, stateDir), first);
});

test("graph trend reports each week's batched share, and none for a week without calls", () => {
  const store = openStore(":memory:");
  const addSession = store.prepare("INSERT INTO sessions (id, started_at, tool_calls, batched_calls, serial_read_calls) VALUES (?, ?, ?, ?, ?)");
  addSession.run("s1", "2026-09-15T10:00:00.000Z", 0, 0, 0);
  addSession.run("s2", "2026-09-22T10:00:00.000Z", 10, 6, 3);
  addSession.run("s3", "2026-09-23T10:00:00.000Z", 10, 2, 0);
  const byWeek = Object.fromEntries(computeTrend(store).map((week) => [week.week, week]));
  assert.equal(byWeek["2026-W37"].batchedShare, null);
  assert.equal(byWeek["2026-W38"].toolCalls, 20);
  assert.equal(byWeek["2026-W38"].serialReadCalls, 3);
  assert.equal(byWeek["2026-W38"].batchedShare, 0.4);
});

test("each outcome arm reports the batched share over its own sessions", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "graphd-batching-outcomes-")), "graph.db"));
  const addSession = store.prepare("INSERT INTO sessions (id, started_at, tool_calls, batched_calls) VALUES (?, '2026-11-11T10:00:00Z', ?, ?)");
  addSession.run("s1", 8, 2);
  addSession.run("s2", 2, 2);
  const addPr = store.prepare(
    `INSERT INTO prs (url, repo, number, tool_use_id, session_id, opened_by, opened_at, state)
     VALUES (?, 'o/r', ?, ?, ?, 'lead', '2026-11-11T11:00:00Z', 'OPEN')`,
  );
  addPr.run("https://github.com/o/r/pull/1", 1, "t1", "s1");
  addPr.run("https://github.com/o/r/pull/2", 2, "t2", "s1");
  addPr.run("https://github.com/o/r/pull/3", 3, "t3", "s2");
  const [row] = computeOutcomes(store).allTime;
  assert.equal(row.arm, "no workflow");
  // Each session counts once however many PRs it opened: (2 + 2) / (8 + 2).
  assert.equal(row.batchedShare, 0.4);
});
