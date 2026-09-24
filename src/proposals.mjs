import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, ensureStateDir } from "./config.mjs";
import { acceptRule } from "./accepted.mjs";

export const PROPOSALS_PATH = join(STATE_DIR, "proposals.json");
export const SETTINGS_PATH =
  process.env.GRAPHD_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
/** Resolved per call so a caller can point the queue somewhere else. */
export function nightShiftTasksPath() {
  return process.env.GRAPHD_NIGHTSHIFT_TASKS_PATH ?? join(homedir(), "nightshift", "TASKS.md");
}

const NIGHTSHIFT_STATUS = "todo";
const NIGHTSHIFT_WORKTREE = "graphd-proposals";

const STATUS_PENDING = "pending";
const STATUS_ACCEPTED = "accepted";
const STATUS_REJECTED = "rejected";
const DECIDABLE_STATUSES = new Set([STATUS_ACCEPTED, STATUS_REJECTED]);
const SECRET_FILE_MODE = 0o600;

/**
 * Seeded on first read so a decision never lives only in a report file.
 * A harvest appends here; nothing is ever silently applied.
 */
const DEFAULT_PROPOSALS = [
  {
    id: "rule-partial-read",
    kind: "rule",
    title: "A truncated file read is not evidence of absence",
    why:
      "Theme 1 of the 2026-09-08 harvest, 5 interventions. The most expensive recurring pattern: " +
      "a claim built on a read that stopped at the range boundary. Survives being noticed, which " +
      "is why it needs to be written down rather than remembered.",
    evidence: "conftest.py:111 was read as absent because the read cut off at line 110.",
    applies: {
      type: "rule",
      rule:
        "A file read that stops at the range boundary is not evidence of absence. " +
        "Re-read past the boundary before claiming a symbol or setting is missing.",
    },
  },
  {
    id: "rule-flake-attribution",
    kind: "rule",
    title: "Never call a test failure flaky without re-running it",
    why:
      "Theme 3, 2 self-corrections. impl-pressure-tester already carries a verify-before-attributing " +
      "rule, but both failures came from the lead agent, which has no such rule.",
    evidence: '"It was my bug, and I was wrong to call it likely-flaky."',
    applies: {
      type: "rule",
      rule:
        "Never attribute a test failure to flakiness or infrastructure without re-running it in " +
        "isolation and checking whether it fails on the base commit.",
    },
  },
  {
    id: "rule-reversible-autonomy",
    kind: "rule",
    title: "Proceed on reversible work instead of asking",
    why:
      "Theme 4, 1 correction, but it names the stated goal directly: less human involvement. " +
      "The failure mode shows up in the autonomy metric, so the effect is measurable.",
    evidence: '"keep going, dont wait for me."',
    applies: {
      type: "rule",
      rule:
        "For reversible work that follows from the request, proceed and report. Ask only when " +
        "proceeding under any assumption would be unsafe or would waste the work if wrong.",
    },
  },
  {
    id: "hook-inspect-before-destructive",
    kind: "hook",
    title: "Inject an inspect-first reminder before irreversible Bash commands",
    why:
      "Theme 2, 3 self-corrections, all the same shape: an irreversible command run before looking " +
      "at what it would hit. The only theme that is mechanically checkable, and the only proposal " +
      "that fires at the moment of risk instead of relying on an agent remembering a rule.",
    evidence:
      '"I killed whatever held the port instead of checking what it was first." / ' +
      '"git add -A swept the throwaway probe file into the first commit."',
    applies: {
      type: "hook",
      event: "PreToolUse",
      matcher: "Bash",
      command: 'bash "$HOME/.claude/hooks/inspect-before-destructive.sh"',
      timeout: 10,
      note: "Injects context only. Never blocks the command.",
    },
  },
  {
    id: "schedule-auto-harvest",
    kind: "question",
    title: "Run /lesson-harvest automatically each week",
    why:
      "The data refresh is already scheduled and costs nothing. The harvest that interprets it " +
      "spends model tokens, and it would run unattended, so it is your call rather than a default.",
    evidence:
      "Accepting means a weekly `claude -p` run writing a report to ~/.claude/telemetry/reports/. " +
      "It would still only propose; nothing would auto-apply.",
    applies: { type: "manual", note: "Needs a launchd job installed after you accept." },
  },
];

