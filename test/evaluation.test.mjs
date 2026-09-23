import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autonomyPerWorkload,
  bareInterruptSurfaces,
  checkIsBareInterrupt,
  interventionQuality,
  reasonFor,
  recentStoppedCommands,
  stoppedCommandShapes,
  themeBreakdown,
  weeklyTurns,
} from "../src/evaluation.mjs";
import { commandShape, followupReason, summarizeToolInput } from "../src/interventions.mjs";

const BARE = "[Request interrupted by user]";

function freshStore() {
  const store = new DatabaseSync(":memory:");
  store.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  return store;
}

function addIntervention(store, intervention) {
  store
    .prepare(
      `INSERT INTO interventions
         (id, run_id, cwd, ts, kind, quote, preceding_tool, preceding_detail)
       VALUES (?, 'run-1', NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      intervention.id,
      intervention.ts,
      intervention.kind ?? "interrupt",
      intervention.quote,
      intervention.tool ?? null,
      intervention.detail ?? null,
    );
}

test("a bare interrupt carries no text of its own and a typed turn does", () => {
  assert.equal(checkIsBareInterrupt(BARE), true);
  assert.equal(checkIsBareInterrupt("[Request interrupted by user for tool use]"), true);
  assert.equal(checkIsBareInterrupt("no, that is the wrong table"), false);
});

test("quality separates the reasonless stops from the ones that say why", () => {
  const store = freshStore();
  addIntervention(store, { id: "a", ts: "2026-09-01T00:00:00Z", quote: BARE });
  addIntervention(store, { id: "b", ts: "2026-09-02T00:00:00Z", quote: BARE });
  addIntervention(store, { id: "c", ts: "2026-09-03T00:00:00Z", quote: "no, revert that" });

  const quality = interventionQuality(store);
  assert.equal(quality.total, 3);
  assert.equal(quality.bareInterrupts, 2);
  assert.equal(quality.withReason, 1);
});

test("a repeated quote counts once as a distinct reason", () => {
  const store = freshStore();
  addIntervention(store, { id: "a", ts: "2026-09-01T00:00:00Z", quote: "keep going" });
  addIntervention(store, { id: "b", ts: "2026-09-02T00:00:00Z", quote: "keep going" });

  const quality = interventionQuality(store);
  assert.equal(quality.distinctReasons, 1);
  assert.equal(quality.duplicateReasons, 1);
});

test("a self-correction is the agent catching itself and is not counted", () => {
  const store = freshStore();
  addIntervention(store, {
    id: "a",
    ts: "2026-09-01T00:00:00Z",
    kind: "self_correction",
    quote: "correction: that number was wrong",
  });
  assert.equal(interventionQuality(store).total, 0);
});

test("surfaces group the reasonless stops by the tool that was running", () => {
  const store = freshStore();
  addIntervention(store, { id: "a", ts: "2026-09-01T00:00:00Z", quote: BARE, tool: "Bash" });
  addIntervention(store, { id: "b", ts: "2026-09-02T00:00:00Z", quote: BARE, tool: "Bash" });
  addIntervention(store, { id: "c", ts: "2026-09-03T00:00:00Z", quote: BARE, tool: "Read" });

  assert.deepEqual(
    bareInterruptSurfaces(store).map((row) => [row.surface, row.count]),
    [
      ["Bash", 2],
      ["Read", 1],
    ],
  );
});

test("command shapes group two runs of the same command as one behavior", () => {
  const store = freshStore();
  addIntervention(store, {
    id: "a", ts: "2026-09-01T00:00:00Z", quote: BARE, tool: "Bash",
    detail: "sed -n '1,20p' foo.py",
  });
  addIntervention(store, {
    id: "b", ts: "2026-09-02T00:00:00Z", quote: BARE, tool: "Bash",
    detail: "sed -n '400,420p' bar.py",
  });
  addIntervention(store, {
    id: "c", ts: "2026-09-03T00:00:00Z", quote: BARE, tool: "Bash",
    detail: "git diff --stat",
  });

  assert.deepEqual(stoppedCommandShapes(store), [
    { shape: "sed", count: 2 },
    { shape: "git diff", count: 1 },
  ]);
});

test("a Read path is not a command and is left out of the shapes", () => {
  const store = freshStore();
  addIntervention(store, {
    id: "a", ts: "2026-09-01T00:00:00Z", quote: BARE, tool: "Read",
    detail: "/Users/someone/project/file.py",
  });
  assert.deepEqual(stoppedCommandShapes(store), []);
  assert.deepEqual(recentStoppedCommands(store), []);
});

test("recent stops come back newest first", () => {
  const store = freshStore();
  addIntervention(store, {
    id: "a", ts: "2026-09-01T00:00:00Z", quote: BARE, tool: "Bash", detail: "ls -la",
  });
  addIntervention(store, {
    id: "b", ts: "2026-09-05T00:00:00Z", quote: BARE, tool: "Bash", detail: "git status",
  });
  assert.deepEqual(
    recentStoppedCommands(store).map((row) => row.detail),
    ["git status", "ls -la"],
  );
});

test("a wrapper does not become the shape", () => {
  assert.equal(commandShape("rtk proxy git add -A"), "git add");
  assert.equal(commandShape("cd /some/worktree && rtk git status"), "git status");
  assert.equal(commandShape("sudo lsof -i :8787"), "lsof");
  assert.equal(commandShape("DATABASE_URL=postgres://x uv run pytest"), "uv run");
});

test("a shell expression is labeled rather than parsed into a fake program", () => {
  assert.equal(commandShape('TOKEN=$(cat ~/.token); curl "http://x?t=$TOKEN"'), "(shell expression)");
  assert.equal(commandShape(""), null);
  assert.equal(commandShape(null), null);
});

test("the tool input summary prefers the command, then the path", () => {
  assert.equal(summarizeToolInput({ command: "just  api-lint\n" }), "just api-lint");
  assert.equal(summarizeToolInput({ file_path: "/tmp/a.py" }), "/tmp/a.py");
  assert.equal(summarizeToolInput({ limit: 5 }), null);
  assert.equal(summarizeToolInput(null), null);
});

test("themes bucket the reasoned interventions and report what none matched", () => {
  const store = freshStore();
  addIntervention(store, {
    id: "a", ts: "2026-09-01T00:00:00Z", quote: "i dont want to wait for this",
  });
  addIntervention(store, {
    id: "b", ts: "2026-09-02T00:00:00Z", quote: "you only did context management",
  });
  addIntervention(store, { id: "c", ts: "2026-09-03T00:00:00Z", quote: "zzzzz" });

  const breakdown = themeBreakdown(store);
  assert.equal(breakdown.sampleSize, 3);
  assert.equal(breakdown.unmatched, 1);
  assert.equal(breakdown.themes.find((theme) => theme.id === "impatience").count, 1);
});

test("weekly turns sum the assistant turns of every session in the week", () => {
  const store = freshStore();
  const insert = store.prepare(
    "INSERT INTO sessions (id, cwd, started_at, turn_count) VALUES (?, NULL, ?, ?)",
  );
  insert.run("s1", "2026-09-01T00:00:00Z", 100);
  insert.run("s2", "2026-09-02T00:00:00Z", 50);
  const [week] = weeklyTurns(store);
  assert.equal(week.turnCount, 150);
});

test("the workload denominator separates more work from less autonomy", () => {
  const trend = [
    { week: "2026-W35", humanCount: 4, sessionCount: 4, perSession: 1 },
    { week: "2026-W36", humanCount: 4, sessionCount: 8, perSession: 0.5 },
  ];
  const turns = [
    { week: "2026-W35", turnCount: 400 },
    { week: "2026-W36", turnCount: 400 },
  ];
  const combined = autonomyPerWorkload(trend, turns);
  assert.equal(combined[0].per100Turns, 1);
  assert.equal(combined[1].per100Turns, 1);
});

test("a week with no recorded turns reports no rate rather than a zero", () => {
  const combined = autonomyPerWorkload(
    [{ week: "2026-W20", humanCount: 2, sessionCount: 1, perSession: 2 }],
    [],
  );
  assert.equal(combined[0].per100Turns, null);
});

test("a bare interrupt's reason is the text of the turn that followed it", () => {
  const store = freshStore();
  store
    .prepare(
      `INSERT INTO interventions
         (id, run_id, cwd, ts, kind, quote, preceding_tool, preceding_detail, followup_quote)
       VALUES ('a', 'run-1', NULL, '2026-09-01T00:00:00Z', 'interrupt', ?, 'Bash', NULL, ?)`,
    )
    .run(BARE, "stop polling, run it in the background");

  const quality = interventionQuality(store);
  assert.equal(quality.withReason, 1);
  assert.equal(quality.bareInterrupts, 0);
  assert.equal(quality.statedInTheNextTurn, 1);
});

test("a stop with neither text nor a follow-up stays reasonless", () => {
  const store = freshStore();
  addIntervention(store, { id: "a", ts: "2026-09-01T00:00:00Z", quote: BARE });
  assert.equal(interventionQuality(store).bareInterrupts, 1);
});

test("a turn's own text is preferred over the one after it", () => {
  assert.equal(reasonFor({ quote: "no, wrong table", followup_quote: "later" }), "no, wrong table");
  assert.equal(reasonFor({ quote: BARE, followup_quote: "the reason" }), "the reason");
  assert.equal(reasonFor({ quote: BARE, followup_quote: null }), null);
});

test("a slash command or a resume is not a reason", () => {
  assert.equal(followupReason("/login</command-name> <command-message>login"), null);
  assert.equal(followupReason("Continue from where you left off."), null);
  assert.equal(followupReason("ok"), null);
  assert.equal(followupReason("[Request interrupted by user]"), null);
  assert.equal(followupReason("stop polling, run it in the background"), "stop polling, run it in the background");
});
