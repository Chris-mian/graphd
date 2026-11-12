-- graphd store. One SQLite file, no migrations framework: every statement here is
-- CREATE ... IF NOT EXISTS and runs on every daemon boot.
--
-- A "run" is a unit of agent work that can have a declared shape. Today that is one
-- Claude Code session; a Workflow invocation gets its own run keyed by its wf_ id.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  cwd            TEXT,
  source         TEXT NOT NULL DEFAULT 'session',  -- 'session' | 'workflow'
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  declared_shape TEXT,                             -- chain|fanout|pipeline|diamond|conditional|cycle
  topology_json  TEXT                              -- the TOPOLOGY artifact, verbatim
);

CREATE INDEX IF NOT EXISTS runs_session_idx ON runs (session_id);
CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);

-- One row per subagent or workflow spawn. parent_node_id is null for a node spawned
-- directly by the lead thread.
CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,                 -- the tool_use id; stable and unique
  run_id         TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  parent_node_id TEXT,
  tool           TEXT NOT NULL,                    -- 'Agent' | 'Workflow'
  agent_type     TEXT,
  label          TEXT,
  -- The addressable name from Agent's `name` input. Separate from `label`, which prefers
  -- `description` and so would discard the only handle SendMessage can be joined on.
  name           TEXT,
  model          TEXT,
  prompt_sha     TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,                             -- when the TOOL CALL returned
  status         TEXT NOT NULL DEFAULT 'running',  -- running|ok|error|unknown|rejected|async_launched|completed|teammate_spawned
  duration_ms    INTEGER,
  agent_id       TEXT,
  resolved_model TEXT,
  total_tokens   INTEGER,
  tool_use_count INTEGER,
  -- A background agent's tool call returns in ~130ms; the agent then runs for minutes.
  -- ended_at therefore measures the handoff, not the work. notified_at is when the task
  -- notification for this agent actually arrived, and is the only honest end time.
  task_id        TEXT,
  output_file    TEXT,
  is_async       INTEGER NOT NULL DEFAULT 0,
  notified_at    TEXT,
  true_duration_ms INTEGER,
  prompt_text    TEXT,
  result_text    TEXT,
  -- JSON [[startMs, endMs], ...]: when a Workflow's agent was working, gaps of idle time removed.
  active_segments TEXT,
  billed_usage   TEXT,                             -- JSON {model: {input, cacheWrite5m, cacheWrite1h, cacheRead, output, turns}} from the agent's transcript
  billed_share   REAL,                             -- Workflow only: share of its agents with a transcript, when under 1
  workflow_mode  TEXT                              -- implement-verify only: 'parallel' | 'verify-only'
);

CREATE INDEX IF NOT EXISTS nodes_run_idx ON nodes (run_id, started_at);
CREATE INDEX IF NOT EXISTS nodes_resolution_idx ON nodes (run_id, prompt_sha, status);

-- Two kinds of edge over the same node set. The diff between them is the product.
CREATE TABLE IF NOT EXISTS edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('declared', 'observed')),
  from_ref  TEXT NOT NULL,                         -- node id, or a declared node name
  to_ref    TEXT NOT NULL,
  carries   TEXT,                                  -- the named artifact; null on observed
  UNIQUE (run_id, kind, from_ref, to_ref)
);

-- Raw feed, kept so a bad derivation can be replayed rather than re-collected.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  session_id TEXT,
  run_id     TEXT,
  payload    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts DESC);

-- Every policy evaluation, including the ones that allowed. In shadow mode this is the
-- false-positive rate: rows where would_deny = 1 and enforced = 0 are the denials that
-- would have interrupted a session that in fact went fine.
CREATE TABLE IF NOT EXISTS policy_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  session_id TEXT,
  run_id     TEXT,
  tool       TEXT,
  rule       TEXT,
  would_deny INTEGER NOT NULL DEFAULT 0,
  enforced   INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  -- subagent_type of the spawn being checked; '' for the default (general-purpose).
  agent_type TEXT
);

CREATE INDEX IF NOT EXISTS policy_checks_ts_idx ON policy_checks (ts DESC);

-- Human redirects and agent self-corrections. The autonomy signal: how often a run needed a
-- person to step in, and what it was about.
CREATE TABLE IF NOT EXISTS interventions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  cwd          TEXT,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('interrupt', 'correction', 'self_correction')),
  quote        TEXT NOT NULL,
  preceding_tool TEXT,
  -- The interrupted tool call's command or path. A bare interrupt records no reason, so this is
  -- the only evidence of what the human stopped.
  preceding_detail TEXT,
  -- The next human turn after a bare interrupt. Stopping and then saying what was wrong are two
  -- turns, so the reason for a stop is recorded on the turn after it.
  followup_quote TEXT
);

