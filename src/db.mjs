import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, ensureStateDir } from "./config.mjs";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");

const NODE_RESULT_COLUMNS = [
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

/** Adds result columns to an existing nodes table; schema.sql only covers fresh stores. */
function migrateNodeColumns(store) {
  const existing = new Set(store.prepare("PRAGMA table_info(nodes)").all().map((row) => row.name));
  for (const [column, type] of NODE_RESULT_COLUMNS) {
    if (!existing.has(column)) store.exec(`ALTER TABLE nodes ADD COLUMN ${column} ${type}`);
  }
}

/** Opens the store and applies schema.sql. Idempotent; safe on every boot. */
export function openStore(databasePath = DB_PATH) {
  ensureStateDir();
  const store = new DatabaseSync(databasePath);
  store.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrateNodeColumns(store);
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

export function insertNode(store, node) {
  store
    .prepare(
      `INSERT INTO nodes
         (id, run_id, parent_node_id, tool, agent_type, label, model, prompt_sha, started_at,
          prompt_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      node.id,
      node.runId,
      node.parentNodeId ?? null,
      node.tool,
      node.agentType ?? null,
      node.label ?? null,
      node.model ?? null,
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

/** Applies a task notification: the real completion time of a background agent. */
export function recordTaskCompletion(store, { taskId, notifiedAt, resultText }) {
  const updated = store
    .prepare(
      `UPDATE nodes
          SET notified_at = ?,
              true_duration_ms = CAST((julianday(?) - julianday(started_at)) * ? AS INTEGER),
              result_text = COALESCE(?, result_text)
        WHERE task_id = ? AND notified_at IS NULL`,
    )
    .run(notifiedAt, notifiedAt, MILLISECONDS_PER_DAY, resultText ?? null, taskId);
  return updated.changes;
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
      // counted, and including them trips the gate at half the configured threshold.
      `SELECT COUNT(*) AS agentNodeCount FROM nodes
        WHERE run_id = ? AND tool = 'Agent'
          AND id NOT LIKE 'toolu\\_%' ESCAPE '\\'
          AND julianday(started_at) >= julianday('now', ?)`,
    )
    .get(runId, `-${windowMinutes} minutes`);
  return row?.agentNodeCount ?? 0;
}

export function hasDeclaredTopology(store, runId) {
  const row = store.prepare("SELECT topology_json FROM runs WHERE id = ?").get(runId);
  return Boolean(row?.topology_json);
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
