import { readProposals } from "./proposals.mjs";
import { autonomyTrend } from "./lessons.mjs";
import { commandShape } from "./interventions.mjs";

const MILLISECONDS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const TURNS_PER_MEASURE = 100;

/**
 * Substantive interventions needed before a per-rule before/after rate means anything.
 * Below this the comparison is noise dressed as a verdict.
 */
export const MINIMUM_SAMPLE_FOR_A_VERDICT = 30;

const BARE_INTERRUPT_MARKER = "Request interrupted by user";
const RECENT_STOP_LIMIT = 8;

/** Themes in the interventions that carry text, as patterns over the quote. */
export const INTERVENTION_THEMES = [
  {
    id: "standing-rule",
    label: "stated a standing preference that should have been a durable rule",
    pattern:
      /\b(add this to your|coding principles|i (don'?t|dont|do not) want (my|your|you|them|it)\b|i prefer|why can you not|always have|from now on|never .* again|keep context clean)/i,
  },
  {
    id: "tooling-broken",
    label: "the tooling or the session itself stopped working",
    pattern:
      /\b(not working|isn'?t working|not taking messages|not showing up|stuck|hung|hanging|no agent executing|not in working status|nothing seemed to be invoked|what is happening here)\b/i,
  },
  {
    id: "impatience",
    label: "made to wait — too slow, or stopping when it should have continued",
    pattern:
      /\b(wait|waiting|dont stop|don'?t stop|keep going|too long|annoying|taking so long|go ahead|until you finished)\b/i,
  },
  {
    id: "wrong-target",
    label: "worked on the wrong thing",
    pattern:
      /\b(that'?s not|i asked for|not what i|instead of|you only did|i meant|revert|no[,.]? i|my bad)\b/i,
  },
  {
    id: "wrong-technical-call",
    label: "wrong technical decision, corrected with specifics",
    pattern:
      /\b(should consult|dual-?read|backfill|enqueue|the row|prod|staging|cron|dlq|lambda|event driven|why are the workers|job runner|celery)\b/i,
  },
  {
    id: "unreadable-output",
    label: "the report or PR text was not usable as written",
    pattern:
      /\b(hard to read|lost my trust|just give me|corrected handoff|declarative and honest|still hard)\b/i,
  },
];

/** Human interventions only; a self-correction is the agent catching itself. */
function humanInterventions(store) {
  return store
    .prepare(
      `SELECT ts, kind, quote, followup_quote, preceding_tool, run_id FROM interventions
        WHERE kind != 'self_correction' ORDER BY ts`,
    )
    .all();
}

/** Whether a quote is a bare stop with no text of its own. */
export function checkIsBareInterrupt(quote) {
  return typeof quote !== "string" || quote.includes(BARE_INTERRUPT_MARKER);
}

/**
 * Why the human stepped in, or null when nothing says.
 * Stopping and saying what was wrong are two turns, so a bare interrupt's reason is the text of
 * the turn that followed it.
 */
export function reasonFor(intervention) {
  if (!checkIsBareInterrupt(intervention?.quote)) return intervention.quote;
  return intervention?.followup_quote ?? null;
}

/**
 * What the intervention record is actually made of.
 * A bare interrupt says a human stopped the work but not what was wrong, so it can carry no
 * lesson and no rule can be measured against it.
 */
export function interventionQuality(store) {
  const interventions = humanInterventions(store);
  const withReason = interventions.filter((row) => reasonFor(row) !== null);
  const deduped = new Set(withReason.map((row) => reasonFor(row).trim())).size;
  const statedInTheNextTurn = withReason.filter((row) => checkIsBareInterrupt(row.quote)).length;
  return {
    total: interventions.length,
    bareInterrupts: interventions.length - withReason.length,
    statedInTheNextTurn,
    withReason: withReason.length,
    distinctReasons: deduped,
    duplicateReasons: withReason.length - deduped,
  };
}

/** Where bare interrupts land, which is the closest thing to a reason they have. */
export function bareInterruptSurfaces(store) {
  return store
    .prepare(
      `SELECT COALESCE(preceding_tool, '(mid-response)') AS surface, COUNT(*) AS count
         FROM interventions
        WHERE kind != 'self_correction' AND quote LIKE '%' || ? || '%'
        GROUP BY surface ORDER BY count DESC`,
    )
    .all(BARE_INTERRUPT_MARKER);
}

/**
 * What kind of command the bare interrupts landed on, counted by command shape.
 * The surface breakdown says "Bash" for most stops, which names the tool and not the behavior;
 * the shape says whether the stop is about waiting on a test run or about a wrong `git` call.
 * Bash only — a Read's path is not a command and would not group.
 */
export function stoppedCommandShapes(store) {
  const rows = store
    .prepare(
      `SELECT preceding_detail AS detail FROM interventions
        WHERE kind != 'self_correction' AND quote LIKE '%' || ? || '%'
          AND preceding_tool = 'Bash' AND preceding_detail IS NOT NULL`,
    )
    .all(BARE_INTERRUPT_MARKER);
  const counts = new Map();
  for (const row of rows) {
    const shape = commandShape(row.detail) ?? "(unparsed)";
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return [...counts]
    .map(([shape, count]) => ({ shape, count }))
    .sort((left, right) => right.count - left.count);
}

/** The most recent bare interrupts with the command that was stopped, for reading directly. */
export function recentStoppedCommands(store, limit = RECENT_STOP_LIMIT) {
  return store
    .prepare(
      `SELECT ts, preceding_tool AS tool, preceding_detail AS detail FROM interventions
        WHERE kind != 'self_correction' AND quote LIKE '%' || ? || '%'
          AND preceding_tool = 'Bash' AND preceding_detail IS NOT NULL
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(BARE_INTERRUPT_MARKER, limit);
}

/** The interventions that carry a reason, bucketed by theme. Unmatched ones are reported too. */
export function themeBreakdown(store) {
  const withReason = humanInterventions(store).filter((row) => reasonFor(row) !== null);
  const counts = INTERVENTION_THEMES.map((theme) => ({
    ...theme,
    count: withReason.filter((row) => theme.pattern.test(reasonFor(row))).length,
  }));
  const matchedAny = withReason.filter((row) =>
    INTERVENTION_THEMES.some((theme) => theme.pattern.test(reasonFor(row))),
  ).length;
  return { themes: counts.sort((left, right) => right.count - left.count), sampleSize: withReason.length, unmatched: withReason.length - matchedAny };
}

/**
 * Whether the record can support judging a rule at all.
 * Reports the shortfall rather than emitting a verdict per rule, because a before/after rate
 * built on a handful of quotes reads as evidence while carrying none.
 */
export function ruleEvaluationPower(store, nowMs = Date.now()) {
  const withReason = humanInterventions(store).filter((row) => reasonFor(row) !== null);
  const acceptedRules = readProposals().filter(
    (proposal) => proposal.status === "accepted" && proposal.kind === "rule",
  );
  const spanDays =
    withReason.length > 0
      ? (nowMs - Date.parse(withReason[0].ts)) / MILLISECONDS_PER_DAY
      : 0;
  return {
    acceptedRuleCount: acceptedRules.length,
    sampleSize: withReason.length,
    spanDays: Math.round(spanDays),
    ratePerWeek: spanDays > 0 ? (withReason.length / spanDays) * DAYS_PER_WEEK : 0,
    isPowered: withReason.length >= MINIMUM_SAMPLE_FOR_A_VERDICT,
    shortfall: Math.max(0, MINIMUM_SAMPLE_FOR_A_VERDICT - withReason.length),
    rules: acceptedRules.map((proposal) => ({ id: proposal.id, decidedAt: proposal.decidedAt })),
  };
}

/** Assistant turns per week: how much work actually happened, not how long the clock ran. */
export function weeklyTurns(store) {
  return store
    .prepare(
      `SELECT strftime('%Y-W%W', started_at) AS week, SUM(turn_count) AS turnCount
         FROM sessions GROUP BY week`,
    )
    .all();
}

/**
 * The autonomy trend with a workload denominator beside the session one.
 * A week of many short sessions lowers a per-session rate without any autonomy gain, so
 * `per100Turns` is the series to trust when the two disagree.
 */
export function autonomyPerWorkload(trend, turns) {
  const turnsByWeek = new Map(turns.map((row) => [row.week, row.turnCount]));
  return trend.map((row) => {
    const turnCount = turnsByWeek.get(row.week) ?? 0;
    return {
      ...row,
      turnCount,
      per100Turns:
        turnCount > 0 ? (row.humanCount / turnCount) * TURNS_PER_MEASURE : null,
    };
  });
}

/** Everything `graph eval` prints: what the record is made of, and whether it can judge a rule. */
export function computeEvaluation(store) {
  return {
    quality: interventionQuality(store),
    bareInterruptSurfaces: bareInterruptSurfaces(store),
    stoppedCommandShapes: stoppedCommandShapes(store),
    recentStoppedCommands: recentStoppedCommands(store),
    themes: themeBreakdown(store),
    power: ruleEvaluationPower(store),
    trend: autonomyPerWorkload(autonomyTrend(store), weeklyTurns(store)),
  };
}