CREATE INDEX IF NOT EXISTS interventions_ts_idx ON interventions (ts DESC);
CREATE INDEX IF NOT EXISTS interventions_run_idx ON interventions (run_id);

-- Every session the importer saw, whether or not it spawned an agent or needed an
-- intervention. `runs` holds only sessions with agents, so it cannot serve as the denominator
-- for a per-session rate: a week of clean sessions would not be counted at all.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  cwd        TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  -- Assistant turns. Wall-clock between first and last message is not work time: a resumed
  -- session counts the days it sat idle, which put one week at 1271 hours across 2 sessions.
  turn_count INTEGER NOT NULL DEFAULT 0,
  -- Lead tool calls, grouped by assistant message.id. batched_calls = calls in a message that
  -- issued 2+ tool calls at once; serial_read_calls = calls in runs of 3+ consecutive
  -- single-call messages whose one call was a read. See src/batching.mjs.
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  batched_calls     INTEGER NOT NULL DEFAULT 0,
  serial_read_calls INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions (started_at DESC);

-- Messages sent to an already-running agent. A resume is not a spawn and does not extend the
-- target's ended_at, so without these rows an agent that stopped to ask a question looks
-- identical to one that finished. target_ref is whatever the sender addressed: a 17-hex
-- agent_id, or the `name` given at spawn.
CREATE TABLE IF NOT EXISTS resumptions (
  id          TEXT PRIMARY KEY,                 -- the SendMessage tool_use id
  run_id      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  target_ref  TEXT,
  target_kind TEXT CHECK (target_kind IN ('agent_id', 'name', 'unknown')),
  -- Who sent it. 'lead' is the main thread; 'agent' is a subagent messaging a peer or its lead.
  sender      TEXT NOT NULL CHECK (sender IN ('lead', 'agent')),
  sender_ref  TEXT,
  node_id     TEXT                              -- the resolved target node, when one matches
);

CREATE INDEX IF NOT EXISTS resumptions_run_idx ON resumptions (run_id, ts);
CREATE INDEX IF NOT EXISTS resumptions_node_idx ON resumptions (node_id);

-- Pull requests a session opened with `gh pr create`, and what became of them. session_id has no
-- foreign key: a session that opened a PR without spawning an agent has no `runs` row, and
-- belongs in the baseline all the same. When romp copies a session, the same call appears under
-- several session ids; the importer keeps the session that started first.
CREATE TABLE IF NOT EXISTS prs (
  url               TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,               -- owner/name
  number            INTEGER NOT NULL,
  tool_use_id       TEXT NOT NULL,               -- the `gh pr create` call
  session_id        TEXT NOT NULL,
  cwd               TEXT,
  opened_by         TEXT NOT NULL CHECK (opened_by IN ('lead', 'agent')),
  opened_at         TEXT NOT NULL,
  -- The first file edit after the session's previous PR, and the lead's active time from it to
  -- the open. Null when no edit preceded the PR.
  work_started_at   TEXT,
  active_ms_to_open INTEGER,
  -- Filled by graph-outcomes from GitHub.
  author            TEXT,
  state             TEXT,                        -- OPEN | MERGED | CLOSED
  merged_at         TEXT,
  closed_at         TEXT,
  base_ref          TEXT,
  file_count        INTEGER,
  -- Commits on the PR made after it opened: rework during review.
  commits_after_open INTEGER,
  -- Commits by the PR's author on its base branch, touching its files, within 7 days of merge,
  -- excluding the PR's own. The rework that review missed. fix_commits is the subset whose
  -- message reads as a fix or revert.
  followup_commits  INTEGER,
  followup_fix_commits INTEGER,
  followup_shas     TEXT,                        -- JSON array
  reverted          INTEGER,
  -- 1 once nothing about the PR can change: closed unmerged, or 7 days past merge.
  outcome_final     INTEGER NOT NULL DEFAULT 0,
  fetched_at        TEXT,
  fetch_error       TEXT
);

CREATE INDEX IF NOT EXISTS prs_session_idx ON prs (session_id);
CREATE INDEX IF NOT EXISTS prs_opened_idx ON prs (opened_at DESC);
