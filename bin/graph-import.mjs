#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classifyTargetRef,
  insertResumption,
  openStore,
  pruneSupersededHookNodes,
  recordTaskCompletion,
} from "../src/db.mjs";
import { readWorkflowChildren, unionMs } from "../src/workflowchildren.mjs";
import { parseTaskNotifications } from "../src/tasknotify.mjs";
import {
  INTERVENTION_KINDS,
  classifyAssistantText,
  classifyHumanTurn,
  followupReason,
  matchedSentence,
  summarizeToolInput,
  toQuote,
} from "../src/interventions.mjs";

const TRANSCRIPT_ROOT = join(homedir(), ".claude", "projects");
const SPAWN_TOOL_NAMES = new Set(["Agent", "Task", "Workflow"]);
const RESUME_TOOL_NAME = "SendMessage";
const SUBAGENT_DIR_NAME = "subagents";
const PROMPT_SHA_LENGTH = 16;
const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_TEXT_CHARS = 4000;

/**
 * Working directories that are test scratch rather than real work. romp's own suite replays
 * recorded turns through a scratch checkout, so those transcripts carry synthetic interrupts and
 * duplicates of prompts already counted under their real session.
 */
const EXCLUDED_CWD_PATTERNS = [/\/judge-scratch(\/|$)/, /\/\.local\/state\/romp\//, /\/romp-tests?-/];

/** Whether a transcript's working directory is test scratch and must not be measured. */
export function isScratchCwd(cwd) {
  return typeof cwd === "string" && EXCLUDED_CWD_PATTERNS.some((pattern) => pattern.test(cwd));
}

// A persisted script is saved as <name>-wf_<run id>.js, a library script as <name>.js.
const SCRIPT_PATH_NAME_PATTERN = /([^/]+?)(?:-wf_[\w-]+)?\.js$/;

/** The workflow name in a Workflow call's scriptPath, or null. */
function workflowNameFromScriptPath(scriptPath) {
  return typeof scriptPath === "string" ? (SCRIPT_PATH_NAME_PATTERN.exec(scriptPath)?.[1] ?? null) : null;
}

function promptSha(sessionId, tool, prompt) {
  return createHash("sha256")
    .update(`${sessionId}|${tool}|${prompt ?? ""}`)
    .digest("hex")
    .slice(0, PROMPT_SHA_LENGTH);
}

/** Every `.jsonl` directly under `dir`, or [] when the directory is missing. */
function jsonlPathsIn(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .map((fileName) => join(dir, fileName));
}

/**
 * Main-thread transcripts plus the per-agent transcripts under each session's `subagents/`.
 * Subagent transcripts hold the only record of an agent messaging a peer or its lead.
 */
function transcriptPaths() {
  if (!statSync(TRANSCRIPT_ROOT, { throwIfNoEntry: false })) return [];
  return readdirSync(TRANSCRIPT_ROOT).flatMap((projectDir) => {
    const projectPath = join(TRANSCRIPT_ROOT, projectDir);
    if (!statSync(projectPath).isDirectory()) return [];
    const mainPaths = jsonlPathsIn(projectPath);
    const subagentPaths = readdirSync(projectPath).flatMap((sessionDir) => {
      const subagentPath = join(projectPath, sessionDir, SUBAGENT_DIR_NAME);
      return jsonlPathsIn(subagentPath);
    });
    return [...mainPaths, ...subagentPaths];
  });
}

/**
 * Collects the session, spawn records, their results, human/agent interventions, and
 * messages sent to already-running agents.
 */
function parseTranscript(path) {
  const spawns = [];
  const resultsByToolUseId = new Map();
  const interventions = [];
  const resumptions = [];
  const entries = [];
  let lastToolName = null;
  let lastToolDetail = null;
  const awaitingReason = [];
  const session = { id: null, cwd: null, startedAt: null, endedAt: null, turnCount: 0 };

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    entries.push(entry);
    if (!entry.isSidechain) {
      session.id ??= entry.sessionId ?? entry.session_id ?? null;
      session.cwd ??= entry.cwd ?? null;
      if (entry.timestamp) {
        session.startedAt ??= entry.timestamp;
        session.endedAt = entry.timestamp;
      }
    }
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];

    if (entry.type === "user" && !entry.isSidechain) {
      const kind = classifyHumanTurn(entry.message?.content);
      if (kind !== INTERVENTION_KINDS.INTERRUPT && awaitingReason.length > 0) {
        const reason = followupReason(entry.message?.content);
        if (reason) {
          for (const pending of awaitingReason) pending.followupQuote = reason;
          awaitingReason.length = 0;
        }
      }
      if (kind) {
        interventions.push({
          id: entry.uuid,
          runId: entry.sessionId ?? entry.session_id,
          cwd: entry.cwd ?? null,
          ts: entry.timestamp,
          kind,
          quote: toQuote(entry.message.content),
          precedingTool: lastToolName,
          precedingDetail: lastToolDetail,
          followupQuote: null,
        });
        if (kind === INTERVENTION_KINDS.INTERRUPT) {
          awaitingReason.push(interventions[interventions.length - 1]);
        }
      }
    }
    if (entry.type === "assistant" && !entry.isSidechain) {
      session.turnCount += 1;
      for (const block of blocks) {
        if (block.type !== "text") continue;
        const kind = classifyAssistantText(block.text);
        if (!kind) continue;
        interventions.push({
          id: entry.uuid,
          runId: entry.sessionId ?? entry.session_id,
          cwd: entry.cwd ?? null,
          ts: entry.timestamp,
          kind,
          quote: matchedSentence(block.text),
          precedingTool: lastToolName,
          precedingDetail: lastToolDetail,
        });
        break;
      }
    }

    for (const block of blocks) {
      if (block.type === "tool_use" && SPAWN_TOOL_NAMES.has(block.name)) {
        spawns.push({
          toolUseId: block.id,
          sessionId: entry.sessionId ?? entry.session_id,
          cwd: entry.cwd ?? null,
          startedAt: entry.timestamp,
          tool: block.name,
          agentType: block.input?.subagent_type ?? null,
          label:
            block.input?.description ??
            block.input?.name ??
            workflowNameFromScriptPath(block.input?.scriptPath),
          name: block.input?.name ?? null,
          model: block.input?.model ?? null,
          prompt: block.input?.prompt ?? "",
        });
      }
      if (block.type === "tool_use" && block.name === RESUME_TOOL_NAME) {
        const targetRef = block.input?.to ?? null;
        resumptions.push({
          id: block.id,
          runId: entry.sessionId ?? entry.session_id,
          ts: entry.timestamp,
          targetRef,
          targetKind: classifyTargetRef(targetRef),
          sender: entry.agentId ? "agent" : "lead",
          senderRef: entry.agentId ?? entry.agentName ?? null,
        });
      }
      if (block.type === "tool_use") {
        lastToolName = block.name;
        lastToolDetail = summarizeToolInput(block.input);
      }
      if (block.type === "tool_result" && entry.toolUseResult) {
        resultsByToolUseId.set(block.tool_use_id, {
          endedAt: entry.timestamp,
          result: entry.toolUseResult,
        });
      }
    }
  }
  return { session, spawns, resultsByToolUseId, interventions, resumptions, entries };
}

