# graphd — what it is, why it's worth keeping, how to use it

Written 2026-09-08. Everything here is installed and running on this machine.

---

## The 60-second version

You run a lot of agents. Nothing measured whether they ran *well*. graphd measures three things
your setup was blind to, and acts on two of them:

| question | before | now |
|---|---|---|
| Did my parallel agents actually run in parallel? | unknowable | `graph show <run>` — per run: batches, true overlap, attempted vs achieved |
| What did each agent get told, and what came back? | buried in the transcript | run detail — prompt and result per node |
| What are my agents costing, and where? | unknowable | `graph stats` — spend per agent type and per model |
| Am I correcting the same thing repeatedly? | only in your memory | `graph lessons` — interventions clustered into recurring themes |

> **Correction to an earlier version of this guide.** It claimed 82% of multi-agent runs never
> ran two agents at once. That number was an artifact. Background agents return from their tool
> call in ~130ms and then work for minutes, so every fan-out was recorded as a row of instant,
> non-overlapping nodes. On top of that each spawn was stored twice — once by the live hook, once
> by the transcript backfill — which turned solo spawns into pairs. Both are fixed: true finish
> times now come from task notifications, and duplicate rows are collapsed. The honest numbers
> are **58% of multi-agent runs never overlapped**, and **every fan-out (18 of 18) did run in
> parallel**. Every async node now has an observed finish time, so nothing is excluded. The
> remaining question is not "does parallelism work" but "why do 58% of runs never attempt it".

It's a local daemon plus hooks. Nothing leaves the machine. It fails open by design — if it breaks,
your sessions carry on as if it were never installed.

---

## Command cheatsheet

`graph` is on your PATH (symlink → `~/romp/graph-mechanism/bin/graph.mjs`).

```bash
graph stats          # shape, serialized agent-time, spend by agent type and model
graph decisions      # proposals waiting on your accept/reject
graph decide <id> accepted|rejected
graph lessons        # interventions, autonomy trend, where autonomy broke
graph runs           # recent runs: declared shape vs what actually ran
graph show <run-id>  # per-node timeline, tokens, model, edges
graph rules          # accepted lessons currently injected into every agent
graph accept "…"     # accept a lesson; every agent reads it from then on
graph library        # saved workflows + unreviewed harvest candidates
graph doctor         # is the whole thing wired up correctly
graph pause          # stop the gate blocking anything (resume with: graph resume)

graph-import [days]  # backfill from transcripts; omit days for everything
```

---

## What's installed, in four layers

### 1. Instruction tier — how work gets shaped

`~/.claude/skills/eng-task/SKILL.md` is the standing loop. Two changes matter:

- **Phase 3 now requires a declared topology**: nodes, edges, and *the named artifact that crosses
  each edge*. If you can't name what crosses, there's no dependency, and those nodes run
  concurrently. `plan-pressure-tester` attacks the shape as hard as the content.
- **Phase 5 is a pipeline, not two phases.** Implement→verify per unit with no barrier between
  them. Unit A gets verified while unit B is still being written.

`~/.claude/workflows/lib/contracts.md` holds the shared schemas (UNIT, FINDING, VERDICT, TOPOLOGY)
and the verifier lens set. Shared shapes are what let a verifier written for one task run against
another task's findings.

**Model policy** — thinking is fable, doing is opus:

| node | model |
|---|---|
| brainstorm, design, plan, plan pressure-test, synthesis | `claude-fable-5-1` |
| implementation, code pressure-test, diff verifiers | `opus` |
| classifiers, file location, grep-shaped lookup | `sonnet` / `haiku` |

Design errors propagate into every unit downstream, so the top tier buys most where the shape is
still being decided. Implementation and diff review are bounded and verifiable.

### 2. graphd — the observer and the gate

A local daemon (`~/.graphd/graph.db`, launchd label `com.chrisliu.graphd`). Zero dependencies,
Node built-ins only. Hooks on `PreToolUse`/`PostToolUse` record every `Agent` / `Workflow` /
`Skill` call: agent type, resolved model, tokens, duration, tool-call count.

