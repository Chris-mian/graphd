import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db.mjs";
import { FOLLOWUP_WINDOW_MS, accountForRepo, deriveOutcome } from "../src/outcomes.mjs";
import { computeOutcomes } from "../src/outcomereport.mjs";

const DAY_MS = 86_400_000;
const MERGED_AT = "2026-10-01T12:00:00Z";
const AFTER_WINDOW_MS = Date.parse(MERGED_AT) + FOLLOWUP_WINDOW_MS + DAY_MS;
const INSIDE_WINDOW_MS = Date.parse(MERGED_AT) + DAY_MS;

function mergedView(overrides = {}) {
  return {
    state: "MERGED",
    title: "fix(access): close the leak",
    createdAt: "2026-09-30T10:00:00Z",
    mergedAt: MERGED_AT,
    closedAt: MERGED_AT,
    baseRefName: "main",
    author: { login: "chrisliu-suno" },
    files: [{ path: "a.py" }, { path: "b.py" }],
    commits: [
      { oid: "own1", authoredDate: "2026-09-30T09:00:00Z" },
      { oid: "own2", authoredDate: "2026-09-30T15:00:00Z" },
    ],
    mergeCommit: { oid: "merge1" },
    ...overrides,
  };
}

test("follow-ups exclude the PR's own commits and PRs already open when it merged", () => {
  const outcome = deriveOutcome({
    view: mergedView(),
    prNumber: 100,
    followupCandidates: [
      { sha: "merge1", message: "fix(access): close the leak (#100)" },
      { sha: "stack", message: "feat(access): next in stack (#101)" },
      { sha: "later", message: "fix(access): handle trashed clips (#140)" },
      { sha: "later", message: "fix(access): handle trashed clips (#140)" },
      { sha: "docs", message: "docs: tidy (#141)" },
    ],
    plannedPrNumbers: new Set([101]),
    nowMs: AFTER_WINDOW_MS,
  });
  assert.equal(outcome.followupCommits, 2);
  assert.equal(outcome.followupFixCommits, 1);
  assert.equal(outcome.reverted, 0);
  assert.equal(outcome.commitsAfterOpen, 1);
  assert.equal(outcome.isFinal, true);
});

test("a revert naming the PR marks it reverted", () => {
  const outcome = deriveOutcome({
    view: mergedView(),
    prNumber: 100,
    followupCandidates: [{ sha: "r", message: 'Revert "fix(access): close the leak (#100)" (#150)' }],
    nowMs: AFTER_WINDOW_MS,
  });
  assert.equal(outcome.reverted, 1);
});

test("a revert of a PR whose number only starts with this one's is not a revert of this one", () => {
  const outcome = deriveOutcome({
    view: mergedView({ title: "" }),
    prNumber: 100,
    followupCandidates: [{ sha: "r", message: 'Revert "feat: other (#1005)" (#1006)' }],
    nowMs: AFTER_WINDOW_MS,
  });
  assert.equal(outcome.reverted, 0);
});

test("a fix-up listed in a squash body does not make a feature commit a fix", () => {
  const outcome = deriveOutcome({
    view: mergedView(),
    prNumber: 100,
    followupCandidates: [{ sha: "f", message: "feat(access): add the audit (#200)\n\n* fix typo\n* fix test" }],
    nowMs: AFTER_WINDOW_MS,
  });
  assert.equal(outcome.followupCommits, 1);
  assert.equal(outcome.followupFixCommits, 0);
});

test("follow-up columns stay null and the outcome open until the window closes", () => {
  const outcome = deriveOutcome({ view: mergedView(), prNumber: 100, followupCandidates: null, nowMs: INSIDE_WINDOW_MS });
  assert.equal(outcome.followupCommits, null);
  assert.equal(outcome.isFinal, false);
});

test("a PR closed without merging is final at once", () => {
  const outcome = deriveOutcome({
    view: mergedView({ state: "CLOSED", mergedAt: null }),
    prNumber: 100,
    nowMs: INSIDE_WINDOW_MS,
  });
  assert.equal(outcome.isFinal, true);
  assert.equal(outcome.followupCommits, null);
});

test("a repo is read with its owner's account", () => {
  const accounts = { personalOwners: ["Chris-mian", "romp-on"], personalAccount: "Chris-mian", workAccount: "chrisliu-suno" };
  assert.equal(accountForRepo("romp-on/romp", accounts), "Chris-mian");
  assert.equal(accountForRepo("suno-ai/glockenspiel", accounts), "chrisliu-suno");
});

function seedWorkflow(store, { id, sessionId, label = "implement-verify", mode, startedAt, resultText }) {
  store
    .prepare(
      `INSERT INTO nodes (id, run_id, tool, label, prompt_sha, started_at, status, workflow_mode, result_text)
       VALUES (?, ?, 'Workflow', ?, 'sha', ?, 'completed', ?, ?)`,
    )
    .run(id, sessionId, label, startedAt, mode, resultText);
}

