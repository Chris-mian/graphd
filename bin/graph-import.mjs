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
import { activityPoints, countWorkflowAgents, readWorkflowChildren, unionMs } from "../src/workflowchildren.mjs";
import { activeMsToOpen, editTimes, pickOriginal, pullRequestsIn, workflowModeFromInput } from "../src/prlinks.mjs";
import {
  aggregateUsage,
  assistantMessageIds,
  mergeUsage,
  messageUsage,
  subagentMeta,
} from "../src/transcriptusage.mjs";
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
const ERROR_RESULT_PREFIX = "Error:";
const REJECTED_STATUS = "rejected";
const TEAMMATE_STATUS = "teammate_spawned";

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
          workflowMode: block.name === "Workflow" ? workflowModeFromInput(block.input) : null,
          resumeFromRunId: block.name === "Workflow" ? (block.input?.resumeFromRunId ?? null) : null,
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
          sender: entry.agentId || entry.agentName ? "agent" : "lead",
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

/** The status a spawn's result implies; an Agent call answered with an error string never ran. */
function spawnStatus(spawn, completion) {
  const rawResult = completion?.result;
  if (typeof rawResult === "string") {
    return spawn.tool === "Agent" && rawResult.startsWith(ERROR_RESULT_PREFIX) ? REJECTED_STATUS : "error";
  }
  return rawResult?.status ?? (completion ? "ok" : "unknown");
}

