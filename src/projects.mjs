import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dedupeNodes, spendNodes } from "./analysis.mjs";
import { nodeTokens } from "./pricing.mjs";

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

/** Runs a read against spine's picks database; `fallback` when spine is absent or unreadable. */
function readPicks(picksPath, fallback, read) {
  if (!existsSync(picksPath)) return fallback;
  let picks;
  try {
    picks = new DatabaseSync(picksPath, { readOnly: true });
  } catch {
    return fallback;
  }
  try {
    return read(picks);
  } catch {
    return fallback;
  } finally {
    picks.close();
  }
}

/**
 * Which projects each session attached to, and which of those spine actually resolved.
 * graphd knows what an agent cost and spine knows what it was for; the session id is the only
 * thing both write. A zero-confidence row is a candidate spine could not choose between, so it
 * is traceable but not attributable. Empty map when spine is not installed.
 */
export function readSessionProjects(picksPath = PICKS_DB_PATH) {
  return readPicks(picksPath, new Map(), (picks) => {
    const bySession = new Map();
    for (const row of picks.prepare(PICKS_SQL).all(UNKNOWN_SESSION_ID)) {
      const attachment = bySession.get(row.sessionId) ?? {
        slugs: [],
        resolvedSlugs: [],
        isResolved: false,
      };
      attachment.slugs.push(row.projectSlug);
      if (row.confidence > AMBIGUOUS_CONFIDENCE) {
        attachment.resolvedSlugs.push(row.projectSlug);
        attachment.isResolved = true;
      }
      bySession.set(row.sessionId, attachment);
    }
    return bySession;
  });
}

/** Tokens and deduplicated node counts per session. */
function spendBySession(store) {
  const nodes = store
    .prepare(
      `SELECT nodes.*, runs.session_id AS session_id
         FROM nodes JOIN runs ON runs.id = nodes.run_id`,
    )
    .all();
  const bySession = new Map();
  for (const node of spendNodes(dedupeNodes(nodes))) {
    const session = bySession.get(node.session_id) ?? { sessionId: node.session_id, nodeCount: 0, tokens: 0 };
    session.nodeCount += 1;
    session.tokens += nodeTokens(node);
    bySession.set(node.session_id, session);
  }
  return [...bySession.values()];
}

/**
 * Spend and node counts per project, plus what could not be placed.
 * A session lands on every project spine resolved it to — counted toward each rather than
 * dropped — and never on a zero-confidence candidate. A session with no resolved project is
 * tied; one spine never recorded is unattributed.
 */
export function spendByProject(store, picksPath = PICKS_DB_PATH) {
  const bySession = readSessionProjects(picksPath);

  const totals = new Map();
  const ambiguousCandidateCounts = new Map();
  let unattributedNodes = 0;
  let unattributedTokens = 0;
  let ambiguousNodes = 0;
  let ambiguousTokens = 0;
  for (const session of spendBySession(store)) {
    const attachment = bySession.get(session.sessionId);
    if (!attachment || attachment.slugs.length === 0) {
      unattributedNodes += session.nodeCount;
      unattributedTokens += session.tokens;
      continue;
    }
    if (!attachment.isResolved) {
      ambiguousNodes += session.nodeCount;
      ambiguousTokens += session.tokens;
      for (const slug of attachment.slugs) {
        ambiguousCandidateCounts.set(slug, (ambiguousCandidateCounts.get(slug) ?? 0) + 1);
      }
      continue;
    }
    for (const slug of attachment.resolvedSlugs) {
      const totalForSlug = totals.get(slug) ?? { slug, nodeCount: 0, tokens: 0, sessionCount: 0 };
      totalForSlug.nodeCount += session.nodeCount;
      totalForSlug.tokens += session.tokens;
      totalForSlug.sessionCount += 1;
      totals.set(slug, totalForSlug);
    }
  }
  return {
    projects: [...totals.values()].sort((left, right) => right.tokens - left.tokens),
    ambiguousNodes,
    ambiguousTokens,
    ambiguousCandidates: [...ambiguousCandidateCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([slug]) => slug),
    unattributedNodes,
    unattributedTokens,
    attributedSessions: bySession.size,
  };
}
