#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { CONFIG_PATH, KILL_SWITCH_PATH, loadConfig, readOrCreateToken } from "../src/config.mjs";
import { describeRunLookupFailure } from "../src/routes.mjs";

const DEFAULT_LIMIT = 20;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60_000;
const USAGE = `graph — inspect graphd

  graph runs [limit]      recent runs, declared shape vs what ran
  graph show <run-id>     nodes, edges, and the declared/observed diff
  graph checks [limit]    policy evaluations, including shadow would-denies
  graph library           saved workflows and unreviewed candidates
  graph promote <id>      register a candidate as a by-name workflow
  graph reject <id>       move a candidate out of the registry (reversible)
  graph stats             shape, serialized agent-time, and token spend across all runs
  graph trend             per week: runs that ran in parallel, avg concurrency, serialized time, spend
  graph lessons           human interventions, self-corrections, autonomy trend
  graph accept <rule>     accept a harvested lesson; every agent reads it from then on
  graph rules             accepted lessons currently injected into agent prompts
  graph decisions         proposals waiting on a human accept/reject
  graph decide <id> <accepted|rejected>
  graph propose <file.json>  file a harvest's proposals: {"proposals":[…]}
  graph doctor            check hooks, token, launch agent, enforcement readiness
  graph enforce <on|off>  flip blocking in config.json
  graph pause             create the kill switch (disables all denies)
  graph resume            remove the kill switch
  graph health            daemon status
`;

function baseUrl() {
  return process.env.GRAPHD_URL ?? "http://127.0.0.1:8787";
}