function insertSpawn(store, spawn, completion) {
  const rawResult = completion?.result;
  const isErrorString = typeof rawResult === "string";
  const result = isErrorString ? {} : (rawResult ?? {});
  const isTeammate = result.status === TEAMMATE_STATUS;
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
          task_id, output_file, is_async, true_duration_ms, prompt_text, result_text, workflow_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         label            = COALESCE(nodes.label, excluded.label),
         name             = COALESCE(excluded.name, nodes.name),
         status           = CASE WHEN excluded.status = '${REJECTED_STATUS}' THEN excluded.status ELSE nodes.status END,
         resolved_model   = COALESCE(nodes.resolved_model, excluded.resolved_model),
         task_id          = COALESCE(excluded.task_id, nodes.task_id),
         output_file      = COALESCE(excluded.output_file, nodes.output_file),
         is_async         = excluded.is_async,
         true_duration_ms = COALESCE(nodes.true_duration_ms, excluded.true_duration_ms),
         prompt_text      = COALESCE(excluded.prompt_text, nodes.prompt_text),
         result_text      = COALESCE(excluded.result_text, nodes.result_text),
         workflow_mode    = COALESCE(excluded.workflow_mode, nodes.workflow_mode)`,
    )
    .run(
      spawn.toolUseId,
      spawn.sessionId,
      spawn.tool,
      result.agentType ?? spawn.agentType,
      // An inline or scriptPath Workflow call carries no description; its result names the script.
      spawn.label ?? result.workflowName ?? null,
      spawn.name ?? (isTeammate ? result.name : null) ?? null,
      spawn.model,
      promptSha(spawn.sessionId, spawn.tool, spawn.prompt),
      spawn.startedAt,
      completion?.endedAt ?? null,
      spawnStatus(spawn, completion),
      toolCallMs,
      result.agentId ?? null,
      result.resolvedModel ?? (isTeammate ? result.model : null) ?? null,
      result.totalTokens ?? null,
      result.totalToolUseCount ?? null,
      taskIdFrom(result.outputFile),
      result.outputFile ?? null,
      isAsync,
      isAsync ? null : toolCallMs,
      (spawn.prompt ?? "").slice(0, MAX_TEXT_CHARS) || null,
      isErrorString ? rawResult.slice(0, MAX_TEXT_CHARS) : resultTextFrom(result),
      spawn.workflowMode ?? null,
    );
}

/** Workflow calls grouped by transcript directory, earliest first; a resumed run reuses its original's. */
function groupByTranscriptDir(parents) {
  const groups = new Map();
  for (const parent of parents) {
    const group = groups.get(parent.transcriptDir) ?? [];
    group.push(parent);
    groups.set(parent.transcriptDir, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => Date.parse(left.spawn.startedAt) - Date.parse(right.spawn.startedAt));
  }
  return [...groups.values()];
}

/**
 * Every Workflow call that may own this run's agents: the calls read this import, plus any call an
 * earlier import gave some of them to that fell outside this import's window. Earliest first.
 */
function workflowOwners(store, group, runKey) {
  // A forked session repeats its parent's history, so a Workflow's children go wherever its row lives.
  const owners = group.map(({ spawn }) => ({
    toolUseId: spawn.toolUseId,
    startedAt: spawn.startedAt,
    runId: store.prepare("SELECT run_id FROM nodes WHERE id = ?").get(spawn.toolUseId)?.run_id ?? spawn.sessionId,
  }));
  const knownIds = new Set(owners.map((owner) => owner.toolUseId));
  const recorded = store
    .prepare(
      `SELECT DISTINCT parent.id AS toolUseId, parent.started_at AS startedAt, parent.run_id AS runId
         FROM nodes child JOIN nodes parent ON parent.id = child.parent_node_id
        WHERE child.id LIKE ?`,
    )
    .all(`wf:${runKey}:%`)
    .filter((owner) => !knownIds.has(owner.toolUseId));
  return [...owners, ...recorded].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

/** The latest Workflow call that had started when the agent did; a resumed run owns only what it ran. */
function ownerOf(child, owners) {
  let owner = owners[0];
  for (const candidate of owners) {
    if (Date.parse(candidate.startedAt) <= Date.parse(child.startedAt)) owner = candidate;
  }
  return owner;
}

function upsertWorkflowChild(store, { child, runKey, owner }) {
  store
    .prepare(
      `INSERT INTO nodes
         (id, run_id, parent_node_id, tool, agent_type, label, model, started_at, ended_at, status,
          duration_ms, true_duration_ms, agent_id, is_async, active_segments, billed_usage)
       VALUES (?, ?, ?, 'Agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         run_id           = excluded.run_id,
         parent_node_id   = excluded.parent_node_id,
         agent_type       = excluded.agent_type,
         label            = excluded.label,
         model            = excluded.model,
         ended_at         = excluded.ended_at,
         status           = excluded.status,
         duration_ms      = excluded.duration_ms,
         true_duration_ms = excluded.true_duration_ms,
         active_segments  = excluded.active_segments,
         billed_usage     = excluded.billed_usage`,
    )
    .run(
      `wf:${runKey}:${child.agentId}`,
      owner.runId,
      owner.toolUseId,
      child.agentType,
      child.label,
      child.model,
      child.startedAt,
      child.endedAt,
      child.isFinished ? "ok" : "running",
      Date.parse(child.endedAt) - Date.parse(child.startedAt),
      child.activeMs,
      child.agentId,
      JSON.stringify(child.segments),
      usageJson(child.usage),
    );
}

/**
 * One node per agent a Workflow ran, parented to the one Workflow call that ran it, so a resumed
 * run and its original never both count an agent. Each call's duration is the union of its agents'
 * active spans and its spend the sum of their usage, scaled by `billed_share` when some agents left
 * no transcript. Returns the agent count.
 */
function insertWorkflowChildren(store, group) {
  const { transcriptDir } = group[0];
  const children = readWorkflowChildren(transcriptDir);
  if (children.length === 0) return 0;
  const runKey = group[0].workflowRunId ?? group[0].spawn.toolUseId;
  const owners = workflowOwners(store, group, runKey);
  const ownedChildren = new Map(owners.map((owner) => [owner.toolUseId, []]));
  for (const child of children) {
    const owner = ownerOf(child, owners);
    upsertWorkflowChild(store, { child, runKey, owner });
    ownedChildren.get(owner.toolUseId).push(child);
  }
  const billedChildren = children.filter((child) => usageJson(child.usage)).length;
  const agentCount = Math.max(countWorkflowAgents(transcriptDir), children.length);
  const share = billedChildren < agentCount ? billedChildren / agentCount : null;
  const updateParent = store.prepare(
    "UPDATE nodes SET true_duration_ms = ?, billed_usage = ?, billed_share = ? WHERE id = ?",
  );
  for (const [ownerId, owned] of ownedChildren) {
    updateParent.run(
      unionMs(owned.flatMap((child) => child.segments)),
      JSON.stringify(mergeUsage(owned.map((child) => child.usage))),
      share,
      ownerId,
    );
  }
  return children.length;
}

/** A usage record as stored, or null when it billed nothing. */
function usageJson(usage) {
  return usage && Object.keys(usage).length > 0 ? JSON.stringify(usage) : null;
}

/**
 * The node a top-level subagent transcript belongs to: its spawning tool_use id, or for a
 * teammate (which has none) the latest same-named Agent spawn in its session that started before
 * it. Hook rows are skipped: they start after the tool_use and are pruned in favour of it.
 */
function billedNodeId(store, { meta, firstAt }) {
  if (meta.toolUseId) {
    return store.prepare("SELECT id FROM nodes WHERE id = ?").get(meta.toolUseId)?.id ?? null;
  }
  if (!meta.name || !firstAt) return null;
  return (
    store
      .prepare(
        `SELECT id FROM nodes
          WHERE run_id = ? AND name = ? AND parent_node_id IS NULL AND started_at <= ?
            AND id LIKE 'toolu\\_%' ESCAPE '\\' AND tool = 'Agent' AND status IS NOT 'rejected'
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(meta.sessionId, meta.name, firstAt)?.id ?? null
  );
}

