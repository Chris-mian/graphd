import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PICKS_DB_PATH =
  process.env.GRAPHD_SPINE_PICKS_PATH ??
  join(homedir(), ".local", "state", "spine", "picks.sqlite3");

const UNKNOWN_SESSION_ID = "unknown";
const AMBIGUOUS_CONFIDENCE = 0;

const PICKS_SQL = `
  SELECT session_id AS sessionId,
         project_slug AS projectSlug,
         MAX(confidence) AS confidence
    FROM picks
   WHERE session_id != ?
   GROUP BY session_id, project_slug`;

/**
 * Which projects each session attached to, and whether spine actually resolved one.
 * graphd knows what an agent cost and spine knows what it was for; the session id is the only
 * thing both write. A zero-confidence row means the session was tied between the listed
 * projects, so it is traceable but not attributable. Empty map when spine is not installed.
 */
export function readSessionProjects(picksPath = PICKS_DB_PATH) {
  if (!existsSync(picksPath)) return new Map();
  let picks;
  try {
    picks = new DatabaseSync(picksPath, { readOnly: true });
  } catch {
    return new Map();
  }
  try {
    const bySession = new Map();
    for (const row of picks.prepare(PICKS_SQL).all(UNKNOWN_SESSION_ID)) {
      const attachment = bySession.get(row.sessionId) ?? { slugs: [], isResolved: false };
      attachment.slugs.push(row.projectSlug);
      if (row.confidence > AMBIGUOUS_CONFIDENCE) attachment.isResolved = true;
      bySession.set(row.sessionId, attachment);
    }
    return bySession;
  } catch {
    return new Map();
  } finally {
    picks.close();
  }
}

/**
 * Spend and node counts per project, plus what could not be placed.
 * Three buckets, because they mean different things: a resolved session lands on its project,
 * a tied session is reported as ambiguous rather than split across its candidates, and a
 * session spine never saw is unattributed. A session resolved to two projects counts toward
 * both; the alternative is dropping it, which hides real spend.
 */
export function spendByProject(store, picksPath = PICKS_DB_PATH) {
  const bySession = readSessionProjects(picksPath);
  const rows = store
    .prepare(
      `SELECT runs.session_id AS sessionId,
              COUNT(nodes.id) AS nodeCount,
              SUM(COALESCE(nodes.total_tokens, 0)) AS tokens
         FROM nodes JOIN runs ON runs.id = nodes.run_id
        GROUP BY runs.session_id`,
    )
    .all();

  const totals = new Map();
  let unattributedNodes = 0;
  let unattributedTokens = 0;
  let ambiguousNodes = 0;
  let ambiguousTokens = 0;
  for (const row of rows) {
    const attachment = bySession.get(row.sessionId);
    if (!attachment || attachment.slugs.length === 0) {
      unattributedNodes += row.nodeCount;
      unattributedTokens += row.tokens;
      continue;
    }
    if (!attachment.isResolved) {
      ambiguousNodes += row.nodeCount;
      ambiguousTokens += row.tokens;
      continue;
    }
    for (const slug of attachment.slugs) {
      const totalForSlug = totals.get(slug) ?? { slug, nodeCount: 0, tokens: 0, sessionCount: 0 };
      totalForSlug.nodeCount += row.nodeCount;
      totalForSlug.tokens += row.tokens;
      totalForSlug.sessionCount += 1;
      totals.set(slug, totalForSlug);
    }
  }
  return {
    projects: [...totals.values()].sort((left, right) => right.tokens - left.tokens),
    ambiguousNodes,
    ambiguousTokens,
    unattributedNodes,
    unattributedTokens,
    attributedSessions: bySession.size,
  };
}
