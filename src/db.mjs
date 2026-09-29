import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, ensureStateDir } from "./config.mjs";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");

const NODE_RESULT_COLUMNS = [
  ["name", "TEXT"],
  ["agent_id", "TEXT"],
  ["resolved_model", "TEXT"],
  ["total_tokens", "INTEGER"],
  ["tool_use_count", "INTEGER"],
  ["task_id", "TEXT"],
  ["output_file", "TEXT"],
  ["is_async", "INTEGER NOT NULL DEFAULT 0"],
  ["notified_at", "TEXT"],
  ["true_duration_ms", "INTEGER"],
  ["prompt_text", "TEXT"],
  ["result_text", "TEXT"],
];

const SESSION_COLUMNS = [["turn_count", "INTEGER NOT NULL DEFAULT 0"]];

const INTERVENTION_COLUMNS = [
  ["preceding_detail", "TEXT"],
  ["followup_quote", "TEXT"],
];

/** Adds a column to an existing table; schema.sql only covers fresh stores. */
function migrateColumns(store, table, columns) {
  const existing = new Set(
    store.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  for (const [column, type] of columns) {
    if (!existing.has(column)) store.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** How long a writer waits for another writer's transaction before giving up. */
const BUSY_TIMEOUT_MILLISECONDS = 10_000;

/** Opens the store and applies schema.sql. Idempotent; safe on every boot. */
export function openStore(databasePath = DB_PATH) {
  ensureStateDir();
  const store = new DatabaseSync(databasePath);
  // WAL lets readers run during a write but still allows one writer: the daemon writes on every
  // hook, and the hourly import would otherwise fail outright when the two overlap.
  store.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS};`);
  store.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrateColumns(store, "nodes", NODE_RESULT_COLUMNS);
  migrateColumns(store, "sessions", SESSION_COLUMNS);
  migrateColumns(store, "interventions", INTERVENTION_COLUMNS);
  return store;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Inserts the raw event before any derivation, so a bad derivation can be replayed. */
export function recordEvent(store, { kind, sessionId, runId, payload }) {
  store
    .prepare("INSERT INTO events (ts, kind, session_id, run_id, payload) VALUES (?, ?, ?, ?, ?)")
    .run(nowIso(), kind, sessionId ?? null, runId ?? null, JSON.stringify(payload ?? {}));
}

export function upsertRun(store, { runId, sessionId, cwd, source = "session" }) {
  store
    .prepare(
      `INSERT INTO runs (id, session_id, cwd, source, started_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET cwd = COALESCE(excluded.cwd, runs.cwd)`,
    )
    .run(runId, sessionId, cwd ?? null, source, nowIso());
  return runId;
}

/**
 * Records a live spawn. The hook sends a missing agent type, label, name or model as "" while the
 * backfill stores null; both become null so a hook row and its transcript twin still match.
 */
export function insertNode(store, node) {
  store
    .prepare(
      `INSERT INTO nodes
         (id, run_id, parent_node_id, tool, agent_type, label, name, model, prompt_sha,
          started_at, prompt_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      node.id,
      node.runId,
      node.parentNodeId ?? null,
      node.tool,
      node.agentType || null,
      node.label || null,
      node.name || null,
      node.model || null,
      node.promptSha ?? null,
      node.startedAt ?? nowIso(),
      node.promptText ?? null,
    );
}

/**
 * Finds the node a result belongs to.
 * Hooks carry no tool_use id, so an end resolves to the oldest still-running node with the same
 * prompt in that run — which keeps two identical prompts as two nodes rather than one.
 */
export function resolveRunningNodeId(store, { runId, promptSha, nodeId }) {
  const match = store
    .prepare(
      `SELECT id FROM nodes
        WHERE run_id = ? AND prompt_sha = ? AND status = 'running'
        ORDER BY started_at LIMIT 1`,
    )
    .get(runId, promptSha);
  return match?.id ?? nodeId;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Closes a node, derives its duration, and stores whatever the result reported.
 * For a synchronous agent the tool call spans the work, so true_duration_ms is set here;
 * an async agent stays open until its task notification arrives.
 */
export function completeNode(store, { nodeId, status, result = {} }) {
  const endedAt = nowIso();
  const isAsync = result.isAsync ? 1 : 0;
  store
    .prepare(
      `UPDATE nodes
          SET ended_at = ?,
              status = ?,
              duration_ms = COALESCE(?, CAST((julianday(?) - julianday(started_at)) * ? AS INTEGER)),
              agent_id = COALESCE(?, agent_id),
              resolved_model = COALESCE(?, resolved_model),
              total_tokens = COALESCE(?, total_tokens),
              tool_use_count = COALESCE(?, tool_use_count),
              task_id = COALESCE(?, task_id),
              output_file = COALESCE(?, output_file),
              is_async = ?,
              result_text = COALESCE(?, result_text),
              -- Recomputed rather than read from duration_ms: SQLite evaluates every SET
              -- right-hand side against the pre-UPDATE row, so that column is still NULL here.
              true_duration_ms = CASE
                WHEN ? = 0
                  THEN COALESCE(?, CAST((julianday(?) - julianday(started_at)) * ? AS INTEGER))
                ELSE true_duration_ms
              END
        WHERE id = ?`,
    )
    .run(
      endedAt,
      status,
      result.durationMs ?? null,
      endedAt,
      MILLISECONDS_PER_DAY,
      result.agentId ?? null,
      result.resolvedModel ?? null,
      result.totalTokens ?? null,
      result.toolUseCount ?? null,
      result.taskId ?? null,
      result.outputFile ?? null,
      isAsync,
      result.resultText ?? null,
      isAsync,
      result.durationMs ?? null,
      endedAt,
      MILLISECONDS_PER_DAY,
      nodeId,
    );
}

/**
 * Applies a task notification: a background agent's real completion time and its accounting.
 * The notification's own duration is preferred over notify-minus-launch, which counts the gap
 * before the lead thread saw the notification.
 */
export function recordTaskCompletion(store, { taskId, toolUseId, notifiedAt, resultText, usage }) {
  const updated = store
    .prepare(
      `UPDATE nodes
          SET notified_at = ?,
              -- A Workflow whose agents are on file keeps their active time: the runtime's figure
              -- counts time the session sat suspended.
              true_duration_ms = CASE
                WHEN EXISTS (SELECT 1 FROM nodes AS child WHERE child.parent_node_id = nodes.id)
                  THEN true_duration_ms
                ELSE COALESCE(?, CAST((julianday(?) - julianday(started_at)) * ? AS INTEGER))
              END,
              result_text = COALESCE(?, result_text),
              total_tokens = COALESCE(?, total_tokens),
              tool_use_count = COALESCE(?, tool_use_count)
        WHERE (task_id = ? OR id = ?) AND (notified_at IS NULL OR total_tokens IS NULL)`,
    )
    .run(
      notifiedAt,
      usage?.durationMs ?? null,
      notifiedAt,
      MILLISECONDS_PER_DAY,
      resultText ?? null,
      usage?.totalTokens ?? null,
      usage?.toolUseCount ?? null,
      taskId,
      toolUseId ?? taskId,
    );
  return updated.changes;
}

/**
 * Superseded hook nodes, paired with the imported node that replaced each one.
 * A hook has no tool_use id, so it keys a spawn by `<prompt_sha>-<random>`; the importer keys
 * the same spawn by its real id and stores that hash in `prompt_sha`. The id prefix is the join.
 */
const SUPERSEDED_HOOK_NODES_SQL = `
  SELECT DISTINCT hook.id AS hookId, imported.id AS importedId
    FROM nodes AS hook
    JOIN nodes AS imported
      ON imported.id LIKE 'toolu\\_%' ESCAPE '\\'
     AND (
       (imported.run_id = hook.run_id
        AND instr(hook.id, '-') > 0
        AND imported.prompt_sha = substr(hook.id, 1, instr(hook.id, '-') - 1))
       OR (hook.task_id IS NOT NULL AND imported.task_id = hook.task_id)
     )
   WHERE hook.id NOT LIKE 'toolu\\_%' ESCAPE '\\'`;

/**
 * Drops hook nodes the importer has since recorded properly, repointing anything that referenced
 * them. Both write a row for the same spawn, so every imported spawn was counted twice; the
 * imported row is kept because only it carries the tool_use id, the result and the accounting.
 */
export function pruneSupersededHookNodes(store) {
  const superseded = store.prepare(SUPERSEDED_HOOK_NODES_SQL).all();
  if (superseded.length === 0) return 0;
  const repoint = store.prepare("UPDATE resumptions SET node_id = ? WHERE node_id = ?");
  const remove = store.prepare("DELETE FROM nodes WHERE id = ?");
  for (const { hookId, importedId } of superseded) {
    repoint.run(importedId, hookId);
    remove.run(hookId);
  }
  return superseded.length;
}

/** Stores the declared TOPOLOGY artifact and its edges, replacing any earlier declaration. */
export function recordTopology(store, { runId, topology }) {
  store
    .prepare("UPDATE runs SET declared_shape = ?, topology_json = ? WHERE id = ?")
    .run(topology.shape ?? null, JSON.stringify(topology), runId);
  store.prepare("DELETE FROM edges WHERE run_id = ? AND kind = 'declared'").run(runId);

  const insertDeclaredEdge = store.prepare(
    `INSERT INTO edges (run_id, kind, from_ref, to_ref, carries)
     VALUES (?, 'declared', ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  for (const edge of topology.edges ?? []) {
    insertDeclaredEdge.run(runId, edge.from, edge.to, edge.carries ?? null);
  }
}

/**
 * Agents spawned in this run within the last `windowMinutes`.
 * A session can stay alive for days; counting its whole history would deny a fresh fan-out on the
 * strength of agents that finished last week.
 */
export function countRecentAgentNodes(store, runId, windowMinutes) {
  const row = store
    .prepare(
      // julianday on both sides: started_at is ISO-with-T, datetime('now') is space-separated,
      // so a string comparison between them is always true and the window silently does nothing.
      // Backfill rows are excluded: they are transcript twins of spawns the hook already
      // counted, and including them trips the gate at half the configured threshold. Agents a
      // Workflow ran are excluded too: a workflow script is itself a declared topology.
      `SELECT COUNT(*) AS agentNodeCount FROM nodes
        WHERE run_id = ? AND tool = 'Agent' AND parent_node_id IS NULL
          AND id NOT LIKE 'toolu\\_%' ESCAPE '\\'
          AND julianday(started_at) >= julianday('now', ?)`,
    )
    .get(runId, `-${windowMinutes} minutes`);
  return row?.agentNodeCount ?? 0;
}

export function hasDeclaredTopology(store, runId) {
  const row = store.prepare("SELECT topology_json FROM runs WHERE id = ?").get(runId);
  if (!row?.topology_json) return false;
  try {
    return isTopologySubstantive(JSON.parse(row.topology_json));
  } catch {
    return false;
  }
}

/**
 * Whether a declared topology says anything. An empty object satisfied the gate before this
 * check existed, so the rule could be cleared by POSTing nothing.
 */
export function isTopologySubstantive(topology) {
  if (!topology || typeof topology !== "object") return false;
  const edges = Array.isArray(topology.edges) ? topology.edges : [];
  const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
  if (edges.length === 0 && nodes.length === 0) return false;
  return edges.every((edge) => Boolean(edge?.from && edge?.to && edge?.carries));
}

const AGENT_ID_PATTERN = /^[0-9a-f]{16,18}$/;

/** Whether a SendMessage target is an agent_id or the `name` given at spawn. */
export function classifyTargetRef(targetRef) {
  if (typeof targetRef !== "string" || targetRef.length === 0) return "unknown";
  return AGENT_ID_PATTERN.test(targetRef) ? "agent_id" : "name";
}

/**
 * Records one SendMessage to a running agent, resolving the target to a node when the
 * reference matches an agent_id or a spawn name in the same run.
 */
export function insertResumption(store, resumption) {
  const target = store
    .prepare(
      `SELECT id FROM nodes
        WHERE run_id = ? AND (agent_id = ? OR name = ?)
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(resumption.runId, resumption.targetRef, resumption.targetRef);
  return store
    .prepare(
      `INSERT INTO resumptions (id, run_id, ts, target_ref, target_kind, sender, sender_ref, node_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      resumption.id,
      resumption.runId,
      resumption.ts,
      resumption.targetRef,
      resumption.targetKind,
      resumption.sender,
      resumption.senderRef ?? null,
      target?.id ?? null,
    ).changes;
}

/** Resumptions per run, for reporting how much agent work involved a question round trip. */
export function resumptionsForRun(store, runId) {
  return store.prepare("SELECT * FROM resumptions WHERE run_id = ? ORDER BY ts").all(runId);
}

export function recordPolicyCheck(store, check) {
  store
    .prepare(
      `INSERT INTO policy_checks (ts, session_id, run_id, tool, rule, would_deny, enforced, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nowIso(),
      check.sessionId ?? null,
      check.runId ?? null,
      check.tool ?? null,
      check.rule ?? null,
      check.wouldDeny ? 1 : 0,
      check.isEnforced ? 1 : 0,
      check.reason ?? null,
    );
}
