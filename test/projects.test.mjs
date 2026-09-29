import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionProjects, spendByProject } from "../src/projects.mjs";

function graphStore() {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  return store;
}

function addRunWithNode(store, { runId, sessionId, tokens, startedAt = "2026-09-24T11:00:00Z" }) {
  store
    .prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)")
    .run(runId, sessionId, startedAt);
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, started_at, status, total_tokens)
       VALUES (?, ?, 'Agent', ?, 'ok', ?)`,
    )
    .run(`node-${runId}`, runId, startedAt, tokens);
}

function picksFile(rows) {
  const path = join(mkdtempSync(join(tmpdir(), "graphd-picks-")), "picks.sqlite3");
  const picks = new DatabaseSync(path);
  picks.exec(
    `CREATE TABLE picks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      project_slug TEXT NOT NULL, recorded_at TEXT NOT NULL, chosen_doc_ids TEXT NOT NULL,
      dropped_doc_ids TEXT NOT NULL, total_lines INTEGER NOT NULL, reason TEXT NOT NULL,
      confidence REAL NOT NULL, has_dropped_every_time INTEGER NOT NULL,
      has_in_area_match INTEGER NOT NULL)`,
  );
  const insert = picks.prepare(
    `INSERT INTO picks (session_id, project_slug, recorded_at, chosen_doc_ids, dropped_doc_ids,
      total_lines, reason, confidence, has_dropped_every_time, has_in_area_match)
     VALUES (?, ?, '2026-09-24T11:00:00Z', '', '', 0, '', ?, 0, 0)`,
  );
  for (const [sessionId, slug, confidence] of rows) insert.run(sessionId, slug, confidence ?? 1.0);
  picks.close();
  return path;
}

test("spend lands on the project spine recorded for the session", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(store, picksFile([["s1", "alpha"]]));
  assert.deepEqual(spend.projects, [
    { slug: "alpha", nodeCount: 1, tokens: 1000, sessionCount: 1 },
  ]);
  assert.equal(spend.unattributedTokens, 0);
});

test("a session spine never recorded is reported as unattributed, not dropped", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  addRunWithNode(store, { runId: "r2", sessionId: "s2", tokens: 500 });
  const spend = spendByProject(store, picksFile([["s1", "alpha"]]));
  assert.equal(spend.unattributedTokens, 500);
  assert.equal(spend.unattributedNodes, 1);
});

test("a session attached to two projects counts toward both", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(store, picksFile([["s1", "alpha"], ["s1", "beta"]]));
  assert.deepEqual(spend.projects.map((entry) => entry.slug).sort(), ["alpha", "beta"]);
  assert.equal(spend.projects[0].tokens, 1000);
});

test("the placeholder session id is not a project attribution", () => {
  assert.equal(readSessionProjects(picksFile([["unknown", "alpha"]])).size, 0);
});

test("graphd does not depend on spine being installed", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(store, "/nonexistent/picks.sqlite3");
  assert.deepEqual(spend.projects, []);
  assert.equal(spend.unattributedTokens, 1000);
});

test("a session spine could not resolve is reported as ambiguous, not split across candidates", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(
    store,
    picksFile([["s1", "alpha", 0.0], ["s1", "beta", 0.0], ["s1", "gamma", 0.0]]),
  );
  assert.deepEqual(spend.projects, []);
  assert.equal(spend.ambiguousTokens, 1000);
  assert.equal(spend.ambiguousNodes, 1);
  assert.equal(spend.unattributedTokens, 0);
});

test("one resolved pick settles a session that also has tied rows", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(store, picksFile([["s1", "alpha", 0.0], ["s1", "alpha", 1.0]]));
  assert.equal(spend.ambiguousTokens, 0);
  assert.equal(spend.projects[0].slug, "alpha");
});

test("a zero-confidence candidate is not credited when another project resolved the session", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(
    store,
    picksFile([["s1", "alpha", 0.0], ["s1", "beta", 0.0], ["s1", "gamma", 1.0]]),
  );
  assert.deepEqual(spend.projects, [{ slug: "gamma", nodeCount: 1, tokens: 1000, sessionCount: 1 }]);
});

test("a tied session names the projects spine could not choose between", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  const spend = spendByProject(store, picksFile([["s1", "beta", 0.0], ["s1", "alpha", 0.0]]));
  assert.deepEqual(spend.ambiguousCandidates, ["alpha", "beta"]);
});

test("a spawn recorded by both the hook and the backfill counts once", () => {
  const store = graphStore();
  addRunWithNode(store, { runId: "r1", sessionId: "s1", tokens: 1000 });
  // The backfill's twin of the hook row: keyed by tool_use id, same run, label, tool and start.
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, started_at, status, total_tokens)
       VALUES ('toolu_twin', 'r1', 'Agent', '2026-09-24T11:00:00Z', 'ok', NULL)`,
    )
    .run();
  const spend = spendByProject(store, picksFile([["s1", "alpha"]]));
  assert.equal(spend.projects[0].nodeCount, 1);
});