**It also gates.** One rule: spawning a third agent in a run with no declared topology is denied,
with a message telling the agent exactly how to satisfy it. `Workflow` spawns are never gated — a
workflow script *is* a declared topology.

Five independent ways it gets out of your way: `graph pause`, `GRAPHD_DISABLE=1`, `enforce: false`
in config, daemon down, or a response slower than 200ms. All allow the spawn. This was deliberate —
a telemetry sidecar must never be able to take a session down.

### 3. Workflow library — recurring shapes, saved

`~/.claude/workflows/implement-verify.js`, harvested from four of your own sessions where
`general-purpose + impl-pressure-tester` ran strictly sequentially every time.

It fans implementation across units, verifies each as it lands, picks lenses per unit
(`correctness` + `repro` always; `failopen` added automatically when the unit touches
access/permission/billing/delete), isolates in worktrees only when units share files, and merges at
the one earned barrier.

### 4. Learning loop — the part that compounds

Every session, a Stop hook classifies the turn and records three kinds of signal:

| kind | meaning | what it implies |
|---|---|---|
| `interrupt` | you stopped a run mid-flight | it was going wrong and didn't notice — most expensive |
| `correction` | you redirected in a turn | a missing fact or unwritten preference |
| `self_correction` | the agent retracted its own claim | a verification gap, not a knowledge gap |

`/lesson-harvest` clusters these into themes and proposes **one artifact per theme at the most
enforceable tier that fits**: hook > skill > agent brief > memory > prose. Proposals land in the
**Decisions waiting on you** panel at the top of the dashboard, not in a report you have to go
find. Accepting a rule appends it to `~/.graphd/lessons/accepted.md`; accepting a hook registers
it in `settings.json` after backing the file up. **Every agent in `implement-verify` reads the
accepted rules before starting**, so a correction given once propagates forward.

The harvest now runs itself weekly (`com.chrisliu.graphd-harvest`, Mondays 08:45). It spends
tokens, which is why it only started after you accepted it — and it still applies nothing.

### 5. Orchestration view — what each run actually did

`graph show <run-id>`, or the **How this run was orchestrated** card in the UI:

- **delegation batches** — which agents were dispatched together vs one after another
- **attempted vs achieved** — a batch of 2+ is an attempt; overlapping execution is the
  achievement. "attempted, ran serial" is the defect worth acting on
- **what crossed** — click any node to see the prompt sent down and the result that came back
- **the decisions** — declared topology with the artifact on each edge, every gate firing, and
  every time you stepped in
- **honest gaps** — a background agent with no task notification is marked `end unknown` and
  excluded from the verdict rather than counted as parallel

---

## Why it's worth keeping — from your data, not theory

**Two measurement bugs the data caught, both mine.** The first tiering table listed `fable` as
the *cheap* tier for verifiers; `graph stats` showed it at $10/$50 per MTok, 2× opus, and both
your pressure-testers were on it. The second was worse: the parallelism metric was reading the
handoff time of background agents instead of their run time, and counting every spawn twice. It
reported 82% never-parallel. The real figure is 58%, and fan-outs succeed 18 times out of 18.
Prose review caught neither; querying real rows caught both.

**The workflow caught my correction being wrong too.** The first real `implement-verify` run —
8 agents, 26 findings — verified the async fix above and found it still broken in the permissive
direction: the notification parser read only `user` transcript entries, while 188
`queue-operation` and 50 `attachment` entries also carry notifications, so most finish times were
still being dropped. Worse, unmeasurable nodes were held open for an hour, which made two agents
that never reported a finish read as a successful fan-out — flipping a true shape mismatch to a
false all-clear. Both fixed, with seven regression tests. That is the system paying for itself:
a verifier fleet caught a defect in the very code written to make its measurements honest.

**The repeated correction.** Among your 14: *"how could i have known you didnt know that. that's
been discussed multiple times in the past other sessions and we have docs/permissionsv2."* That's
the exact cost the learning loop exists to stop — a fact re-established from scratch every session.

