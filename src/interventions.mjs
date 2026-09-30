const INTERRUPT_MARKER = "[Request interrupted by user";
const ROMP_PROMPT_PATTERN = /<prompt\s+[0-9a-f]+>([\s\S]*?)<\/prompt\s+[0-9a-f]+>/i;
const WRAPPER_BLOCK_PATTERN = /<(open-goals|system-reminder|command-name|local-command)[\s\S]*?>/gi;
const QUOTE_LENGTH = 220;
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?])\s+/g;

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
const MINIMUM_REASON_LENGTH = 12;

/** romp recap blocks quote earlier turns verbatim; counting them double-counts one event. */
const SESSION_MANAGER_RECAP_PATTERN =
  /<[a-z-]*(goals?|unit|segment|turn|work)\s+[0-9a-f]{6,}>|romp-system/i;

/**
 * Turns that look like a human redirect but are not one. A task notification is the harness
 * reporting an agent finished; a quoted reply repeats a turn already counted where it was said.
 */
const NOT_A_HUMAN_TURN_PATTERN = /<task-notification>|^Replying to this part of the conversation:/i;

/**
 * Turns that carry text but state no reason: a slash command, and the boilerplate that resumes a
 * compacted session. Both follow an interrupt often enough to be read as its cause.
 */
const NOT_A_REASON_PATTERN =
  /<\/command-name>|<\/local-command-stdout>|<bash-input>|<bash-stdout>|<bash-stderr>|<teammate-message|romp-injected|^\/[a-z-]+\b|^Continue from where you left off|^This session is being continued|^Another Claude session sent a message/i;

export const INTERVENTION_KINDS = {
  INTERRUPT: "interrupt",
  CORRECTION: "correction",
  SELF_CORRECTION: "self_correction",
};

