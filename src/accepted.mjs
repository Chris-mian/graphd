import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.mjs";

export const LESSONS_DIR = join(STATE_DIR, "lessons");
export const ACCEPTED_PATH = join(LESSONS_DIR, "accepted.md");

const RULE_LINE_PATTERN = /^-\s+(.+)$/;
const MAX_INJECTED_RULES = 25;

const ACCEPTED_HEADER = `# Accepted lessons

Rules Chris accepted from \`/lesson-harvest\`. Every implementer and verifier reads these before
starting, so a correction given once does not have to be given again.

One rule per line, starting with "- ". Delete a line to retire it.
`;

function ensureLessonsDir() {
  if (!existsSync(LESSONS_DIR)) mkdirSync(LESSONS_DIR, { recursive: true });
}

/** Rules a human has accepted. Empty until the first harvest is approved. */
export function readAcceptedRules() {
  if (!existsSync(ACCEPTED_PATH)) return [];
  return readFileSync(ACCEPTED_PATH, "utf8")
    .split("\n")
    .map((line) => RULE_LINE_PATTERN.exec(line.trim())?.[1])
    .filter(Boolean)
    .slice(0, MAX_INJECTED_RULES);
}

/** Appends a rule, ignoring one already present verbatim. */
export function acceptRule(rule) {
  ensureLessonsDir();
  const existing = readAcceptedRules();
  if (existing.includes(rule)) return { rule, added: false, ruleCount: existing.length };
  if (!existsSync(ACCEPTED_PATH)) writeFileSync(ACCEPTED_PATH, ACCEPTED_HEADER);
  writeFileSync(ACCEPTED_PATH, `${readFileSync(ACCEPTED_PATH, "utf8").trimEnd()}\n- ${rule}\n`);
  return { rule, added: true, ruleCount: existing.length + 1 };
}

/** The block injected into every agent prompt in a workflow run. */
export function acceptedRulesBlock() {
  const rules = readAcceptedRules();
  if (rules.length === 0) return "";
  return (
    `\n\nLESSONS — accepted corrections from earlier sessions. These were paid for once already; ` +
    `do not make Chris give them again.\n${rules.map((rule) => `- ${rule}`).join("\n")}`
  );
}