async function callDaemon(path) {
  const response = await fetch(`${baseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${readOrCreateToken()}` },
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postDaemon(path, body) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readOrCreateToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function formatSeconds(milliseconds) {
  if (!milliseconds) return "-";
  return `${(milliseconds / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
}

function printRuns(runs) {
  for (const run of runs) {
    const flag = run.isMismatch ? "MISMATCH" : run.isUndeclared ? "undeclared" : "ok";
    process.stdout.write(
      `${run.started_at}  ${run.id.slice(0, 8)}  nodes=${run.node_count}  ` +
        `peak=${run.peakConcurrency}  declared=${run.declared_shape ?? "-"}  ` +
        `ran=${run.observedShape}  idle=${formatSeconds(run.serializationCostMs)}  ${flag}\n`,
    );
  }
}

function printRunDetail(detail) {
  if (!detail) throw new Error("run not found");
  const { run, nodes, edges, diff, parallelism, batches } = detail;
  const batchOf = new Map();
  for (const batch of batches ?? []) for (const id of batch.nodeIds) batchOf.set(id, batch);
  process.stdout.write(`run ${run.id}\n  cwd ${run.cwd ?? "-"}\n`);
  process.stdout.write(
    `  declared=${diff.declaredShape ?? "-"} ran=${diff.observedShape} ` +
      `peak=${diff.peakConcurrency} serialized=${formatSeconds(diff.serializationCostMs)}\n`,
  );
  if (parallelism) {
    process.stdout.write(
      `  parallelism=${parallelism.verdict} ` +
        `(${parallelism.achievedCount}/${parallelism.measuredCount} measured fan-outs, ` +
        `${parallelism.unmeasurableNodeCount} unmeasurable)\n`,
    );
  }
  for (const node of nodes) {
    const tokens = node.total_tokens ? ` ${node.total_tokens.toLocaleString()}tok` : "";
    const workedMs = node.true_duration_ms ?? (node.is_async ? null : node.duration_ms);
    const batch = batchOf.get(node.id);
    const fanout = batch && batch.size > 1 ? `b${batch.index + 1}x${batch.size}` : "  solo ";
    process.stdout.write(
      `  - ${fanout} ${node.tool}/${node.agent_type ?? "?"} ${node.label ?? ""} ` +
        `[${node.status} ${workedMs === null ? "end unknown" : formatSeconds(workedMs)}${tokens} ` +
        `${node.resolved_model ?? node.model ?? "inherited"}]\n`,
    );
  }
  for (const edge of edges) {
    process.stdout.write(`  ${edge.kind}: ${edge.from_ref} -> ${edge.to_ref} (${edge.carries ?? "?"})\n`);
  }
}

function printChecks(checks) {
  for (const check of checks) {
    const outcome = check.enforced ? "DENIED" : check.would_deny ? "would-deny" : "allow";
    process.stdout.write(`${check.ts}  ${check.tool}  ${check.rule}  ${outcome}\n`);
  }
}

function printWorkflows(workflows) {
  for (const workflow of workflows) {
    const state = workflow.isCandidate ? "CANDIDATE" : "registered";
    process.stdout.write(
      `${state.padEnd(10)} ${(workflow.name ?? workflow.id).padEnd(28)} ` +
        `runs=${workflow.runCount}  ${workflow.lineCount} lines  ${workflow.description ?? ""}\n`,
    );
    if (workflow.provenance) process.stdout.write(`           ${workflow.provenance}\n`);
  }
  if (workflows.length === 0) process.stdout.write("no workflows\n");
}

function printProposals(proposals) {
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  for (const proposal of pending) {
    const applied = proposal.applies?.rule ?? proposal.applies?.command ?? proposal.applies?.note;
    process.stdout.write(`\n[${proposal.kind}] ${proposal.id}\n  ${proposal.title}\n`);
    process.stdout.write(`  why: ${proposal.why}\n  applies: ${applied}\n`);
  }
  if (pending.length === 0) process.stdout.write("nothing pending\n");
  for (const proposal of proposals.filter((candidate) => candidate.status !== "pending")) {
    process.stdout.write(`${proposal.status.padEnd(9)} ${proposal.id}\n`);
  }
}

function formatMinutes(milliseconds) {
  return `${(milliseconds / MILLISECONDS_PER_MINUTE).toFixed(1)}m`;
}

function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}

const PROJECT_ROWS = 8;

/** Spend per project, as far as spine attributed the sessions that produced it. */
function printProjectSpend(projectSpend) {
  if (!projectSpend) return;
  process.stdout.write("\nby project\n");
  for (const project of projectSpend.projects.slice(0, PROJECT_ROWS)) {
    process.stdout.write(
      `  ${project.slug.padEnd(24)} n=${String(project.nodeCount).padEnd(5)} ` +
        `${project.tokens.toLocaleString()} tokens across ${project.sessionCount} session(s)\n`,
    );
  }
  const writeBucket = (name, nodeCount, tokens, note) => {
    if (nodeCount === 0) return;
    process.stdout.write(
      `  ${name.padEnd(24)} n=${String(nodeCount).padEnd(5)} ${tokens.toLocaleString()} tokens — ${note}\n`,
    );
  };
  writeBucket(
    "(tied)",
    projectSpend.ambiguousNodes,
    projectSpend.ambiguousTokens,
    `spine could not choose between ${projectSpend.ambiguousCandidates?.join(", ") || "its candidates"}`,
  );
  writeBucket(
    "(unattributed)",
    projectSpend.unattributedNodes,
    projectSpend.unattributedTokens,
    "spine has no pick for the session: no registered project matched its folder, or spine never saw it",
  );
}

function printStats(stats) {
  process.stdout.write(
    `runs=${stats.runCount} agents=${stats.nodeCount} (+${stats.workflowAgentCount ?? 0} inside workflows) ` +
      `multi-agent=${stats.multiAgentRunCount} parallel=${stats.parallelRunCount ?? "-"} ` +
      `never-parallel=${stats.sequentialRunCount} ` +
      `avg-concurrency=${stats.averageConcurrency == null ? "-" : stats.averageConcurrency.toFixed(2)}\n` +
      `tokens=${stats.totalTokens.toLocaleString()} ` +
      `spend~${formatUsd(stats.totalCostUsd)} ` +
      `(${formatUsd(stats.totalCostLowUsd)}–${formatUsd(stats.totalCostHighUsd)}, ` +
      `combined totals split at an assumed 90% input) ` +
      `serialized=${formatMinutes(stats.sequentialSerializedMs)}\n`,
  );
  printProjectSpend(stats.projectSpend);
  process.stdout.write("\nby agent type\n");
  for (const bucket of stats.byAgentType) {
    process.stdout.write(
      `  ${bucket.key.padEnd(26)} n=${String(bucket.count).padStart(3)} ` +
        `${formatUsd(bucket.costUsd).padStart(8)}  ` +
        `${bucket.untimedCount === bucket.count ? "-" : formatMinutes(bucket.durationMs)}\n`,
    );
  }
  if (stats.byWorkflowAgentType?.length) {
    process.stdout.write("\ninside workflows (spend is on the Workflow row)\n");
    for (const bucket of stats.byWorkflowAgentType) {
      process.stdout.write(`  ${bucket.key.padEnd(26)} n=${String(bucket.count).padStart(3)}  ${formatMinutes(bucket.durationMs)}\n`);
    }
  }
  process.stdout.write("\nrepeated shapes (harvest candidates)\n");
  for (const bucket of stats.repeatedSequences) {
    process.stdout.write(
      `  runs=${bucket.runs} never-parallel=${bucket.sequentialRuns} ` +
        `serialized=${formatMinutes(bucket.serializedMs)}  ${bucket.shape}\n`,
    );
  }
}

/** One row per week; parallel is "ran in parallel / used 2+ agents". */
function printTrend(weeks) {
  process.stdout.write("week       runs  parallel  avg-conc  serialized  declared  spend    human/session\n");
  for (const week of weeks) {
    const perSession = week.humanInterventionsPerSession;
    process.stdout.write(
      `${week.week.padEnd(9)}  ${String(week.runs).padStart(4)}  ` +
        `${`${week.parallelRuns}/${week.multiAgentRuns}`.padStart(8)}  ` +
        `${(week.averageConcurrency == null ? "-" : week.averageConcurrency.toFixed(2)).padStart(8)}  ` +
        `${formatMinutes(week.serializedMs).padStart(10)}  ` +
        `${`${week.declaredRuns}/${week.multiAgentRuns}`.padStart(8)}  ` +
        `${formatUsd(week.costUsd).padStart(7)}  ` +
        `${perSession == null ? "-" : perSession.toFixed(2)}\n`,
    );
  }
}

function printLessons(lessons) {
  const byKind = Object.fromEntries(lessons.counts.map((row) => [row.kind, row.count]));
  process.stdout.write(
    `interventions=${lessons.total}  interrupts=${byKind.interrupt ?? 0} ` +
      `corrections=${byKind.correction ?? 0} self-corrections=${byKind.self_correction ?? 0}\n\n` +
      `autonomy — human interventions per session, by week (self-corrections shown apart)\n`,
  );
  for (const week of lessons.trend) {
    process.stdout.write(
      `  ${week.week}  ${week.perSession.toFixed(2).padStart(5)} ` +
        `(${week.humanCount} over ${week.sessionCount} sessions)` +
        `   self-corr ${week.selfCorrectionPerSession.toFixed(2)} (${week.selfCorrectionCount})\n`,
    );
  }
  process.stdout.write("\nwhere autonomy broke — tool running when you stepped in\n");
  for (const surface of lessons.surfaces) {
    process.stdout.write(`  ${String(surface.count).padStart(3)}  ${surface.surface}\n`);
  }
  process.stdout.write("\nrecent\n");
  for (const entry of lessons.recent) {
    process.stdout.write(`  [${entry.kind}] ${entry.ts.slice(0, 10)} ${entry.quote}\n`);
  }
}

const SURFACE_ROWS = 6;
const SHAPE_ROWS = 8;
const DETAIL_ROWS = 6;
const DETAIL_WIDTH = 96;

/** Where the reasonless stops land: by tool, by command shape, and the last few verbatim. */
function printStoppedWork(surfaces, shapes, recent) {
  process.stdout.write("\nwhere the reasonless stops happen\n");
  for (const row of surfaces.slice(0, SURFACE_ROWS)) {
    process.stdout.write(`  ${String(row.count).padStart(3)}  ${row.surface}\n`);
  }
  if (shapes.length > 0) {
    process.stdout.write("\nwhat was running when stopped\n");
    for (const row of shapes.slice(0, SHAPE_ROWS)) {
      process.stdout.write(`  ${String(row.count).padStart(3)}  ${row.shape}\n`);
    }
  }
  if (recent.length > 0) {
    process.stdout.write("\nthe last few, verbatim\n");
    for (const row of recent.slice(0, DETAIL_ROWS)) {
      process.stdout.write(`  ${row.ts.slice(0, 10)}  ${row.detail.slice(0, DETAIL_WIDTH)}\n`);
    }
  }
}

function printEvaluation(evaluation) {
  const { quality, bareInterruptSurfaces, stoppedCommandShapes, recentStoppedCommands, themes, power, trend } =
    evaluation;
  const share = (part) => (quality.total > 0 ? Math.round((part / quality.total) * 100) : 0);

  process.stdout.write("what the intervention record is made of\n");
  process.stdout.write(
    `  ${quality.total} human interventions\n` +
      `  ${quality.bareInterrupts} (${share(quality.bareInterrupts)}%) bare interrupts — a stop, with no reason recorded\n` +
      `  ${quality.withReason} (${share(quality.withReason)}%) carry text, of which ${quality.distinctReasons} are distinct\n`,
  );
  if (quality.duplicateReasons > 0) {
    process.stdout.write(`  ${quality.duplicateReasons} duplicate quote(s) — the same event counted twice\n`);
  }

  printStoppedWork(bareInterruptSurfaces, stoppedCommandShapes, recentStoppedCommands);

  process.stdout.write(`\nthemes among the ${themes.sampleSize} that say why\n`);
  for (const theme of themes.themes) {
    if (theme.count === 0) continue;
    process.stdout.write(`  ${String(theme.count).padStart(3)}  ${theme.label}\n`);
  }
  if (themes.unmatched > 0) {
    process.stdout.write(`  ${String(themes.unmatched).padStart(3)}  (no theme matched)\n`);
  }

  process.stdout.write("\ncan we judge whether an accepted rule worked?\n");
  if (power.isPowered) {
    process.stdout.write(`  yes — ${power.sampleSize} reasoned interventions over ${power.spanDays} days\n`);
  } else {
    process.stdout.write(
      `  NO. ${power.acceptedRuleCount} rules accepted, but only ${power.sampleSize} reasoned\n` +
        `  interventions exist over ${power.spanDays} days (${power.ratePerWeek.toFixed(1)}/week).\n` +
        `  A before/after rate needs ~${power.shortfall} more before it means anything.\n` +
        `  Until then no rule can be shown to work, and none can be shown not to.\n`,
    );
  }

  process.stdout.write("\nautonomy — per session, and per 100 assistant turns\n");
  for (const row of trend) {
    if (row.humanCount === 0 && row.turnCount === 0) continue;
    const perTurns = row.per100Turns == null ? "  n/a" : row.per100Turns.toFixed(2).padStart(5);
    process.stdout.write(
      `  ${row.week}  per-session ${row.perSession.toFixed(2).padStart(5)}  per-100-turns ${perTurns}` +
        `   (${row.humanCount} over ${row.sessionCount} sessions / ${row.turnCount} turns)\n`,
    );
  }
}

function printDiagnostics(checks) {
  const marks = { pass: "✓", warn: "⚠", fail: "✕" };
  for (const entry of checks) {
    process.stdout.write(`${marks[entry.status]} ${entry.name.padEnd(20)} ${entry.detail}\n`);
  }
}

function setEnforcement(isEnabled) {
  const config = loadConfig();
  config.enforce = isEnabled;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`enforce=${isEnabled}\n`);
}

/** Run detail by full id or by the 8-character prefix `graph runs` prints. */
async function showRun(runIdOrPrefix) {
  if (!runIdOrPrefix) throw new Error("usage: graph show <run-id, or the prefix graph runs prints>");
  let detail;
  try {
    detail = await callDaemon(`/v1/runs/${encodeURIComponent(runIdOrPrefix)}`);
  } catch (error) {
    const description = describeRunLookupFailure(error.message, runIdOrPrefix);
    throw description ? new Error(description) : error;
  }
  printRunDetail(detail);
}

// Piping to head/less closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const [command, argument] = process.argv.slice(2);
const limit = Number.parseInt(argument ?? "", 10) || DEFAULT_LIMIT;

try {
  switch (command) {
    case "runs":
      printRuns((await callDaemon(`/v1/runs?limit=${limit}`)).runs);
      break;
    case "show":
      await showRun(argument);
      break;
    case "checks":
      printChecks((await callDaemon(`/v1/policy/checks?limit=${limit}`)).checks);
      break;
    case "library":
      printWorkflows((await callDaemon("/v1/workflows")).workflows);
      break;
    case "promote":
      process.stdout.write(`${JSON.stringify(await postDaemon("/v1/workflows/promote", { id: argument }))}\n`);
      break;
    case "reject":
      process.stdout.write(`${JSON.stringify(await postDaemon("/v1/workflows/reject", { id: argument }))}\n`);
      break;
    case "stats":
      printStats((await callDaemon("/v1/stats")).stats);
      break;
    case "trend":
      printTrend((await callDaemon("/v1/trend")).weeks);
      break;
    case "lessons":
      printLessons((await callDaemon("/v1/lessons")).lessons);
      break;
    case "eval":
      printEvaluation((await callDaemon("/v1/evaluation")).evaluation);
      break;
    case "accept": {
      // A flag is never a rule: `graph accept --help` used to file "--help" as a lesson and
      // inject it into every agent prompt.
      const rule = process.argv.slice(3).join(" ").trim();
      if (!rule || rule.startsWith("-")) {
        process.stderr.write("usage: graph accept <rule text>\n");
        process.exitCode = 1;
        break;
      }
      process.stdout.write(`${JSON.stringify(await postDaemon("/v1/lessons/accept", { rule }))}\n`);
      break;
    }
    case "rules":
      for (const rule of (await callDaemon("/v1/lessons/accepted")).rules) {
        process.stdout.write(`- ${rule}\n`);
      }
      break;
    case "decisions":
      printProposals((await callDaemon("/v1/proposals")).proposals);
      break;
    case "propose":
      process.stdout.write(
        `${JSON.stringify(await postDaemon("/v1/proposals", JSON.parse(readFileSync(argument, "utf8"))))}\n`,
      );
      break;
    case "decide":
      process.stdout.write(
        `${JSON.stringify(await postDaemon("/v1/proposals/decide", { id: argument, status: process.argv[4] }))}\n`,
      );
      break;
    case "doctor":
      printDiagnostics((await callDaemon("/v1/doctor")).checks);
      break;
    case "enforce":
      setEnforcement(argument === "on");
      break;
    case "pause":
      writeFileSync(KILL_SWITCH_PATH, "");
      process.stdout.write(`paused: ${KILL_SWITCH_PATH}\n`);
      break;
    case "resume":
      if (existsSync(KILL_SWITCH_PATH)) unlinkSync(KILL_SWITCH_PATH);
      process.stdout.write("resumed\n");
      break;
    case "health":
      process.stdout.write(`${JSON.stringify(await callDaemon("/v1/health"))}\n`);
      break;
    default:
      process.stdout.write(USAGE);
      if (existsSync(CONFIG_PATH)) process.stdout.write(`\nconfig: ${readFileSync(CONFIG_PATH, "utf8")}`);
  }
} catch (error) {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
}