/** Phrases that only appear when a human is redirecting work already in progress. */
const CORRECTION_PATTERNS = [
  /(?<!\bif\s)\bno[,.!]\s/i,
  /\b(that'?s|this is) (wrong|not right|incorrect|not what)\b/i,
  /\byou (broke|missed|forgot|ignored|misread|didn'?t)\b/i,
  /\b(stop|wait|hold on)\b/i,
  /^(?:please\s+|now\s+)?(?:revert|undo|roll ?back)\b(?=\s+(?:the|it|this|that|these|those|my|your|all|everything|to)\b|[.!?]|$)/i,
  /[.!?]\s+(?:please\s+|now\s+)?(?:revert|undo|roll ?back)\b(?=\s+(?:the|it|this|that|these|those|my|your|all|everything|to)\b|[.!?]|$)/i,
  /\b(don'?t|do not) (do|use|add|change|touch)\b/i,
  /\bwhy did you\b/i,
  /\bi (said|asked for|told you)\b/i,
  /\b(instead of|rather than) (that|what you)\b/i,
  /\bnot what i (asked|meant|wanted)\b/i,
];

/**
 * A reply challenging the agent's output: a question at its choice, or disagreement opening a line.
 * Counts anywhere in a short turn only; in a long brief the same words are asking, not objecting.
 */
const CHALLENGE_PATTERNS = [
  /\bwhy (?:is|are|was|were) (?:it|this|that|they|these|those) (?:called|named)\b/i,
  /\bwhy did you\b/i,
  /\bwhat do you mean\b/i,
  /^(?:\d+[.)]\s*)?i (?:do ?n['’]?t|do not) (?:really |fully )?agree\b/im,
  /^(?:\d+[.)]\s*)?that['’]?s not\b/im,
];
const CHALLENGE_TURN_LENGTH = 400;

/** Phrases where the agent is retracting or repairing its own earlier claim. */
const SELF_CORRECTION_PATTERNS = [
  /\bi was wrong\b/i,
  /\b(my|that was a) (mistake|error)\b/i,
  /\bi misread\b/i,
  /\bi (incorrectly|wrongly) (said|claimed|assumed|reported)\b/i,
  /\bearlier i (said|claimed|reported)\b.*\b(but|actually|in fact)\b/i,
  /\bmy earlier\s+[^.!?]{1,60}?\s(?:was|were)\s+wrong\b/i,
  /\bthat (claim|number|statement) was (wrong|bogus|incorrect)\b/i,
  /\bscratch that\b/i,
];

/**
 * Self-correction phrases that only count near the start of a turn. Deep in a long report,
 * "correction" is the agent narrating someone else's, not making one. The trailing punctuation
 * excludes a word-internal hyphen so "correction-based" does not read as a marker.
 */
const OPENING_SELF_CORRECTION_PATTERNS = [
  /^(?:#{1,4}\s*)?(?:(?:critical|important|major|minor|small|quick|one)\s+)?(?:correction|correcting myself)\s*(?::|—)/i,
  /\bi (?:also )?owe you a correction\b/i,
];

/**
 * A retraction stated as a condition is about a turn that has not happened yet. "If it is still
 * red, I was wrong about the cause" is a plan, not a correction.
 */
const CONDITIONAL_CLAUSE_PATTERN = /^\s*(?:if|unless|should)\b/i;

/**
 * Spans the agent is quoting, not saying. Fences go first so their backticks are not paired as
 * inline code; a single quote only opens and closes at a word edge, so "don't" is not a quote.
 */
const QUOTED_SPAN_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /"[^"\n]+"/g,
  /“[^”\n]+”/g,
  /(?<![\w'])'(?:[^'\n]|(?<=\w)'(?=\w))+?'(?![\w'])/g,
];

/** Blanks the inside of every quoted span at the same length, so offsets match the original. */
function maskQuotedSpans(text) {
  return QUOTED_SPAN_PATTERNS.reduce(
    (masked, pattern) =>
      masked.replace(
        pattern,
        (span) => span[0] + "_".repeat(span.length - 2) + span[span.length - 1],
      ),
    text,
  );
}

/** Splits text into sentences, each as the original and with its quoted spans masked. */
function sentenceSpans(text) {
  const original = String(text);
  const masked = maskQuotedSpans(original);
  const spans = [];
  let start = 0;
  for (const boundary of masked.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    spans.push({
      original: original.slice(start, boundary.index),
      masked: masked.slice(start, boundary.index),
    });
    start = boundary.index + boundary[0].length;
  }
  spans.push({ original: original.slice(start), masked: masked.slice(start) });
  return spans;
}

/** Flattens a turn's content, which the transcript writes either as a string or a block array. */
export function contentText(rawContent) {
  if (typeof rawContent === "string") return rawContent;
  if (!Array.isArray(rawContent)) return "";
  return rawContent
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Strips romp prompt wrappers and injected blocks, leaving what the human actually typed. */
export function humanText(rawContent) {
  const raw = contentText(rawContent);
  if (!raw) return "";
  const wrapped = ROMP_PROMPT_PATTERN.exec(raw);
  const inner = wrapped ? wrapped[1] : raw;
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
  const raw = contentText(rawContent);
  if (SESSION_MANAGER_RECAP_PATTERN.test(raw)) return null;
  if (NOT_A_HUMAN_TURN_PATTERN.test(raw)) return null;
  if (raw.includes(INTERRUPT_MARKER)) return INTERVENTION_KINDS.INTERRUPT;
  const text = humanText(rawContent);
  if (!text) return null;
  if (MACHINE_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  if (text.startsWith(">")) return null;
  const isCorrection =
    matchesAny(CORRECTION_PATTERNS, text.slice(0, OPENING_WINDOW)) ||
    (text.length <= CHALLENGE_TURN_LENGTH && matchesAny(CHALLENGE_PATTERNS, text));
  return isCorrection ? INTERVENTION_KINDS.CORRECTION : null;
}

/**
 * The reason text in a human turn, or null when the turn carries none.
 * A bare interrupt records no reason, but the turn that follows it usually says what was
 * wrong, so that turn is the reason for the stop before it.
 */
export function followupReason(rawContent) {
  const raw = contentText(rawContent);
  if (raw.includes(INTERRUPT_MARKER)) return null;
  if (SESSION_MANAGER_RECAP_PATTERN.test(raw)) return null;
  if (NOT_A_HUMAN_TURN_PATTERN.test(raw)) return null;
  const text = humanText(rawContent);
  if (!text || text.length < MINIMUM_REASON_LENGTH) return null;
  if (MACHINE_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  if (text.startsWith(">")) return null;
  if (NOT_A_REASON_PATTERN.test(raw) || NOT_A_REASON_PATTERN.test(text)) return null;
  return toQuote(text);
}

/** Classifies assistant text as a self-correction, or null. */
export function classifyAssistantText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const isSelfCorrection =
    checkHasUnconditionalMarker(text) ||
    matchesAny(OPENING_SELF_CORRECTION_PATTERNS, maskQuotedSpans(text).slice(0, OPENING_WINDOW));
  return isSelfCorrection ? INTERVENTION_KINDS.SELF_CORRECTION : null;
}

/** Whether a retraction marker appears unquoted in a sentence stating it, not supposing it. */
function checkHasUnconditionalMarker(text) {
  return sentenceSpans(text).some(
    ({ masked }) =>
      matchesAny(SELF_CORRECTION_PATTERNS, masked) && !CONDITIONAL_CLAUSE_PATTERN.test(masked),
  );
}

/** Returns the sentence that triggered the match, so a report quotes the retraction itself. */
export function matchedSentence(text) {
  const allPatterns = [...SELF_CORRECTION_PATTERNS, ...OPENING_SELF_CORRECTION_PATTERNS];
  const hit = sentenceSpans(text).find(({ masked }) => matchesAny(allPatterns, masked));
  return toQuote(hit?.original ?? text);
}

/** Trims a quote to a single readable line for reports. */
export function toQuote(text) {
  return humanText(text).replace(/\s+/g, " ").slice(0, QUOTE_LENGTH);
}

const DETAIL_LENGTH = 300;

/**
 * What the interrupted tool call was actually doing.
 * Three quarters of human interventions are a bare `[Request interrupted by user]` with no text,
 * so the tool name alone ("Bash") is the whole record. The input is the only thing left that says
 * what was stopped.
 */
export function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return null;
  const value =
    input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.description ?? null;
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/\s+/g, " ").trim().slice(0, DETAIL_LENGTH);
}

/** Tools whose first word is a bare interpreter; the subcommand is what identifies the work. */
const SUBCOMMAND_PROGRAMS = new Set([
  "git", "gh", "just", "npm", "pnpm", "uv", "node", "cargo", "aws", "kubectl", "docker", "sqlite3",
]);
const SHELL_NOISE_PATTERN = /^(cd\s+\S+\s*(&&|;)\s*|[A-Z_]+=[^\s$]+\s+|sudo\s+|time\s+)+/;

/** Wrappers that run another command; the wrapper name says nothing about what was stopped. */
const PASSTHROUGH_PATTERN = /^(rtk\s+(proxy\s+)?|env\s+|xargs\s+)+/;

/**
 * A stable name for the kind of command a detail string holds, so stops can be grouped.
 * `git log --oneline -5` and `git log -20` are one behavior, not two.
 */
export function commandShape(detail) {
  if (typeof detail !== "string" || detail.length === 0) return null;
  const stripped = detail.replace(SHELL_NOISE_PATTERN, "").replace(PASSTHROUGH_PATTERN, "");
  const [program, second] = stripped.split(/\s+/);
  if (!program) return null;
  const base = program.split("/").pop();
  if (base.includes("$") || base.includes("(")) return "(shell expression)";
  if (!SUBCOMMAND_PROGRAMS.has(base) || !second || second.startsWith("-")) return base;
  return `${base} ${second}`;
}
