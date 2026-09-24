import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PICKS_DB_PATH =
  process.env.GRAPHD_SPINE_PICKS_PATH ??
  join(homedir(), ".local", "state", "spine", "picks.sqlite3");

const UNKNOWN_SESSION_ID = "unknown";

const PICKS_SQL = `
  SELECT session_id AS sessionId, project_slug AS projectSlug
    FROM picks
   WHERE session_id != ?
   GROUP BY session_id, project_slug`;

/**
 * Which project each session was working on, as spine recorded it.
 * graphd knows what an agent cost and spine knows what it was for; the session id is the only
 * thing both write. Returns an empty map when spine is not installed — graphd does not depend
 * on it.
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
      if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []);
      bySession.get(row.sessionId).push(row.projectSlug);
    }
    return bySession;
  } catch {
    return new Map();
  } finally {
    picks.close();
  }
}

/**
 * Spend and node counts per project, plus what could not be attributed.
 * A session spine attached to two projects contributes to both, so the shares can exceed the
 * total; the alternative is dropping the session, which hides real spend.
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
  for (const row of rows) {
    const slugs = bySession.get(row.sessionId);
    if (!slugs || slugs.length === 0) {
      unattributedNodes += row.nodeCount;
      unattributedTokens += row.tokens;
      continue;
    }
    for (const slug of slugs) {
      const totalForSlug = totals.get(slug) ?? { slug, nodeCount: 0, tokens: 0, sessionCount: 0 };
      totalForSlug.nodeCount += row.nodeCount;
      totalForSlug.tokens += row.tokens;
      totalForSlug.sessionCount += 1;
      totals.set(slug, totalForSlug);
    }
  }
  return {
    projects: [...totals.values()].sort((left, right) => right.tokens - left.tokens),
    unattributedNodes,
    unattributedTokens,
    attributedSessions: bySession.size,
  };
}
