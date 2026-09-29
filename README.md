# graphd

Standalone wrapper around Claude Code that records the **shape** of agent work, compares what was
declared against what actually ran, and can refuse a spawn that has no declared shape.

Not a harness. Claude Code still runs sessions, tools, subagents, and workflows. This observes,
gates, and stores.

Zero dependencies — Node 22 built-ins only (`node:sqlite`, `node:http`).

## Run

```bash
node bin/graphd.mjs                     # foreground
launchctl load ~/Library/LaunchAgents/com.chrisliu.graphd.plist   # or as an agent
```

State lives in `~/.graphd`: `graph.db`, `config.json`, `token`.

## CLI

```
graph runs [limit]      recent runs, declared shape vs what ran
graph show <run-id>     nodes, edges, declared/observed diff
graph checks [limit]    policy evaluations, including shadow would-denies
graph stats             shape, serialized agent-time, spend, harvest candidates
graph trend             per week: runs that overlapped, agents at once, serialized time, spend
graph eval              what the intervention record can and cannot prove
graph library           saved workflows and candidates
graph doctor            configuration health
graph enforce <on|off>  flip blocking
graph pause | resume    kill switch
graph health            daemon status
```

## The one rule

`requireTopologyBeyondNAgents` — spawning a third `Agent` in a run that has declared no topology
is denied. Threshold is `rules.requireTopologyBeyondNAgents.threshold` in `config.json`.

`Workflow` spawns are never denied: a workflow script is itself a declared topology.

Satisfy the rule by POSTing the TOPOLOGY artifact (schema:
`~/.claude/workflows/lib/contracts.md`). The POST is validated: a declaration needs at least one
node or edge, and every edge needs a `carries` naming the artifact that crosses it. A rejected
declaration is not stored, so the failure lands where it was written rather than at the next
spawn.

```bash
curl -s -H "Authorization: Bearer $(cat ~/.graphd/token)" -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/v1/topology \
  -d '{"sessionId":"<session>","topology":{"shape":"pipeline","edges":[{"from":"plan","to":"impl","carries":"UNIT[]"}],"barriers":["report"],"barrierJustification":"only node reading all units"}}'
```

## Fail-open guarantees

A spawn is allowed whenever anything is off-nominal. All of these are tested:

| condition | result |
|---|---|
| daemon down, or slower than 200 ms | allow |
| `jq` or `curl` missing, token unreadable | allow |
| malformed daemon response | allow |
| `~/.graphd/DISABLED` exists (`graph pause`) | allow |
| `GRAPHD_DISABLE=1` in the hook's env | allow, without contacting the daemon |
| `enforce: false` in config | allow, and record what would have been denied |

Shadow mode (`enforce: false`) records every would-deny. `graph checks` is how you read the
false-positive rate before turning blocking on.

`test/policy.test.mjs` covers the rule itself — threshold, Workflow exemption, shadow recording,
and the topology check. The hook's own fail-open paths are exercised by hand, not by the suite.

## Hooks

`hooks/graph-emit.sh` runs on `PreToolUse` and `PostToolUse` for `Agent` / `Workflow`. Register in
`~/.claude/settings.json` under both events with matcher `Agent|Workflow`.

Hooks get no tool_use id, so a spawn is keyed by `sha256(session + tool + prompt)[0:16]` plus a
random suffix, and an end resolves to the oldest still-running node with that prompt hash in the
run. Two identical prompts stay two nodes.

Both the hook and the importer write a row for the same spawn, so the importer prunes the hook's
once it has its own: the hook's id prefix is the hash the importer stores in `prompt_sha`, and a
shared `task_id` catches the rest. The imported row is the one kept — only it carries the
tool_use id, the result and the accounting. A hook row with no imported twin stays, because its
transcript may never be imported.

`Agent` results carry their own accounting — `agentId`, `resolvedModel`, `totalTokens`,
`totalToolUseCount`, `totalDurationMs` — all captured at `node_end`.

## Remote control

The daemon binds `127.0.0.1` and requires a bearer token on every request, loopback included, so
exposing it needs no code change. Do not widen `bind` to `0.0.0.0` — put a tunnel in front:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
export GRAPHD_URL=https://<name>.trycloudflare.com   # for the remote CLI
```

The token is the only credential; anything holding it can flip enforcement. Rotate by deleting
`~/.graphd/token` and restarting.

## API

```
GET  /v1/health
GET  /v1/runs?limit=
GET  /v1/runs/<run-id>
GET  /v1/trend
GET  /v1/policy/checks?limit=
POST /v1/events           {kind: node_spawn|node_end|topology|resumption, ...}
POST /v1/policy/check     {sessionId, tool} -> {isAllowed, wouldDeny, rule, reason}
POST /v1/topology         {sessionId, topology}
```

## UI

`http://127.0.0.1:8787/` — the page is served without auth (it carries no data); the API behind
it needs the token, which the page prompts for once and keeps in `localStorage`. Pass it inline
with `?token=…` when opening from a script.