function seedProposals() {
  const seeded = DEFAULT_PROPOSALS.map((proposal) => ({
    ...proposal,
    status: STATUS_PENDING,
    source: "lesson-harvest-2026-09-08",
    decidedAt: null,
  }));
  writeProposals(seeded);
  return seeded;
}

export function readProposals() {
  ensureStateDir();
  if (!existsSync(PROPOSALS_PATH)) return seedProposals();
  try {
    const parsed = JSON.parse(readFileSync(PROPOSALS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : seedProposals();
  } catch {
    return seedProposals();
  }
}

function writeProposals(proposals) {
  ensureStateDir();
  writeFileSync(PROPOSALS_PATH, `${JSON.stringify(proposals, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
  });
}

/** Appends new proposals from a harvest, leaving any id already decided untouched. */
export function addProposals(incoming) {
  const existing = readProposals();
  const knownIds = new Set(existing.map((proposal) => proposal.id));
  const fresh = incoming
    .filter((proposal) => !knownIds.has(proposal.id))
    .map((proposal) => ({ ...proposal, status: STATUS_PENDING, decidedAt: null }));
  if (fresh.length > 0) writeProposals([...existing, ...fresh]);
  return { addedCount: fresh.length, totalCount: existing.length + fresh.length };
}

function hookIsRegistered(settings, { event, command }) {
  return (settings.hooks?.[event] ?? []).some((group) =>
    (group.hooks ?? []).some((hook) => hook.command === command),
  );
}

/**
 * Registers the hook in settings.json, backing the file up first.
 * Idempotent on the command, not on the matcher: the same script registered by hand under a
 * different matcher already runs, and adding it again injects its output twice.
 */
function applyHook(applies) {
  const { event, matcher, command, timeout } = applies;
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  if (hookIsRegistered(settings, applies)) return { installed: false, reason: "already registered" };

  copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak-proposals`);
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  const group = settings.hooks[event].find((candidate) => candidate.matcher === matcher);
  const entry = { type: "command", command, timeout };
  if (group) group.hooks = [...(group.hooks ?? []), entry];
  else settings.hooks[event].push({ matcher, hooks: [entry] });

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  return { installed: true, backup: `${SETTINGS_PATH}.bak-proposals` };
}

function applyProposal(proposal) {
  if (proposal.applies?.type === "rule") return acceptRule(proposal.applies.rule);
  if (proposal.applies?.type === "hook") return applyHook(proposal.applies);
  return queueForNightShift(proposal);
}

/**
 * Files an accepted proposal that needs code as a night-shift task.
 * A manual proposal has no mechanism behind it, so before this an accept was only a note in
 * a JSON file and the work stalled with nobody holding it.
 */
export function queueForNightShift(proposal) {
  const note = proposal.applies?.note ?? null;
  const tasksPath = nightShiftTasksPath();
  if (!existsSync(tasksPath)) {
    return { needsFollowUp: true, note, queued: false, reason: "no night-shift task list" };
  }
  const detail = [`  - From graphd proposal \`${proposal.id}\`.`];
  if (note) detail.push(`  - ${note.replace(/\s+/g, " ")}`);
  const entry =
    `\n- [${NIGHTSHIFT_STATUS}] [${NIGHTSHIFT_WORKTREE}] ${proposal.title}\n` +
    `${detail.join("\n")}\n`;
  appendFileSync(tasksPath, entry);
  return { needsFollowUp: true, note, queued: true, path: tasksPath };
}

/**
 * Records a decision and, for anything mechanically applicable, applies it now.
 * Rejection never touches anything; the proposal just stops being pending.
 */
export function decideProposal(id, status) {
  if (!DECIDABLE_STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  const proposals = readProposals();
  const proposal = proposals.find((candidate) => candidate.id === id);
  if (!proposal) throw new Error(`no proposal named ${id}`);

  const applied = status === STATUS_ACCEPTED ? applyProposal(proposal) : null;
  proposal.status = status;
  proposal.decidedAt = new Date().toISOString();
  writeProposals(proposals);
  return { id, status, applied };
}

export function pendingProposals() {
  return readProposals().filter((proposal) => proposal.status === STATUS_PENDING);
}
