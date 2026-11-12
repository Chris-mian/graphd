import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/db.mjs";
import { computeOutcomes } from "../src/outcomereport.mjs";
import { computeTrend } from "../src/trend.mjs";
import { runCommand, startFakeDaemon } from "./helpers/fake-daemon.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/graph.mjs", import.meta.url));

function seededStore() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "graphd-cli-render-")), "graph.db"));
  const addSession = store.prepare(
    "INSERT INTO sessions (id, started_at, tool_calls, batched_calls) VALUES (?, ?, ?, ?)",
  );
  addSession.run("s1", "2026-09-15T10:00:00.000Z", 0, 0);
  addSession.run("s2", "2026-09-22T10:00:00.000Z", 10, 4);
  const addPr = store.prepare(
    `INSERT INTO prs (url, repo, number, tool_use_id, session_id, opened_by, opened_at, state)
     VALUES (?, 'o/r', ?, ?, 's2', 'lead', '2026-09-22T11:00:00Z', 'OPEN')`,
  );
  addPr.run("https://github.com/o/r/pull/1", 1, "t1");
  return store;
}

async function runCli(command, routes) {
  const daemon = await startFakeDaemon(routes);
  const stateDir = mkdtempSync(join(tmpdir(), "graphd-cli-state-"));
  writeFileSync(join(stateDir, "token"), "test-token");
  const result = await runCommand(process.execPath, [CLI_PATH, command], {
    env: { ...process.env, GRAPHD_URL: daemon.url, GRAPHD_STATE_DIR: stateDir },
  });
  await daemon.close();
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n");
}

test("graph trend prints a batched column, '-' for a week with no calls", async () => {
  const lines = await runCli("trend", { "/v1/trend": { weeks: computeTrend(seededStore()) } });
  assert.match(lines.find((line) => line.startsWith("week")), /batched\s*$/);
  assert.match(lines.find((line) => line.startsWith("2026-W37")), /\s-\s*$/);
  assert.match(lines.find((line) => line.startsWith("2026-W38")), /\s40%\s*$/);
});

test("graph outcomes prints each arm's batched share", async () => {
  const lines = await runCli("outcomes", { "/v1/outcomes": { outcomes: computeOutcomes(seededStore()) } });
  assert.ok(lines.some((line) => /batched/.test(line)), "no batched header");
  assert.ok(lines.some((line) => /no workflow.*\b40%/.test(line)), "no 40% on the arm row");
});
