#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { CONFIG_PATH, KILL_SWITCH_PATH, loadConfig, readOrCreateToken } from "../src/config.mjs";

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

function printStats(stats) {
  process.stdout.write(
    `runs=${stats.runCount} agents=${stats.nodeCount} ` +
      `multi-agent=${stats.multiAgentRunCount} never-parallel=${stats.sequentialRunCount}\n` +
      `tokens=${stats.totalTokens.toLocaleString()} ` +
      `spend~${formatUsd(stats.totalCostUsd)} ` +
      `(${formatUsd(stats.totalCostLowUsd)}–${formatUsd(stats.totalCostHighUsd)}, ` +
      `combined totals split at an assumed 90% input) ` +
      `serialized=${formatMinutes(stats.sequentialSerializedMs)}\n\nby agent type\n`,
  );
  for (const bucket of stats.byAgentType) {
    process.stdout.write(
      `  ${bucket.key.padEnd(26)} n=${String(bucket.count).padStart(3)} ` +
        `${formatUsd(bucket.costUsd).padStart(8)}  ${formatMinutes(bucket.durationMs)}\n`,
    );
  }
  process.stdout.write("\nrepeated shapes (harvest candidates)\n");
  for (const bucket of stats.repeatedSequences) {
    process.stdout.write(
      `  runs=${bucket.runs} never-parallel=${bucket.sequentialRuns} ` +
        `serialized=${formatMinutes(bucket.serializedMs)}  ${bucket.shape}\n`,
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
      printRunDetail(await callDaemon(`/v1/runs/${encodeURIComponent(argument ?? "")}`));
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
    case "lessons":
      printLessons((await callDaemon("/v1/lessons")).lessons);
      break;
    case "accept":
      process.stdout.write(`${JSON.stringify(await postDaemon("/v1/lessons/accept", { rule: process.argv.slice(3).join(" ") }))}\n`);
      break;
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
