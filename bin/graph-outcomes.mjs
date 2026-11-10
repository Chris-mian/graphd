#!/usr/bin/env node
// Fetches what became of every PR graph-import linked to a session, until its outcome is final.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { openStore, nowIso } from "../src/db.mjs";
import {
  MAX_FOLLOWUP_FILES,
  PR_VIEW_FIELDS,
  accountForRepo,
  deriveOutcome,
  followupWindow,
  isFollowupWindowClosed,
} from "../src/outcomes.mjs";

const GH_CANDIDATE_PATHS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const ACCOUNTS = {
  personalOwners: ["Chris-mian", "romp-on"],
  personalAccount: "Chris-mian",
  workAccount: "chrisliu-suno",
};
const COMMITS_PER_PAGE = 100;
const MAX_ERROR_CHARS = 500;
const GH_TIMEOUT_MS = 60_000;
const BRANCH_NOT_FOUND = "HTTP 404";

// launchd starts with a bare PATH, so the binary is found by absolute path first.
const ghPath = process.env.GRAPHD_GH ?? GH_CANDIDATE_PATHS.find((path) => existsSync(path)) ?? "gh";
const tokenByAccount = new Map();

/**
 * A token per account, passed to one gh call at a time. `gh auth switch` would change the active
 * account for every other shell and agent on the machine.
 */
function tokenFor(account) {
  if (!tokenByAccount.has(account)) {
    tokenByAccount.set(account, execFileSync(ghPath, ["auth", "token", "--user", account], { encoding: "utf8" }).trim());
  }
  return tokenByAccount.get(account);
}

function runGh(account, args) {
  const output = execFileSync(ghPath, args, {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: tokenFor(account) },
    timeout: GH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

/** Runs a read with the repo owner's account, then the other one if that account cannot see it. */
function ghAsOwner(repo, args) {
  const primary = accountForRepo(repo, ACCOUNTS);
  const fallback = primary === ACCOUNTS.workAccount ? ACCOUNTS.personalAccount : ACCOUNTS.workAccount;
  try {
    return runGh(primary, args);
  } catch (primaryError) {
    try {
      return runGh(fallback, args);
    } catch {
      throw primaryError;
    }
  }
}

function commitsQuery({ baseRef, path, since, until, author }) {
  const query = new URLSearchParams({ path, since, until, author, per_page: String(COMMITS_PER_PAGE) });
  if (baseRef) query.set("sha", baseRef);
  return query;
}

/**
 * Base-branch commits by the PR's author, touching any of its first files, inside the window. A
 * stacked PR's base branch is usually deleted once it lands, so a missing base falls back to the
 * repo's default branch.
 */
function followupCandidates(pullRequest, view) {
  const { since, until } = followupWindow(view.mergedAt);
  const candidates = [];
  let baseRef = view.baseRefName;
  for (const file of (view.files ?? []).slice(0, MAX_FOLLOWUP_FILES)) {
    const fetchCommits = () => {
      const query = commitsQuery({ baseRef, path: file.path, since, until, author: view.author.login });
      return ghAsOwner(pullRequest.repo, ["api", `repos/${pullRequest.repo}/commits?${query}`]);
    };
    let commits;
    try {
      commits = fetchCommits();
    } catch (error) {
      if (!baseRef || !String(error.stderr ?? "").includes(BRANCH_NOT_FOUND)) throw error;
      baseRef = null;
      commits = fetchCommits();
    }
    for (const commit of commits) candidates.push({ sha: commit.sha, message: commit.commit?.message ?? "" });
  }
  return candidates;
}

function refreshOne(store, pullRequest, nowMs) {
  const view = ghAsOwner(pullRequest.repo, ["pr", "view", pullRequest.url, "--json", PR_VIEW_FIELDS]);
  const isWindowClosed = view.state === "MERGED" && isFollowupWindowClosed(view.mergedAt, nowMs);
  const candidates = isWindowClosed && view.author?.login ? followupCandidates(pullRequest, view) : null;
  const plannedPrNumbers = new Set(
    store
      .prepare("SELECT number FROM prs WHERE repo = ? AND opened_at < ? AND number <> ?")
      .all(pullRequest.repo, view.mergedAt ?? "", pullRequest.number)
      .map((row) => row.number),
  );
  const outcome = deriveOutcome({ view, prNumber: pullRequest.number, followupCandidates: candidates, plannedPrNumbers, nowMs });
  store
    .prepare(
      `UPDATE prs SET author = ?, state = ?, merged_at = ?, closed_at = ?, base_ref = ?, file_count = ?,
         commits_after_open = ?, followup_commits = ?, followup_fix_commits = ?, followup_shas = ?,
         reverted = ?, outcome_final = ?, fetched_at = ?, fetch_error = NULL
       WHERE url = ?`,
    )
    .run(
      outcome.author,
      outcome.state,
      outcome.mergedAt,
      outcome.closedAt,
      outcome.baseRef,
      outcome.fileCount,
      outcome.commitsAfterOpen,
      outcome.followupCommits,
      outcome.followupFixCommits,
      outcome.followupShas,
      outcome.reverted,
      Number(outcome.isFinal),
      nowIso(),
      pullRequest.url,
    );
  return outcome.isFinal;
}

const store = openStore();
const pending = store.prepare("SELECT url, repo, number FROM prs WHERE outcome_final = 0 ORDER BY opened_at").all();
const recordError = store.prepare("UPDATE prs SET fetch_error = ?, fetched_at = ? WHERE url = ?");
const nowMs = Date.now();
let finalized = 0;
let failed = 0;
for (const pullRequest of pending) {
  try {
    if (refreshOne(store, pullRequest, nowMs)) finalized += 1;
  } catch (error) {
    failed += 1;
    const message = String(error.stderr || error.message || error).slice(0, MAX_ERROR_CHARS);
    recordError.run(message, nowIso(), pullRequest.url);
  }
}
process.stdout.write(`refreshed ${pending.length - failed} of ${pending.length} open PR outcomes, ${finalized} now final, ${failed} failed\n`);
if (failed > 0 && failed === pending.length) process.exitCode = 1;