/**
 * Writes each subagent transcript's billed usage onto its node, replacing any earlier value so a
 * re-import never accumulates. A fork's turns that also appear in a main thread are its inherited
 * parent turn and are not counted. Returns how many nodes were priced.
 */
function applyBilledUsage(store, pendingBillings, mainThreadMessageIds) {
  const update = store.prepare("UPDATE nodes SET billed_usage = ? WHERE id = ?");
  let billedNodes = 0;
  for (const billing of pendingBillings) {
    const nodeId = billedNodeId(store, billing);
    const usage = usageJson(aggregateUsage(billing.countsByMessage, mainThreadMessageIds));
    if (!nodeId || !usage) continue;
    billedNodes += update.run(usage, nodeId).changes;
  }
  return billedNodes;
}

function firstTimestamp(entries) {
  return entries.find((entry) => entry.timestamp)?.timestamp ?? null;
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

const IMPLEMENT_VERIFY_LABEL = "implement-verify";
const DEFAULT_WORKFLOW_MODE = "verify-only";

/** The `mode` an implement-verify result reports, when its result is the workflow's return JSON. */
function modeFromResultText(resultText) {
  try {
    const mode = JSON.parse(resultText ?? "")?.mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Settles the mode of every implement-verify call: its own args, else the mode of the run it
 * resumed, else the mode its result reports, else the workflow's default.
 */
function resolveWorkflowModes(store, workflowCalls) {
  const modeByRunId = new Map();
  for (const call of workflowCalls) if (call.mode && call.workflowRunId) modeByRunId.set(call.workflowRunId, call.mode);
  const setMode = store.prepare("UPDATE nodes SET workflow_mode = ? WHERE id = ? AND workflow_mode IS NULL");
  for (const call of workflowCalls) {
    const inherited = call.resumeFromRunId ? modeByRunId.get(call.resumeFromRunId) : null;
    if (!call.mode && inherited) setMode.run(inherited, call.toolUseId);
  }
  const unresolved = store
    .prepare("SELECT id, result_text FROM nodes WHERE tool = 'Workflow' AND label = ? AND workflow_mode IS NULL")
    .all(IMPLEMENT_VERIFY_LABEL);
  for (const node of unresolved) setMode.run(modeFromResultText(node.result_text) ?? DEFAULT_WORKFLOW_MODE, node.id);
}

function pushTo(map, key, values) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(...values);
}

/** Writes each PR once, under its original session, with the active time of the work behind it. */
function recordPullRequests(store, { candidates, sessionStartMs, leadPointsBySession, editTimesBySession }) {
  const upsert = store.prepare(
    `INSERT INTO prs (url, repo, number, tool_use_id, session_id, cwd, opened_by, opened_at, work_started_at, active_ms_to_open)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET
       tool_use_id = excluded.tool_use_id, session_id = excluded.session_id, cwd = excluded.cwd,
       opened_by = excluded.opened_by, opened_at = excluded.opened_at,
       work_started_at = excluded.work_started_at, active_ms_to_open = excluded.active_ms_to_open`,
  );
  const originals = pickOriginal(candidates, sessionStartMs).sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  const previousOpenBySession = new Map();
  let recorded = 0;
  for (const pullRequest of originals) {
    const openedAtMs = Date.parse(pullRequest.openedAt);
    const { workStartedAtMs, activeMs } = activeMsToOpen({
      leadPoints: leadPointsBySession.get(pullRequest.sessionId) ?? [],
      editTimesMs: editTimesBySession.get(pullRequest.sessionId) ?? [],
      openedAtMs,
      previousOpenedAtMs: previousOpenBySession.get(pullRequest.sessionId),
    });
    previousOpenBySession.set(pullRequest.sessionId, openedAtMs);
    if (!pullRequest.isInWindow) continue;
    upsert.run(
      pullRequest.url,
      pullRequest.repo,
      pullRequest.number,
      pullRequest.toolUseId,
      pullRequest.sessionId,
      pullRequest.cwd,
      pullRequest.openedBy,
      pullRequest.openedAt,
      workStartedAtMs == null ? null : new Date(workStartedAtMs).toISOString(),
      activeMs,
    );
    recorded += 1;
  }
  return recorded;
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
// Billed usage is applied after every transcript has contributed its spawns, and with every main
// thread's message ids known, so a fork's inherited parent turn can be told apart from its own.
const pendingBillings = [];
const mainThreadMessageIds = new Set();
// PRs are attributed and timed after every transcript is read: the same call can sit in several
// sessions' transcripts, and the edits behind a PR can sit in its agents' transcripts.
const pullRequestCandidates = [];
const sessionStartMs = new Map();
const leadPointsBySession = new Map();
const editTimesBySession = new Map();
const workflowCalls = [];

store.exec("BEGIN");
for (const path of transcriptPaths()) {
  const { session, spawns, resultsByToolUseId, interventions, resumptions, entries } =
    parseTranscript(path);
  if (isScratchCwd(session.cwd)) {
    skippedScratch += 1;
    continue;
  }
  scannedTranscripts += 1;
  const meta = subagentMeta(path);
  const isSubagentTranscript = path.includes(`/${SUBAGENT_DIR_NAME}/`);
  const transcriptSessionId = entries.find((entry) => entry.sessionId)?.sessionId ?? null;
  if (transcriptSessionId) pushTo(editTimesBySession, transcriptSessionId, editTimes(entries));
  if (!isSubagentTranscript && session.id && session.startedAt) {
    sessionStartMs.set(session.id, Date.parse(session.startedAt));
    pushTo(leadPointsBySession, session.id, activityPoints(entries.filter((entry) => !entry.isSidechain)));
  }
  for (const pullRequest of pullRequestsIn(entries, { openedBy: isSubagentTranscript ? "agent" : "lead" })) {
    if (!pullRequest.sessionId) continue;
    pullRequestCandidates.push({ ...pullRequest, isInWindow: Date.parse(pullRequest.openedAt) >= cutoffMs });
  }
  if (meta) {
    pendingBillings.push({ meta, firstAt: firstTimestamp(entries), countsByMessage: messageUsage(entries) });
  } else if (!path.includes(`/${SUBAGENT_DIR_NAME}/`)) {
    for (const messageId of assistantMessageIds(entries)) mainThreadMessageIds.add(messageId);
  }
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
    if (spawn.tool === "Workflow") {
      workflowCalls.push({
        toolUseId: spawn.toolUseId,
        mode: spawn.workflowMode,
        resumeFromRunId: spawn.resumeFromRunId,
        workflowRunId: completion?.result?.runId ?? null,
      });
    }
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
for (const group of groupByTranscriptDir(workflowParents.values())) {
  importedWorkflowAgents += insertWorkflowChildren(store, group);
}
const billedNodes = applyBilledUsage(store, pendingBillings, mainThreadMessageIds);
// Teammate messages were once filed as the lead's when the entry named the agent but carried no id.
store.exec("UPDATE resumptions SET sender = 'agent' WHERE sender = 'lead' AND sender_ref IS NOT NULL");

let importedResumptions = 0;
let resolvedResumptions = 0;
for (const resumption of pendingResumptions) {
  importedResumptions += insertResumption(store, resumption);
}
resolvedResumptions = store
  .prepare("SELECT COUNT(*) AS resolvedCount FROM resumptions WHERE node_id IS NOT NULL")
  .get().resolvedCount;
const prunedHookNodes = pruneSupersededHookNodes(store);
resolveWorkflowModes(store, workflowCalls);
const recordedPullRequests = recordPullRequests(store, {
  candidates: pullRequestCandidates,
  sessionStartMs,
  leadPointsBySession,
  editTimesBySession,
});
store.exec("COMMIT");

process.stdout.write(
  `scanned ${scannedTranscripts} transcripts (${skippedScratch} scratch skipped), ` +
    `imported ${importedNodes} agent nodes (+${importedWorkflowAgents} inside workflows), ` +
    `${importedInterventions} interventions, ` +
    `${importedResumptions} resumptions (${resolvedResumptions} resolved to a node), ` +
    `reconciled ${reconciledCompletions} async completions, ` +
    `billed ${billedNodes} agents from their transcripts, ` +
    `pruned ${prunedHookNodes} superseded hook nodes, ` +
    `linked ${recordedPullRequests} pull requests\n`,
);
