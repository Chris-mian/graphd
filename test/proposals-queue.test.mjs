import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tasksPath = join(mkdtempSync(join(tmpdir(), "graphd-nightshift-")), "TASKS.md");
process.env.GRAPHD_NIGHTSHIFT_TASKS_PATH = tasksPath;
const { queueForNightShift } = await import("../src/proposals.mjs");

test("an accepted manual proposal is filed as a night-shift task", () => {
  writeFileSync(tasksPath, "# Night shift tasks\n");
  const result = queueForNightShift({
    id: "harvest-detector-precision",
    title: "Tighten the intervention detector",
    applies: { type: "manual", note: "Code change in src/interventions.mjs." },
  });
  assert.equal(result.queued, true);
  const written = readFileSync(tasksPath, "utf8");
  assert.match(written, /- \[todo\] \[graphd-proposals\] Tighten the intervention detector/);
  assert.match(written, /From graphd proposal `harvest-detector-precision`/);
  assert.match(written, /Code change in src\/interventions\.mjs\./);
});

test("no task list means the proposal still reports needing follow-up", () => {
  process.env.GRAPHD_NIGHTSHIFT_TASKS_PATH = join(tmpdir(), "graphd-nightshift-absent", "TASKS.md");
  const absent = queueForNightShift({ id: "x", title: "y", applies: { type: "manual" } });
  assert.equal(absent.queued, false);
  assert.equal(absent.needsFollowUp, true);
  process.env.GRAPHD_NIGHTSHIFT_TASKS_PATH = tasksPath;
});
