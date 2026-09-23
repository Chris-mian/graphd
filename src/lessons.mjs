const RECENT_QUOTE_LIMIT = 25;
const TOP_LIST_LENGTH = 8;

/**
 * Interventions per session, by week. `perSession` is the autonomy metric and counts
 * interrupts and corrections only; self-corrections get their own series.
 *
 * The denominator is every session that week, taken from `sessions`. Counting distinct
 * `run_id` within `interventions` would exclude clean sessions, so the rate could never fall
 * as autonomy improved.
 */
export function autonomyTrend(store) {
  return store
    .prepare(
      `WITH weekly_sessions AS (
         SELECT strftime('%Y-W%W', started_at) AS week, COUNT(*) AS sessionCount
           FROM sessions
          GROUP BY week
       ),
       weekly_interventions AS (
         SELECT strftime('%Y-W%W', ts) AS week,
                COUNT(*) AS interventionCount,
                SUM(kind = 'interrupt') AS interruptCount,
                SUM(kind = 'correction') AS correctionCount,
                SUM(kind = 'self_correction') AS selfCorrectionCount
           FROM interventions
          GROUP BY week
       )
       SELECT weekly_sessions.week AS week,
              weekly_sessions.sessionCount AS sessionCount,
              COALESCE(weekly_interventions.interventionCount, 0) AS interventionCount,
              COALESCE(weekly_interventions.interruptCount, 0) AS interruptCount,
              COALESCE(weekly_interventions.correctionCount, 0) AS correctionCount,
              COALESCE(weekly_interventions.selfCorrectionCount, 0) AS selfCorrectionCount
         FROM weekly_sessions
         LEFT JOIN weekly_interventions ON weekly_interventions.week = weekly_sessions.week
        ORDER BY weekly_sessions.week`,
    )
    .all()
    .map((row) => {
      const humanCount = row.interruptCount + row.correctionCount;
      return {
        ...row,
        humanCount,
        perSession: row.sessionCount > 0 ? humanCount / row.sessionCount : 0,
        selfCorrectionPerSession:
          row.sessionCount > 0 ? row.selfCorrectionCount / row.sessionCount : 0,
      };
    });
}

/** Which tool the agent had just run when a human stepped in — where autonomy breaks down. */
export function interventionSurfaces(store) {
  return store
    .prepare(
      `SELECT COALESCE(preceding_tool, 'no tool — mid-response') AS surface, COUNT(*) AS count
         FROM interventions
        WHERE kind != 'self_correction'
        GROUP BY surface
        ORDER BY count DESC
        LIMIT ?`,
    )
    .all(TOP_LIST_LENGTH);
}

function projectOf(cwd) {
  if (!cwd) return "unknown";
  return cwd.split("/").filter(Boolean).slice(-1)[0] ?? "unknown";
}

/** Interventions grouped by project, so a recurring gap in one repo is visible as one. */
export function interventionsByProject(store) {
  const rows = store.prepare("SELECT cwd, kind FROM interventions").all();
  const byProject = new Map();
  for (const row of rows) {
    const key = projectOf(row.cwd);
    const bucket = byProject.get(key) ?? { project: key, total: 0, humanCount: 0 };
    bucket.total += 1;
    if (row.kind !== "self_correction") bucket.humanCount += 1;
    byProject.set(key, bucket);
  }
  return [...byProject.values()]
    .sort((left, right) => right.humanCount - left.humanCount)
    .slice(0, TOP_LIST_LENGTH);
}

/** Everything `/lesson-harvest` reads: counts, trend, surfaces, and the quotes themselves. */
export function computeLessons(store, quoteLimit = RECENT_QUOTE_LIMIT) {
  const counts = store
    .prepare("SELECT kind, COUNT(*) AS count FROM interventions GROUP BY kind")
    .all();
  return {
    counts,
    total: counts.reduce((sum, row) => sum + row.count, 0),
    trend: autonomyTrend(store),
    surfaces: interventionSurfaces(store),
    byProject: interventionsByProject(store),
    recent: store
      .prepare(
        `SELECT ts, kind, quote, preceding_tool, cwd, run_id
           FROM interventions ORDER BY ts DESC LIMIT ?`,
      )
      .all(quoteLimit),
  };
}