An efficiency-by-week panel on top (the same numbers as `graph trend`), then a run list with
declared-vs-ran verdicts, a timeline where a fan-out reads as
overlapping bars and a chain reads as a staircase, policy checks including shadow would-denies,
and the invocation log. Enforcement and pause are togglable from the header, so a tunnel gives
remote control and not just a remote view. In a run's detail, the agents a Workflow ran are listed
under it in both the table and the timeline, and every node shows its estimated cost; a
Workflow's agents read "on Workflow" because their spend is carried by the Workflow row.

Light and dark are both selected palettes, validated with the dataviz palette checker (status
hues carry an icon and label so color never signals alone).

## Workflow library

Reads `~/.claude/workflows/`. A `*.candidate.js` written by `/graph-harvest` shows as unreviewed
with its provenance comment; `graph promote <id>` renames it to `<id>.js` and enters it into the
by-name registry, `graph reject <id>` moves it to `~/.graphd/rejected-workflows/`. Nothing is
deleted, so a rejection is reversible with `mv`.

Run counts come from `Workflow` spawns whose label matches the script's `meta.name`.

## Backfill and stats

`node bin/graph-import.mjs [days]` replays `~/.claude/projects/**/*.jsonl` into the store —
agent spawns, results, durations, tokens, and resolved models — so analysis does not have to wait
for new traffic. It also walks each session's `subagents/` directory, which is where an agent's
own spawns and messages are recorded. Re-running is safe; nodes are keyed by tool_use id.

A `Workflow` is one tool call, but it runs several agents. The importer reads the run's own
directory (`subagents/workflows/wf_<id>/`) and records each agent as a child node with
`parent_node_id` set to the Workflow: type, label and model from its meta file, timing from its
transcript, and `running` until the journal records its result. A child's duration is its active
time. A gap of more than five minutes between entries is dropped as idle, unless the agent's own
tool call was still open, which counts as work for up to 30 minutes. The Workflow's duration
becomes the union of its children's active time, rather than the runtime's figure, which counts
the days a session sat suspended.

Every view then takes one of two cuts. For *shape* (peak concurrency, serialized time, observed
shape, batches, average agents at once), a Workflow with children is replaced by its children.
For *spend* (tokens, cost, agent types, projects), the children are dropped, because the
Workflow row already holds the runtime's token total for the whole run.

`graph stats` also breaks spend down by project, joining spine's `picks` table on the session id
— graphd knows what an agent cost and spine knows what it was for, and that id is the only thing
both write. A session counts toward every project spine resolved it to (confidence above zero),
never toward a zero-confidence candidate. Project rows plus the buckets below sum to the total
unless a session resolved to more than one project, which then counts in full toward each. A
session with no resolved project is `(tied)` and names its candidates; one with no pick at all is
`(unattributed)` — spine records nothing for a folder with no registered project, and spine
backfills older sessions, so age alone does not explain a missing pick. Nodes are deduplicated
first, as in the rest of `graph stats`.

`graph stats` reports, across every run: how many multi-agent runs never had two agents running at
once, serialized agent-time (total node duration minus the slowest node, counted only when nothing
overlapped, so human thinking time is excluded), average agents at once (summed agent time over
time with at least one agent running), token spend per agent type and model, and repeated
agent-type shapes that are harvest candidates.

Cost is an estimate. Agent results report one combined `totalTokens`, so `src/pricing.mjs` splits it
at an assumed 90% input share against published per-model rates and also exposes all-input and
all-output bounds. Nodes whose transcript predates `totalTokens` contribute zero, making totals a
floor rather than a full accounting.

## Learning loop

The importer also extracts **interventions**: human interrupts, human corrections, and agent
self-corrections. `graph lessons` reports them with the autonomy metric — interventions per session
by week — plus which tool was running when a human stepped in.

`/lesson-harvest` reads that and proposes one durable artifact per recurring theme (hook > skill >
agent brief > memory > prose, most enforceable tier that fits). It proposes; it never applies.

`graph eval` asks whether that loop can be judged at all. It splits the record into the stops that
say why and the ones that do not, reports whether enough reasoned interventions exist to compare a
rule's before and after, and prints the autonomy trend per session *and* per 100 assistant turns —
a week of many short sessions lowers the per-session rate without any autonomy gain, so the two
series disagreeing is the interesting case.

Three quarters of interventions are a bare `[Request interrupted by user]` with no text, so the
tool name is otherwise the whole record. Two columns recover what it was about.
`interventions.preceding_detail` keeps the command or path that was interrupted, grouped by
command shape with wrappers like `rtk proxy` and a leading `cd` stripped.
A background agent's tool call returns before the work starts, so its tokens never appear in a
tool result. They arrive later, in the `<usage>` block of its task notification, alongside the
tool-use count and the real duration. Reading that took priced nodes from 46 of 313 to 184 of 341
and recorded spend from 5.8M tokens to 24.6M — the earlier figure was not a floor, it was a
sixth of the bill.

