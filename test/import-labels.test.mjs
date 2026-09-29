import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const IMPORTER_PATH = join(import.meta.dirname, "..", "bin", "graph-import.mjs");
const SCHEMA_PATH = join(import.meta.dirname, "..", "schema.sql");
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function workflowCall({ toolUseId, input, result, minute }) {
  const at = (second) => `2026-09-25T10:${String(minute).padStart(2, "0")}:${second}.000Z`;
  const shared = { sessionId: SESSION_ID, cwd: "/work/repo" };
  return [
    {
      ...shared,
      type: "assistant",
      timestamp: at("00"),
      message: { content: [{ type: "tool_use", id: toolUseId, name: "Workflow", input }] },
    },
    {
      ...shared,
      type: "user",
      timestamp: at("01"),
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      toolUseResult: { status: "ok", ...result },
    },
  ];
}

/** A HOME holding one transcript and a store pre-seeded with two rows, then imported into. */
function importFixture() {
  const home = mkdtempSync(join(tmpdir(), "graphd-import-"));
  const stateDir = join(home, "state");
  const projectDir = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateDir);
  const entries = [
    ...workflowCall({
      toolUseId: "toolu_persisted",
      input: { scriptPath: "/x/workflows/scripts/implement-verify-wf_1c546ab-3f2.js" },
      result: {},
      minute: 1,
    }),
    ...workflowCall({
      toolUseId: "toolu_library",
      input: { scriptPath: "/x/.claude/workflows/close-access-leaks.js" },
      result: {},
      minute: 2,
    }),
    ...workflowCall({
      toolUseId: "toolu_inline",
      input: { script: "export const meta = {}" },
      result: { workflowName: "docs-index-rows" },
      minute: 3,
    }),
    ...workflowCall({
      toolUseId: "toolu_described",
      input: { description: "Given label", script: "export const meta = {}" },
      result: { workflowName: "other-name" },
      minute: 4,
    }),
  ];
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));

  const store = new DatabaseSync(join(stateDir, "graph.db"));
  store.exec(readFileSync(SCHEMA_PATH, "utf8"));
  store
    .prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, '2026-09-25T10:00:00Z')")
    .run(SESSION_ID, SESSION_ID);
  const seed = store.prepare(
    `INSERT INTO nodes (id, run_id, tool, label, started_at, status)
     VALUES (?, ?, 'Workflow', ?, '2026-09-25T10:03:00.000Z', 'ok')`,
  );
  seed.run("toolu_inline", SESSION_ID, null);
  seed.run("toolu_described", SESSION_ID, "Kept label");
  store.close();

  const imported = spawnSync(process.execPath, [IMPORTER_PATH], {
    env: { ...process.env, HOME: home, GRAPHD_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);

  const reader = new DatabaseSync(join(stateDir, "graph.db"), { readOnly: true });
  const labels = Object.fromEntries(
    reader.prepare("SELECT id, label FROM nodes").all().map((row) => [row.id, row.label]),
  );
  reader.close();
  return labels;
}

test("a Workflow called by scriptPath is labelled with the script's name", () => {
  const labels = importFixture();
  assert.equal(labels.toolu_persisted, "implement-verify");
  assert.equal(labels.toolu_library, "close-access-leaks");
});

test("a Workflow with no description takes its result's workflowName, filling a null label", () => {
  assert.equal(importFixture().toolu_inline, "docs-index-rows");
});

test("re-importing never overwrites a label that is already set", () => {
  assert.equal(importFixture().toolu_described, "Kept label");
});
