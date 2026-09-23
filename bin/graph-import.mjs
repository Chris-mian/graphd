#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openStore, recordTaskCompletion } from "../src/db.mjs";
import { parseTaskNotifications } from "../src/tasknotify.mjs";
import {
  classifyAssistantText,
  classifyHumanTurn,
  matchedSentence,
  toQuote,
} from "../src/interventions.mjs";

const TRANSCRIPT_ROOT = join(homedir(), ".claude", "projects");
const SPAWN_TOOL_NAMES = new Set(["Agent", "Task", "Workflow"]);
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

function promptSha(sessionId, tool, prompt) {
  return createHash("sha256")
    .update(`${sessionId}|${tool}|${prompt ?? ""}`)
    .digest("hex")
    .slice(0, PROMPT_SHA_LENGTH);
}

function transcriptPaths() {
  if (!statSync(TRANSCRIPT_ROOT, { throwIfNoEntry: false })) return [];
  return readdirSync(TRANSCRIPT_ROOT)
    .flatMap((projectDir) => {
      const projectPath = join(TRANSCRIPT_ROOT, projectDir);
      if (!statSync(projectPath).isDirectory()) return [];
      return readdirSync(projectPath)
        .filter((fileName) => fileName.endsWith(".jsonl"))
        .map((fileName) => join(projectPath, fileName));
    });
}

/** Collects the session itself, spawn records, their results, and human/agent interventions. */
function parseTranscript(path) {
  const spawns = [];
  const resultsByToolUseId = new Map();
  const interventions = [];
  const entries = [];
  let lastToolName = null;
  const session = { id: null, cwd: null, startedAt: null, endedAt: null };

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
      if (kind) {
        interventions.push({
          id: entry.uuid,
          runId: entry.sessionId ?? entry.session_id,
          cwd: entry.cwd ?? null,
          ts: entry.timestamp,
          kind,
          quote: toQuote(entry.message.content),
          precedingTool: lastToolName,
        });
      }
    }
    if (entry.type === "assistant" && !entry.isSidechain) {
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
          label: block.input?.description ?? block.input?.name ?? null,
          model: block.input?.model ?? null,
          prompt: block.input?.prompt ?? "",
        });
      }
      if (block.type === "tool_use") lastToolName = block.name;
      if (block.type === "tool_result" && entry.toolUseResult) {
        resultsByToolUseId.set(block.tool_use_id, {
          endedAt: entry.timestamp,
          result: entry.toolUseResult,
        });
      }
    }
  }
  return { session, spawns, resultsByToolUseId, interventions, entries };
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
         (id, run_id, tool, agent_type, label, model, prompt_sha, started_at, ended_at,
          status, duration_ms, agent_id, resolved_model, total_tokens, tool_use_count,
          task_id, output_file, is_async, true_duration_ms, prompt_text, result_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
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
      spawn.label,
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

function upsertSession(store, session) {
  store
    .prepare(
      `INSERT INTO sessions (id, cwd, started_at, ended_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         cwd      = COALESCE(excluded.cwd, sessions.cwd),
         ended_at = MAX(COALESCE(sessions.ended_at, ''), COALESCE(excluded.ended_at, ''))`,
    )
    .run(session.id, session.cwd, session.startedAt, session.endedAt);
}

function insertIntervention(store, intervention) {
  store
    .prepare(
      `INSERT INTO interventions (id, run_id, cwd, ts, kind, quote, preceding_tool)
       VALUES (?, ?, ?, ?, ?, ?, ?)
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

store.exec("BEGIN");
for (const path of transcriptPaths()) {
  const { session, spawns, resultsByToolUseId, interventions, entries } = parseTranscript(path);
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
    if (Date.parse(spawn.startedAt) < cutoffMs) continue;
    insertSpawn(store, spawn, resultsByToolUseId.get(spawn.toolUseId));
    importedNodes += 1;
  }
  for (const notification of parseTaskNotifications(entries)) {
    for (const taskId of notification.taskIds) {
      reconciledCompletions += recordTaskCompletion(store, {
        taskId,
        notifiedAt: notification.notifiedAt,
        resultText: notification.resultText,
      });
    }
  }
}
store.exec("COMMIT");

process.stdout.write(
  `scanned ${scannedTranscripts} transcripts (${skippedScratch} scratch skipped), ` +
    `imported ${importedNodes} agent nodes, ${importedInterventions} interventions, ` +
    `reconciled ${reconciledCompletions} async completions\n`,
);
