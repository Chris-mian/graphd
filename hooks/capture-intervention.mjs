#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { openStore, recordTaskCompletion } from "../src/db.mjs";
import { parseTaskNotifications } from "../src/tasknotify.mjs";
import {
  classifyAssistantText,
  classifyHumanTurn,
  matchedSentence,
  toQuote,
} from "../src/interventions.mjs";

const TAIL_LINE_COUNT = 40;

function readTailEntries(transcriptPath) {
  return readFileSync(transcriptPath, "utf8")
    .split("\n")
    .slice(-TAIL_LINE_COUNT)
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function lastToolNameIn(entries) {
  for (const entry of [...entries].reverse()) {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const toolBlock = blocks.find((block) => block.type === "tool_use");
    if (toolBlock) return toolBlock.name;
  }
  return null;
}

function interventionsInTail(entries) {
  const found = [];
  const precedingTool = lastToolNameIn(entries);
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    if (entry.type === "user") {
      const kind = classifyHumanTurn(entry.message?.content);
      if (kind) {
        found.push({
          id: entry.uuid,
          runId: entry.sessionId ?? entry.session_id,
          cwd: entry.cwd ?? null,
          ts: entry.timestamp,
          kind,
          quote: toQuote(entry.message.content),
          precedingTool,
        });
      }
      continue;
    }
    if (entry.type !== "assistant") continue;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block.type !== "text") continue;
      const kind = classifyAssistantText(block.text);
      if (!kind) continue;
      found.push({
        id: entry.uuid,
        runId: entry.sessionId ?? entry.session_id,
        cwd: entry.cwd ?? null,
        ts: entry.timestamp,
        kind,
        quote: matchedSentence(block.text),
        precedingTool,
      });
      break;
    }
  }
  return found.filter((entry) => entry.id && entry.runId && entry.ts);
}

function persist(store, intervention) {
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

const hookPayload = JSON.parse(readFileSync(0, "utf8"));
const transcriptPath = hookPayload.transcript_path ?? "";
if (transcriptPath) {
  const store = openStore();
  const tailEntries = readTailEntries(transcriptPath);
  for (const intervention of interventionsInTail(tailEntries)) {
    persist(store, intervention);
  }
  for (const notification of parseTaskNotifications(tailEntries)) {
    for (const taskId of notification.taskIds) {
      recordTaskCompletion(store, {
        taskId,
        notifiedAt: notification.notifiedAt,
        resultText: notification.resultText,
      });
    }
  }
}
