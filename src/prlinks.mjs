import { activeSegments, unionMs } from "./workflowchildren.mjs";

/**
 * Which pull requests a session opened, and how long the work behind each took.
 *
 * A PR is recognised only from a `gh pr create` Bash call whose own result names the PR's URL. A
 * call blocked by a hook, or one that failed, prints no URL and opens nothing, so it records
 * nothing. A PR opened some other way (the web UI, an MCP tool, `gh api`) is not seen.
 */

const PR_CREATE_PATTERN = /\bgh\s+pr\s+create\b/;
const PR_URL_PATTERN = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block === "string" ? block : (block?.text ?? ""))).join("\n");
}

/**
 * The text a tool call answered with. The URL `gh pr create` prints sits in `toolUseResult.stdout`
 * on most transcripts, but some carry no `toolUseResult` at all and hold it only in the
 * tool_result block, so both are read.
 */
function resultTextOf(entry, block) {
  const parts = [blockText(block.content)];
  const result = entry.toolUseResult;
  if (result && typeof result === "object") parts.push(result.stdout ?? "", result.stderr ?? "");
  if (typeof result === "string") parts.push(result);
  return parts.join("\n");
}

/** The PR a `gh pr create` result printed, or null when it printed none. */
export function pullRequestFromText(text) {
  const match = PR_URL_PATTERN.exec(text ?? "");
  if (!match) return null;
  return { url: match[0], repo: match[1], number: Number(match[2]) };
}

/**
 * PRs opened in one transcript: one per `gh pr create` call whose result printed a URL. Each
 * carries the call's id and time, and the session the entry names.
 */
export function pullRequestsIn(entries, { openedBy = "lead" } = {}) {
  const pending = new Map();
  const opened = [];
  for (const entry of entries) {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.name === "Bash" && PR_CREATE_PATTERN.test(block.input?.command ?? "")) {
        pending.set(block.id, entry);
      }
      if (block?.type !== "tool_result" || !pending.has(block.tool_use_id)) continue;
      const call = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      const pullRequest = pullRequestFromText(resultTextOf(entry, block));
      if (!pullRequest) continue;
      opened.push({
        ...pullRequest,
        toolUseId: block.tool_use_id,
        sessionId: call.sessionId ?? call.session_id ?? null,
        cwd: call.cwd ?? null,
        openedAt: call.timestamp,
        openedBy,
      });
    }
  }
  return opened;
}

/** When each file edit in a transcript was made, in ms. */
export function editTimes(entries) {
  const times = [];
  for (const entry of entries) {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (!blocks.some((block) => block?.type === "tool_use" && EDIT_TOOL_NAMES.has(block.name))) continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) times.push(at);
  }
  return times;
}

/**
 * Lead-transcript active time from the first file edit (by the lead or any of its agents) after
 * the session's previous PR, to this PR's open. A lead waiting on an agent counts as active, so
 * the figure reads the same whichever of them wrote the code. Null when no edit preceded the PR.
 */
export function activeMsToOpen({ leadPoints, editTimesMs, openedAtMs, previousOpenedAtMs = -Infinity }) {
  const startMs = Math.min(
    ...editTimesMs.filter((at) => at > previousOpenedAtMs && at <= openedAtMs),
  );
  if (!Number.isFinite(startMs)) return { workStartedAtMs: null, activeMs: null };
  const window = leadPoints.filter((point) => point.at >= startMs && point.at <= openedAtMs);
  const points = [{ at: startMs, toolInFlight: false }, ...window, { at: openedAtMs, toolInFlight: false }];
  return { workStartedAtMs: startMs, activeMs: unionMs(activeSegments(points)) };
}

/**
 * One row per PR when several transcripts record the same call. romp forks and replays copy a
 * session's entries under a new session id, so the copy whose session started first is the
 * original.
 */
export function pickOriginal(candidates, sessionStartMs) {
  const byUrl = new Map();
  const startOf = (candidate) => sessionStartMs.get(candidate.sessionId) ?? Date.parse(candidate.openedAt);
  for (const candidate of candidates) {
    const current = byUrl.get(candidate.url);
    const isEarlier =
      !current ||
      startOf(candidate) < startOf(current) ||
      (startOf(candidate) === startOf(current) && candidate.sessionId < current.sessionId);
    if (isEarlier) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()];
}

/**
 * A number or string field from the head of a workflow's result JSON. Results are stored cut at a
 * fixed length, so a long one is no longer parseable as a whole; implement-verify puts its counts
 * and mode first.
 */
export function resultField(resultText, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*("([^"]*)"|(-?\\d+(?:\\.\\d+)?))`).exec(resultText ?? "");
  if (!match) return null;
  return match[2] ?? Number(match[3]);
}

/** The `mode` a Workflow call's args name, whether args arrived as an object or a JSON string. */
export function workflowModeFromInput(input) {
  let args = input?.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  if (Array.isArray(args)) return "verify-only";
  return typeof args?.mode === "string" ? args.mode : null;
}