function seedSession(store, { sessionId, mode, unitCount, surviving, prNumber, openedAt, activeMs, state }) {
  store.prepare("INSERT INTO runs (id, session_id, started_at) VALUES (?, ?, ?)").run(sessionId, sessionId, openedAt);
  if (mode) {
    const resultText = JSON.stringify({ mode, unitCount, completedCount: unitCount, findingsSurviving: surviving });
    seedWorkflow(store, { id: `wf-${sessionId}`, sessionId, mode, startedAt: openedAt, resultText });
  }
  if (prNumber == null) return;
  store
    .prepare(
      `INSERT INTO prs (url, repo, number, tool_use_id, session_id, opened_by, opened_at, active_ms_to_open, state, fetched_at)
       VALUES (?, 'o/r', ?, ?, ?, 'lead', ?, ?, ?, ?)`,
    )
    .run(`https://github.com/o/r/pull/${prNumber}`, prNumber, `t${prNumber}`, sessionId, openedAt, activeMs, state, openedAt);
}

test("outcomes split PRs by the implementation mode of their session and pick the thinner arm next", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "graphd-outcomes-")), "graph.db"));
  seedSession(store, { sessionId: "s1", mode: "parallel", unitCount: 4, surviving: 2, prNumber: 1, openedAt: "2026-11-11T10:00:00Z", activeMs: 20 * 60_000, state: "MERGED" });
  seedSession(store, { sessionId: "s2", mode: "verify-only", unitCount: 2, surviving: 4, prNumber: 2, openedAt: "2026-11-12T10:00:00Z", activeMs: 40 * 60_000, state: "MERGED" });
  seedSession(store, { sessionId: "s3", mode: "verify-only", unitCount: 1, surviving: 0, prNumber: 3, openedAt: "2026-11-13T10:00:00Z", activeMs: 60 * 60_000, state: "OPEN" });
  seedSession(store, { sessionId: "s4", mode: null, prNumber: 4, openedAt: "2026-10-01T10:00:00Z", activeMs: null, state: "CLOSED" });

  const outcomes = computeOutcomes(store);
  const byArm = Object.fromEntries(outcomes.allTime.map((row) => [row.arm, row]));
  assert.equal(byArm.parallel.prCount, 1);
  assert.equal(byArm.parallel.survivingFindingsPerUnit, 0.5);
  assert.equal(byArm["verify-only"].prCount, 2);
  assert.equal(byArm["verify-only"].medianActiveMinutesToOpen, 50);
  assert.equal(byArm["verify-only"].mergedShare, 0.5);
  assert.equal(byArm["no workflow"].prCount, 1);
  assert.equal(byArm.parallel.isTooFew, true);
  assert.deepEqual(outcomes.trial.map((row) => row.arm), ["parallel", "verify-only"]);
  assert.equal(outcomes.nextArm, "parallel");
  const widest = outcomes.byWidth.find((group) => group.bucket === "4+ units");
  assert.deepEqual(widest.arms.map((row) => row.arm), ["parallel"]);
});

test("only implement-verify runs that ran decide an arm, and the next arm counts sessions without PRs", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "graphd-outcomes-")), "graph.db"));
  seedSession(store, { sessionId: "p1", mode: "parallel", unitCount: 2, surviving: 0, prNumber: null, openedAt: "2026-11-11T10:00:00Z" });
  seedSession(store, { sessionId: "v1", mode: "verify-only", unitCount: 2, surviving: 0, prNumber: 1, openedAt: "2026-11-11T11:00:00Z", activeMs: 1, state: "OPEN" });
  seedSession(store, { sessionId: "v2", mode: "verify-only", unitCount: 2, surviving: 0, prNumber: 2, openedAt: "2026-11-11T12:00:00Z", activeMs: 1, state: "OPEN" });
  // A parallel call that threw on overlapping files, and another workflow that happens to take a mode.
  seedWorkflow(store, { id: "threw", sessionId: "v1", mode: "parallel", startedAt: "2026-11-11T11:30:00Z", resultText: "Error: parallel mode needs units with disjoint files" });
  seedWorkflow(store, { id: "other", sessionId: "v2", label: "close-access-leaks", mode: "parallel", startedAt: "2026-11-11T12:30:00Z", resultText: '{"unitCount":3}' });

  const outcomes = computeOutcomes(store);
  assert.deepEqual(outcomes.allTime.map((row) => [row.arm, row.prCount]), [["verify-only", 2]]);
  assert.equal(outcomes.nextArm, "parallel");
  seedSession(store, { sessionId: "p2", mode: "parallel", unitCount: 2, surviving: 0, prNumber: null, openedAt: "2026-11-12T10:00:00Z" });
  assert.equal(computeOutcomes(store).nextArm, "parallel");
  seedSession(store, { sessionId: "p3", mode: "parallel", unitCount: 2, surviving: 0, prNumber: null, openedAt: "2026-11-12T11:00:00Z" });
  assert.equal(computeOutcomes(store).nextArm, "verify-only");
});
