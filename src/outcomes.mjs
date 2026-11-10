/**
 * What became of a pull request, derived from GitHub's answers. Pure: graph-outcomes does the
 * fetching, this decides what the answers mean.
 */

export const FOLLOWUP_WINDOW_MS = 7 * 86_400_000;
/** Files whose follow-up history is read per PR; each costs one API call. */
export const MAX_FOLLOWUP_FILES = 10;
export const PR_VIEW_FIELDS = "state,title,createdAt,mergedAt,closedAt,baseRefName,author,files,commits,mergeCommit";

const FIX_MESSAGE_PATTERN = /\b(fix(es|ed)?|revert(s|ed)?|hotfix|bug)\b/i;
const REVERT_HEADLINE_PATTERN = /^Revert\b/;
const SQUASH_PR_NUMBER_PATTERN = /\(#(\d+)\)\s*$/;
const STATE_MERGED = "MERGED";
const STATE_CLOSED = "CLOSED";

/** The account that can read a repo, by owner. Personal repos belong to the personal account. */
export function accountForRepo(repo, { personalOwners, personalAccount, workAccount }) {
  const owner = repo.split("/")[0];
  return personalOwners.includes(owner) ? personalAccount : workAccount;
}

/** Whether a merged PR's follow-up window has closed, so its outcome can no longer change. */
export function isFollowupWindowClosed(mergedAt, nowMs) {
  return Boolean(mergedAt) && nowMs >= Date.parse(mergedAt) + FOLLOWUP_WINDOW_MS;
}

/** The `since`/`until` bounds of the follow-up window. */
export function followupWindow(mergedAt) {
  const mergedMs = Date.parse(mergedAt);
  return { since: mergedAt, until: new Date(mergedMs + FOLLOWUP_WINDOW_MS).toISOString() };
}

/** Commits made after the PR opened, by author date, so a rebase does not count as rework. */
function commitsAfterOpen(view) {
  const openedMs = Date.parse(view.createdAt);
  return (view.commits ?? []).filter((commit) => Date.parse(commit.authoredDate) > openedMs).length;
}

function isRevertOf(view, prNumber, message) {
  const [headline] = message.split("\n");
  if (!REVERT_HEADLINE_PATTERN.test(headline)) return false;
  return message.includes(`#${prNumber}`) || (Boolean(view.title) && message.includes(view.title));
}

/** The PR a squash-merge commit landed, from the `(#123)` its headline ends with. */
function squashedPrNumber(message) {
  const match = SQUASH_PR_NUMBER_PATTERN.exec(message.split("\n")[0]);
  return match ? Number(match[1]) : null;
}

/**
 * Follow-up commits that are not the PR's own, nor the landing of a PR already open before it
 * merged: the next PR of a stack is planned work, not rework. `candidates` are base-branch
 * commits by the PR's author, touching its files, inside the window: `{ sha, message }`.
 */
function followupsOf(view, candidates, plannedPrNumbers) {
  const ownShas = new Set((view.commits ?? []).map((commit) => commit.oid));
  if (view.mergeCommit?.oid) ownShas.add(view.mergeCommit.oid);
  const unique = new Map();
  for (const candidate of candidates) {
    if (ownShas.has(candidate.sha) || plannedPrNumbers.has(squashedPrNumber(candidate.message))) continue;
    unique.set(candidate.sha, candidate);
  }
  return [...unique.values()];
}

/**
 * A PR's outcome columns from its `gh pr view` JSON and, once its window has closed, the
 * follow-up candidates. Follow-up columns stay null until then. `plannedPrNumbers` are the
 * repo's PRs that were already open when this one merged.
 */
export function deriveOutcome({ view, prNumber, followupCandidates = null, plannedPrNumbers = new Set(), nowMs }) {
  const isClosedUnmerged = view.state === STATE_CLOSED && !view.mergedAt;
  const isWindowClosed = view.state === STATE_MERGED && isFollowupWindowClosed(view.mergedAt, nowMs);
  const followups = isWindowClosed && followupCandidates ? followupsOf(view, followupCandidates, plannedPrNumbers) : null;
  return {
    author: view.author?.login ?? null,
    state: view.state ?? null,
    mergedAt: view.mergedAt || null,
    closedAt: view.closedAt || null,
    baseRef: view.baseRefName ?? null,
    fileCount: (view.files ?? []).length,
    commitsAfterOpen: commitsAfterOpen(view),
    followupCommits: followups ? followups.length : null,
    followupFixCommits: followups ? followups.filter((commit) => FIX_MESSAGE_PATTERN.test(commit.message)).length : null,
    followupShas: followups ? JSON.stringify(followups.map((commit) => commit.sha)) : null,
    reverted: followups ? Number(followups.some((commit) => isRevertOf(view, prNumber, commit.message))) : null,
    isFinal: isClosedUnmerged || (isWindowClosed && followups !== null),
  };
}
