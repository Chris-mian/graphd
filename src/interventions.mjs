const INTERRUPT_MARKER = "[Request interrupted by user";
const ROMP_PROMPT_PATTERN = /<prompt\s+[0-9a-f]+>([\s\S]*?)<\/prompt\s+[0-9a-f]+>/i;
const WRAPPER_BLOCK_PATTERN = /<(open-goals|system-reminder|command-name|local-command)[\s\S]*?>/gi;
const QUOTE_LENGTH = 220;
const SENTENCE_SPLIT_PATTERN = /(?<=[.!?])\s+/;

/** Content the harness injects into the user turn. Not a human stepping in. */
const MACHINE_PREFIXES = [
  "Stop hook feedback",
  "[Request interrupted by user for tool use]",
  "<local-command",
  "<command-name",
  "Caveat:",
  "This session is being continued",
];
const OPENING_WINDOW = 90;

/** romp recap blocks quote earlier turns verbatim; counting them double-counts one event. */
const SESSION_MANAGER_RECAP_PATTERN = /<(goal|unit|segment|turn|work)\s+[0-9a-f]{6,}>|romp-system/i;

export const INTERVENTION_KINDS = {
  INTERRUPT: "interrupt",
  CORRECTION: "correction",
  SELF_CORRECTION: "self_correction",
};

/** Phrases that only appear when a human is redirecting work already in progress. */
const CORRECTION_PATTERNS = [
  /\bno[,.!]\s/i,
  /\b(that'?s|this is) (wrong|not right|incorrect|not what)\b/i,
  /\byou (broke|missed|forgot|ignored|misread|didn'?t)\b/i,
  /\b(stop|wait|hold on|revert|undo|roll ?back)\b/i,
  /\b(don'?t|do not) (do|use|add|change|touch)\b/i,
  /\bwhy did you\b/i,
  /\bi (said|asked for|told you)\b/i,
  /\b(instead of|rather than) (that|what you)\b/i,
  /\bnot what i (asked|meant|wanted)\b/i,
];

/** Phrases where the agent is retracting or repairing its own earlier claim. */
const SELF_CORRECTION_PATTERNS = [
  /\bi was wrong\b/i,
  /\b(my|that was a) (mistake|error)\b/i,
  /\bi misread\b/i,
  /\bcorrection[:—-]/i,
  /\bi (incorrectly|wrongly) (said|claimed|assumed|reported)\b/i,
  /\bearlier i (said|claimed|reported)\b.*\b(but|actually|in fact)\b/i,
  /\bthat (claim|number|statement) was (wrong|bogus|incorrect)\b/i,
  /\bscratch that\b/i,
];

/** Strips romp prompt wrappers and injected blocks, leaving what the human actually typed. */
export function humanText(rawContent) {
  if (typeof rawContent !== "string") return "";
  const wrapped = ROMP_PROMPT_PATTERN.exec(rawContent);
  const inner = wrapped ? wrapped[1] : rawContent;
  return inner.replace(WRAPPER_BLOCK_PATTERN, "").trim();
}

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classifies one human turn.
 * A correction has to read as a correction near the start; the same phrase deep in a long spec is
 * ordinary prose, not a redirect.
 */
export function classifyHumanTurn(rawContent) {
  if (typeof rawContent === "string" && SESSION_MANAGER_RECAP_PATTERN.test(rawContent)) return null;
  if (typeof rawContent === "string" && rawContent.includes(INTERRUPT_MARKER)) {
    return INTERVENTION_KINDS.INTERRUPT;
  }
  const text = humanText(rawContent);
  if (!text) return null;
  if (MACHINE_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  return matchesAny(CORRECTION_PATTERNS, text.slice(0, OPENING_WINDOW))
    ? INTERVENTION_KINDS.CORRECTION
    : null;
}

/** Classifies assistant text as a self-correction, or null. */
export function classifyAssistantText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  return matchesAny(SELF_CORRECTION_PATTERNS, text)
    ? INTERVENTION_KINDS.SELF_CORRECTION
    : null;
}

/** Returns the sentence that triggered the match, so a report quotes the retraction itself. */
export function matchedSentence(text) {
  const sentences = String(text).split(SENTENCE_SPLIT_PATTERN);
  const hit = sentences.find((sentence) => matchesAny(SELF_CORRECTION_PATTERNS, sentence));
  return toQuote(hit ?? text);
}

/** Trims a quote to a single readable line for reports. */
export function toQuote(text) {
  return humanText(text).replace(/\s+/g, " ").slice(0, QUOTE_LENGTH);
}
