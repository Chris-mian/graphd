import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScheduledJobs } from "../src/doctor.mjs";

const HOURS_AGO_13 = 13 * 3_600_000;

test("a job whose log has gone stale is reported, a current one is not", () => {
  const directory = mkdtempSync(join(tmpdir(), "graphd-jobs-"));
  const currentLog = join(directory, "current.log");
  writeFileSync(currentLog, "ran\n");
  const jobs = [{ name: "import", logPath: currentLog, maxAgeHours: 12 }];

  assert.equal(checkScheduledJobs(jobs).status, "pass");
  assert.equal(checkScheduledJobs(jobs, Date.now() + HOURS_AGO_13).status, "warn");
});

test("a job that has never written a log is reported as never run", () => {
  const jobs = [{ name: "harvest", logPath: join(tmpdir(), "graphd-absent.log"), maxAgeHours: 1 }];
  const finding = checkScheduledJobs(jobs);
  assert.equal(finding.status, "warn");
  assert.match(finding.detail, /never run/);
});
