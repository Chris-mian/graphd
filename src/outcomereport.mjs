/**
 * Faster and better, per implementation mode: how long the work behind a PR took, and what became
 * of it. A session's arm is the mode its implement-verify runs used.
 */

/** The parallel-implementation trial alternates arms from this day on. */
export const TRIAL_START = "2026-11-10";
/** Below this many PRs an arm's averages are noise, and are labelled so. */
export const MIN_PRS_PER_ARM = 5;

export const ARM_PARALLEL = "parallel";
export const ARM_VERIFY_ONLY = "verify-only";
export const ARM_MIXED = "mixed";
export const ARM_NONE = "no workflow";
const ARMS = [ARM_PARALLEL, ARM_VERIFY_ONLY, ARM_MIXED, ARM_NONE];
const UNIT_BUCKETS = [
  { label: "1 unit", min: 1, max: 1 },
  { label: "2-3 units", min: 2, max: 3 },
  { label: "4+ units", min: 4, max: Infinity },
];
const MILLISECONDS_PER_MINUTE = 60_000;
const HUMAN_KINDS = ["interrupt", "correction"];

function parseJson(text) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
}

/** Each session's arm, widest implement-verify run, and surviving findings per unit. */
function sessionWorkflowFacts(store) {
  const facts = new Map();
  const rows = store
    .prepare(
      `SELECT n.run_id AS session_id, n.workflow_mode, n.result_text FROM nodes n
       WHERE n.tool = 'Workflow' AND n.workflow_mode IS NOT NULL AND COALESCE(n.status, '') <> 'rejected'`,
    )
    .all();
  for (const row of rows) {
    const fact = facts.get(row.session_id) ?? { modes: new Set(), unitCount: 0, units: 0, surviving: 0 };
    fact.modes.add(row.workflow_mode);
    const result = parseJson(row.result_text);
    if (Number.isFinite(result?.unitCount) && Number.isFinite(result?.findingsSurviving)) {
      fact.unitCount = Math.max(fact.unitCount, result.unitCount);
      fact.units += result.unitCount;
      fact.surviving += result.findingsSurviving;
    }
    facts.set(row.session_id, fact);
  }
  return facts;
}

function armOf(fact) {
  if (!fact) return ARM_NONE;
  if (fact.modes.size > 1) return ARM_MIXED;
  return fact.modes.has(ARM_PARALLEL) ? ARM_PARALLEL : ARM_VERIFY_ONLY;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** One arm's speed and outcome figures over its PRs and the sessions that opened them. */
function summarizeArm(arm, pullRequests, facts, humanBySession) {
  const sessions = [...new Set(pullRequests.map((pullRequest) => pullRequest.session_id))];
  const merged = pullRequests.filter((pullRequest) => pullRequest.state === "MERGED");
  const settled = merged.filter((pullRequest) => pullRequest.followup_commits != null);
  const units = sessions.reduce((sum, sessionId) => sum + (facts.get(sessionId)?.units ?? 0), 0);
  const surviving = sessions.reduce((sum, sessionId) => sum + (facts.get(sessionId)?.surviving ?? 0), 0);
  const timed = pullRequests.filter((pullRequest) => pullRequest.active_ms_to_open != null);
  return {
    arm,
    prCount: pullRequests.length,
    sessionCount: sessions.length,
    isTooFew: pullRequests.length < MIN_PRS_PER_ARM,
    medianActiveMinutesToOpen: median(timed.map((pullRequest) => pullRequest.active_ms_to_open / MILLISECONDS_PER_MINUTE)),
    mergedShare: pullRequests.length ? merged.length / pullRequests.length : null,
    commitsAfterOpen: mean(pullRequests.filter((pullRequest) => pullRequest.commits_after_open != null).map((pullRequest) => pullRequest.commits_after_open)),
    settledCount: settled.length,
    followupsPerMerged: mean(settled.map((pullRequest) => pullRequest.followup_commits)),
    fixFollowupsPerMerged: mean(settled.map((pullRequest) => pullRequest.followup_fix_commits)),
    revertedCount: settled.filter((pullRequest) => pullRequest.reverted === 1).length,
    survivingFindingsPerUnit: units > 0 ? surviving / units : null,
    humanPerSession: sessions.length ? sessions.reduce((sum, sessionId) => sum + (humanBySession.get(sessionId) ?? 0), 0) / sessions.length : null,
  };
}

function humanCountsBySession(store) {
  const placeholders = HUMAN_KINDS.map(() => "?").join(", ");
  const rows = store
    .prepare(`SELECT run_id, COUNT(*) AS humanCount FROM interventions WHERE kind IN (${placeholders}) GROUP BY run_id`)
    .all(...HUMAN_KINDS);
  return new Map(rows.map((row) => [row.run_id, row.humanCount]));
}

function armTable(pullRequests, facts, humanBySession) {
  const byArm = new Map(ARMS.map((arm) => [arm, []]));
  for (const pullRequest of pullRequests) byArm.get(armOf(facts.get(pullRequest.session_id))).push(pullRequest);
  return ARMS.map((arm) => summarizeArm(arm, byArm.get(arm), facts, humanBySession)).filter((row) => row.prCount > 0);
}

/**
 * The arm the next implement-verify run should take, so both arms of the trial stay
 * contemporaneous: whichever has fewer trial sessions, parallel on a tie.
 */
function nextArm(trialRows) {
  const countOf = (arm) => trialRows.find((row) => row.arm === arm)?.sessionCount ?? 0;
  return countOf(ARM_PARALLEL) <= countOf(ARM_VERIFY_ONLY) ? ARM_PARALLEL : ARM_VERIFY_ONLY;
}

/** Arms over all PRs, over the trial window, and the trial window split by run width. */
export function computeOutcomes(store) {
  const facts = sessionWorkflowFacts(store);
  const humanBySession = humanCountsBySession(store);
  const pullRequests = store.prepare("SELECT * FROM prs ORDER BY opened_at").all();
  const inTrial = pullRequests.filter((pullRequest) => pullRequest.opened_at >= TRIAL_START);
  const trialArms = armTable(inTrial, facts, humanBySession);
  const byWidth = UNIT_BUCKETS.map((bucket) => ({
    bucket: bucket.label,
    arms: armTable(
      pullRequests.filter((pullRequest) => {
        const width = facts.get(pullRequest.session_id)?.unitCount ?? 0;
        return width >= bucket.min && width <= bucket.max;
      }),
      facts,
      humanBySession,
    ),
  }));
  return {
    trialStart: TRIAL_START,
    allTime: armTable(pullRequests, facts, humanBySession),
    trial: trialArms,
    byWidth,
    nextArm: nextArm(trialArms),
    pendingCount: pullRequests.filter((pullRequest) => !pullRequest.outcome_final).length,
    unfetchedCount: pullRequests.filter((pullRequest) => !pullRequest.fetched_at).length,
  };
}