`interventions.followup_quote` keeps the next human turn: stopping and saying what was wrong are
two turns, so the reason for a stop is written on the turn after it. That recovers 35 of 39 stops
and takes the reasoned sample from 12 to 47, past the threshold where a rule can be graded.

Messages to a running agent are recorded too, in `resumptions`. A sub-agent cannot prompt a human,
so when it needs one it reports back and is resumed with `SendMessage`; none of that round trip
touches `nodes`, and without these rows an agent that stopped to ask a question is
indistinguishable from one that finished. Most messages address an agent by the `name` it was
spawned with rather than by `agent_id`, so `nodes.name` is kept separate from `label`.

## Health

`graph doctor` checks hook registration, hook dependencies, token permissions, the launch agent,
whether eng-task still POSTs its topology (without that, the gate has no door), and whether
enforcement is on with enough runs behind it to trust the rule. Same data renders in the UI.

## Scheduled jobs

Four launch agents, all logging under `~/.graphd/logs/`:

| Label | When | What |
| --- | --- | --- |
| `com.chrisliu.graphd` | always | the daemon on `127.0.0.1:8787` |
| `com.chrisliu.graphd-import` | hourly | backfills nodes and interventions from transcripts |
| `com.chrisliu.graphd-harvest` | Mondays 08:45 | `bin/run-harvest.sh` — refreshes the store, runs `/lesson-harvest` headless, files proposals pending |
| `com.chrisliu.nightshift` | nightly 01:30, real shift every third night | `bin/run-nightshift.sh` — drains `~/nightshift/TASKS.md` with headless `/nightshift` calls, then writes the morning summary |

A job that stops running is silent, which reads exactly like a job with nothing to report. Two
things watch for that: `hooks/inject-pending-decisions.sh` at session start, and the
`scheduled jobs` check in `graph doctor`. Both also cover `com.chrisliu.spine-refresh`, since a
stale document index degrades what spine hands a session.

The night shift exists because an accepted manual proposal is filed as a `~/nightshift/TASKS.md`
task, and nothing ran that file unattended. `run-nightshift.sh` starts a shift only when three
nights (less six hours of slack) have passed since the last one, the local hour is before 05:00,
no `~/nightshift/STOP` exists, and a `[todo]` task is waiting. A trigger missed while the Mac slept
fires on wake; the hour cutoff turns that into a skip rather than a daytime shift. Each iteration
is one `/nightshift` call, capped at 90 minutes; the shift ends on a `NIGHTSHIFT_TERMINATE`
marker, a non-zero exit, an iteration that left `TASKS.md` unchanged, eight iterations, or the
clock passing 07:00 (two hours after the start cutoff). `~/nightshift/.last-scheduled-run` gates
the next shift; `~/nightshift/.last-healthy-run` is touched only when a trigger finds no todo or
an iteration completes, and doctor and the SessionStart hook warn once it is four days old — so
a shift that fails every time, or never starts, is reported rather than looking current. `NIGHTSHIFT_LATEST_START_HOUR=24
bin/run-nightshift.sh` starts one by hand, still subject to the three-night gate.

`run-harvest.sh` pins its model rather than inheriting the default, which moves ahead of
whatever CLI version is installed and fails the whole run with a 400 when it does.

## Known limits

- Observed edges are derived from timing, not from a parent/child link: B's predecessor is the
  last node that had finished when B started. Nodes that overlap something get no incoming edge,
  which is deliberate — it is what makes a real fan-out visibly edgeless, and `delegationBatches`
  reads that shape. `parent_node_id` is populated only for the agents a Workflow ran; an agent's
  own spawns under `<session>/subagents/` could be linked the same way, but that is unbuilt.
- A Workflow's spend is the runtime's `subagent_tokens` total, and is not cross-checked against its
  agents' own usage. Its agents carry timing only.
- A Workflow agent's active time is a heuristic: a pause over five minutes with no tool call open
  counts as idle. Its active segments are stored, and peak concurrency and average agents at once
  read those, so an agent suspended mid-run does not count the suspension. Its `ended_at` is still
  its last entry, which is what timing-derived edges and the timeline use.
- Spend is a floor. Token counts arrive as one total per node with no input/output split, so
  `graph stats` prices at an assumed 90% input share and prints the all-input/all-output bounds
  beside the estimate.
- Roughly half of nodes still contribute zero to spend. A background agent's accounting arrives
  in its task notification's `<usage>` block, which the importer now reads, but a teammate spawn
  produces no notification in this store and a node the hook opened and nothing closed has no
  result at all.
- The autonomy denominator is assistant turns, not clock time. Wall-clock between a session's
  first and last message counts the days a resumed session sat idle, which put one week at 1271
  hours across 2 sessions.
- A resumption resolves to a node only when its target was spawned in the same run. Roughly a
  quarter do not resolve — messages to agents from another session, or to teammates this store
  never saw. They are still recorded, with a null node.
- The importer measures only real work: transcripts whose working directory is test scratch
  (romp's suite replays recorded turns through a scratch checkout) are skipped, and the skip
  count is printed on every import.