**Self-corrections cluster tightly.** 64 of them, and three keep recurring: acting on stale state
(stale upstream ref, stale `git status`, a file read that stopped at line 110 and concluded
absence); destructive commands before inspecting (`kill` on an unknown port, `git add -A` sweeping a
probe file, `--no-verify` over live work); and blaming flakiness before own code. Each is now a
proposed rule rather than a lesson you re-teach.

---

## How to use it

### Daily — nothing

It's passive. Hooks record; the daemon runs under launchd. The only thing you'll notice is the gate,
and only if an agent tries to fan out without declaring a shape. When that happens the deny message
says how to fix it. If it's ever wrong, `graph pause`.

### Weekly — one command, five minutes

The backfill runs itself: a launchd agent (`com.chrisliu.graphd-import`) refreshes the store every
Monday at 08:17. It only reads local files and writes SQLite — no model tokens — so it is safe
unattended. The harvest that *interprets* the data stays manual, because that one costs tokens.

```bash
graph stats       # did shapes improve? where did spend go?
graph lessons     # did interventions per session drop?
graph-import 7    # only if you want a mid-week refresh
```

Then run `/lesson-harvest` in a session. It writes a report to
`~/.claude/telemetry/reports/`, proposes rules, and applies nothing. Accept what you agree with:

```bash
graph accept "Never attribute a test failure to flakiness without re-running it in isolation."
```

**The number to watch is interventions per session.** Currently ~1.5, flat since W33. That's the
autonomy metric — how often a run needed you. A harvest that doesn't plausibly lower it did nothing.

### When you have parallel work

```
Run the implement-verify workflow on these units: [...]
```

Or let eng-task do it: with 6+ independent units it now prefers writing a Workflow script over
coordinating in-thread, because coordination in code costs zero model tokens.

### The UI

`http://127.0.0.1:8787/` — run list with verdicts, a timeline where a fan-out reads as overlapping
bars and a chain reads as a staircase, workflow library with promote/reject buttons, health, policy
checks, invocation log. Enforcement and pause toggle from the header. Light and dark both validated.

Remote: token auth is already on every request, so put a tunnel in front
(`cloudflared tunnel --url http://127.0.0.1:8787`) and set `GRAPHD_URL`. Verified over LAN; the
tunnel path itself is untested.

---

## Limits — read this before trusting a number

- **Spend is a floor, not a bill.** Only 34 of 179 recorded agents carry token counts; older
  transcripts predate the field. Cost is estimated from published rates with an assumed 90% input
  split, not billed.
- **Interventions per session is a floor too.** Every time you shrugged and fixed something
  yourself, there's no transcript signal. Invisible by construction.
- **Observed edges are timing-derived, not real dependencies.** The harness exposes no parent id, so
  "B waited on A" means "A had finished when B started". Good enough to separate a chain from a
  fan-out; not a true dependency graph.
- **`implement-verify` has run once**, in `verify-only` mode. Parallel-implement mode is still
  unexercised and stays off unless asked for by name.
- **Unmeasurable nodes are excluded, never assumed.** An async node with no notification makes
  `observedShape` return `unknown` and `isMismatch` null rather than guessing. Currently 0 of 57.
  `graph doctor` warns if that share passes 40%.
- **The gate's one live deny was a false positive**, now fixed: it counted agents from a 5-day-old
  session against a decision made today. The rule is windowed to the last 30 minutes.
- **Learning is one hop from live.** Interventions are captured in real time; they become *rules*
  only when you accept one. That gate is deliberate — these files govern every future session.

---

## What's next, ranked

1. **Nothing is blocked.** `implement-verify` has run (8 agents, 26 findings, 3 real bugs fixed)
   and fires automatically: eng-task Phase 5 instructs the call, which is itself the opt-in.
2. **Find out why 58% of multi-agent runs never attempt a fan-out.** Parallelism works when
   tried; the gap is in the deciding, not the executing. That is a question for the next harvest.
3. **Per-node cost in the UI** — the data is there, the run detail doesn't show dollars yet.
4. **The UI is functional, not good.** Known, deprioritized at your call.