/** Older transcripts carry no totalDurationMs; the result timestamp still bounds the node. */
function durationFor(spawn, completion, result) {
  if (result.totalDurationMs) return result.totalDurationMs;
  if (!completion?.endedAt) return null;
  const elapsed = Date.parse(completion.endedAt) - Date.parse(spawn.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function taskIdFrom(outputFile) {
  if (!outputFile) return null;
  return outputFile.split("/").pop()?.split(".")[0] ?? null;
}

function resultTextFrom(result) {
  const { content } = result;
  if (!content) return null;
  const text = Array.isArray(content)
    ? content.map((block) => block.text ?? "").join("\n")
    : String(content);
  return text.slice(0, MAX_TEXT_CHARS) || null;
}

function insertSpawn(store, spawn, completion) {
  const result = completion?.result ?? {};
  const isAsync = result.isAsync ? 1 : 0;
  store
    .prepare(
      `INSERT INTO runs (id, session_id, cwd, source, started_at)
       VALUES (?, ?, ?, 'backfill', ?)
       ON CONFLICT (id) DO UPDATE SET cwd = COALESCE(excluded.cwd, runs.cwd)`,
    )
    .run(spawn.sessionId, spawn.sessionId, spawn.cwd, spawn.startedAt);

  const toolCallMs = durationFor(spawn, completion, result);
  store
    .prepare(
      `INSERT INTO nodes
         (id, run_id, tool, agent_type, label, name, model, prompt_sha, started_at, ended_at,
          status, duration_ms, agent_id, resolved_model, total_tokens, tool_use_count,
          task_id, output_file, is_async, true_duration_ms, prompt_text, result_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         label            = COALESCE(nodes.label, excluded.label),
         name             = COALESCE(excluded.name, nodes.name),
         task_id          = COALESCE(excluded.task_id, nodes.task_id),
         output_file      = COALESCE(excluded.output_file, nodes.output_file),
         is_async         = excluded.is_async,
         true_duration_ms = COALESCE(nodes.true_duration_ms, excluded.true_duration_ms),
         prompt_text      = COALESCE(excluded.prompt_text, nodes.prompt_text),
         result_text      = COALESCE(excluded.result_text, nodes.result_text)`,
    )
    .run(
      spawn.toolUseId,
      spawn.sessionId,
      spawn.tool,
      result.agentType ?? spawn.agentType,
      // An inline or scriptPath Workflow call carries no description; its result names the script.
      spawn.label ?? result.workflowName ?? null,
      spawn.name ?? null,
      spawn.model,
      promptSha(spawn.sessionId, spawn.tool, spawn.prompt),
      spawn.startedAt,
      completion?.endedAt ?? null,
      result.status ?? (completion ? "ok" : "unknown"),
      toolCallMs,
      result.agentId ?? null,
      result.resolvedModel ?? null,
      result.totalTokens ?? null,
      result.totalToolUseCount ?? null,
      taskIdFrom(result.outputFile),
      result.outputFile ?? null,
      isAsync,
      isAsync ? null : toolCallMs,
      (spawn.prompt ?? "").slice(0, MAX_TEXT_CHARS) || null,
      resultTextFrom(result),
    );
}

/**
 * One node per agent a Workflow ran, parented to the Workflow node. Children carry timing only:
 * the Workflow node keeps the runtime's token total, so spend is not counted twice. The parent's
 * duration becomes the union of its children's active spans. Returns the child count.
 */
function insertWorkflowChildren(store, { spawn, transcriptDir, workflowRunId }) {
  const children = readWorkflowChildren(transcriptDir);
  if (children.length === 0) return 0;
  const runKey = workflowRunId ?? spawn.toolUseId;
  // A forked session repeats its parent's history, so the same Workflow can appear under two
  // sessions. Children go wherever the parent row already lives.
  const runId = store.prepare("SELECT run_id FROM nodes WHERE id = ?").get(spawn.toolUseId)?.run_id ?? spawn.sessionId;
  const upsert = store.prepare(
    `INSERT INTO nodes
       (id, run_id, parent_node_id, tool, agent_type, label, model, started_at, ended_at, status,
        duration_ms, true_duration_ms, agent_id, is_async)
     VALUES (?, ?, ?, 'Agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (id) DO UPDATE SET
       run_id           = excluded.run_id,
       parent_node_id   = excluded.parent_node_id,
       agent_type       = excluded.agent_type,
       label            = excluded.label,
       model            = excluded.model,
       ended_at         = excluded.ended_at,
       status           = excluded.status,
       duration_ms      = excluded.duration_ms,
       true_duration_ms = excluded.true_duration_ms`,
  );
  for (const child of children) {
    upsert.run(
      `wf:${runKey}:${child.agentId}`,
      runId,
      spawn.toolUseId,
      child.agentType,
      child.label,
      child.model,
      child.startedAt,
      child.endedAt,
      child.isFinished ? "ok" : "running",
      Date.parse(child.endedAt) - Date.parse(child.startedAt),
      child.activeMs,
      child.agentId,
    );
  }
  store
    .prepare("UPDATE nodes SET true_duration_ms = ? WHERE id = ?")
    .run(unionMs(children.flatMap((child) => child.segments)), spawn.toolUseId);
  return children.length;
}

function hasRunningChild(store, parentNodeId) {
  return Boolean(
    store.prepare("SELECT 1 FROM nodes WHERE parent_node_id = ? AND status = 'running' LIMIT 1").get(parentNodeId),
  );
}

function upsertSession(store, session) {
  store
    .prepare(
      `INSERT INTO sessions (id, cwd, started_at, ended_at, turn_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         cwd        = COALESCE(excluded.cwd, sessions.cwd),
         ended_at   = MAX(COALESCE(sessions.ended_at, ''), COALESCE(excluded.ended_at, '')),
         turn_count = MAX(sessions.turn_count, excluded.turn_count)`,
    )
    .run(session.id, session.cwd, session.startedAt, session.endedAt, session.turnCount);
}

function insertIntervention(store, intervention) {
  store
    .prepare(
      `INSERT INTO interventions
         (id, run_id, cwd, ts, kind, quote, preceding_tool, preceding_detail, followup_quote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      intervention.id,
      intervention.runId,
      intervention.cwd,
      intervention.ts,
      intervention.kind,
      intervention.quote,
      intervention.precedingTool,
      intervention.precedingDetail ?? null,
      intervention.followupQuote ?? null,
    );
}

const requestedDays = Number.parseInt(process.argv[2] ?? "", 10);
const cutoffMs = Number.isFinite(requestedDays)
  ? Date.now() - requestedDays * MILLISECONDS_PER_DAY
  : 0;

const store = openStore();
let importedNodes = 0;
let scannedTranscripts = 0;
let importedInterventions = 0;
let reconciledCompletions = 0;
let skippedScratch = 0;

// Resumptions resolve their target against `nodes`, so they are applied after every transcript
// has contributed its spawns; a message can otherwise arrive before the node it points at.
const pendingResumptions = [];
// Workflow children are applied after every notification, so a parent's duration from its
// children is not overwritten by the runtime's own figure, which counts suspended time.
const workflowParents = new Map();

store.exec("BEGIN");
for (const path of transcriptPaths()) {
  const { session, spawns, resultsByToolUseId, interventions, resumptions, entries } =
    parseTranscript(path);
  if (isScratchCwd(session.cwd)) {
    skippedScratch += 1;
    continue;
  }
  scannedTranscripts += 1;
  if (session.id && session.startedAt && Date.parse(session.startedAt) >= cutoffMs) {
    upsertSession(store, session);
  }
  for (const intervention of interventions) {
    if (!intervention.id || !intervention.runId || !intervention.ts) continue;
    if (Date.parse(intervention.ts) < cutoffMs) continue;
    insertIntervention(store, intervention);
    importedInterventions += 1;
  }
  for (const spawn of spawns) {
    if (!spawn.sessionId || !spawn.startedAt) continue;
    const completion = resultsByToolUseId.get(spawn.toolUseId);
    const transcriptDir = completion?.result?.transcriptDir;
    const isWorkflow = spawn.tool === "Workflow" && Boolean(transcriptDir);
    if (Date.parse(spawn.startedAt) < cutoffMs) {
      // An older Workflow is read again only while one of its agents is still open.
      if (isWorkflow && !workflowParents.has(spawn.toolUseId) && hasRunningChild(store, spawn.toolUseId)) {
        workflowParents.set(spawn.toolUseId, { spawn, transcriptDir, workflowRunId: completion.result.runId ?? null });
      }
      continue;
    }
    insertSpawn(store, spawn, completion);
    importedNodes += 1;
    // First sighting wins, matching insertSpawn, which never moves a node to another run.
    if (isWorkflow && !workflowParents.has(spawn.toolUseId)) {
      workflowParents.set(spawn.toolUseId, {
        spawn,
        transcriptDir,
        workflowRunId: completion.result.runId ?? null,
      });
    }
  }
  for (const resumption of resumptions) {
    if (!resumption.id || !resumption.runId || !resumption.ts) continue;
    if (Date.parse(resumption.ts) < cutoffMs) continue;
    pendingResumptions.push(resumption);
  }
  for (const notification of parseTaskNotifications(entries)) {
    for (const taskId of notification.taskIds) {
      reconciledCompletions += recordTaskCompletion(store, {
        taskId,
        notifiedAt: notification.notifiedAt,
        resultText: notification.resultText,
        usage: notification.usage,
        toolUseId: notification.toolUseId,
      });
    }
  }
}

let importedWorkflowAgents = 0;
for (const parent of workflowParents.values()) {
  importedWorkflowAgents += insertWorkflowChildren(store, parent);
}

let importedResumptions = 0;
let resolvedResumptions = 0;
for (const resumption of pendingResumptions) {
  importedResumptions += insertResumption(store, resumption);
}
resolvedResumptions = store
  .prepare("SELECT COUNT(*) AS resolvedCount FROM resumptions WHERE node_id IS NOT NULL")
  .get().resolvedCount;
const prunedHookNodes = pruneSupersededHookNodes(store);
store.exec("COMMIT");

process.stdout.write(
  `scanned ${scannedTranscripts} transcripts (${skippedScratch} scratch skipped), ` +
    `imported ${importedNodes} agent nodes (+${importedWorkflowAgents} inside workflows), ` +
    `${importedInterventions} interventions, ` +
    `${importedResumptions} resumptions (${resolvedResumptions} resolved to a node), ` +
    `reconciled ${reconciledCompletions} async completions, ` +
    `pruned ${prunedHookNodes} superseded hook nodes\n`,
);
