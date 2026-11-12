/**
 * Whether the lead batches independent tool calls. Claude Code writes each content block of one
 * assistant message as its own transcript line, all sharing `message.id`, so a message that issued
 * three calls at once appears as three lines. Grouping by `message.id` recovers the message.
 */

/** Built-in tools that only read. Bash is left out: a command line can read or write. */
export const READ_TOOL_NAMES = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);

/**
 * An MCP tool whose own name (after `mcp__<server>__`) says it reads: the verb as a whole word
 * between `_`/`-` or the ends, so `create_thread` (read) and `show_widget` (get) do not match.
 */
export const MCP_READ_PATTERN = /(^|[_-])(get|list|search|query|fetch|read)([_-]|$)/i;

const MCP_PREFIX = "mcp__";
const MCP_SEPARATOR = "__";
/** Calls issued together in one message: the batching being measured. */
const MIN_BATCH_SIZE = 2;
/** A run of this many consecutive single-read messages could have been one batched message. */
const MIN_SERIAL_RUN = 3;

/** Whether a tool call only reads. An MCP tool is matched on its own name, not its server's. */
export function isReadTool(toolName) {
  if (typeof toolName !== "string") return false;
  if (READ_TOOL_NAMES.has(toolName)) return true;
  if (!toolName.startsWith(MCP_PREFIX)) return false;
  const ownName = toolName.slice(MCP_PREFIX.length).split(MCP_SEPARATOR).slice(1).join(MCP_SEPARATOR);
  return MCP_READ_PATTERN.test(ownName);
}

/** Batched calls as a share of all calls, or null when there were no calls. */
export function batchedShare({ toolCalls, batchedCalls }) {
  return toolCalls > 0 ? batchedCalls / toolCalls : null;
}

/** The lead's assistant messages in order of first appearance, each as its tool_use names. */
function leadMessages(entries) {
  const messages = [];
  const byMessageId = new Map();
  for (const entry of entries) {
    if (entry?.type !== "assistant" || entry.isSidechain) continue;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const toolNames = blocks.filter((block) => block?.type === "tool_use").map((block) => block.name);
    const messageId = entry.message?.id;
    // A line with no message id cannot be joined to its siblings, so it stands alone.
    const existing = messageId ? byMessageId.get(messageId) : undefined;
    if (existing) {
      existing.push(...toolNames);
      continue;
    }
    messages.push(toolNames);
    if (messageId) byMessageId.set(messageId, toolNames);
  }
  return messages;
}

/**
 * The lead's tool calls, the calls issued two or more to a message, and the calls in runs of
 * three or more consecutive messages that each issued a single read. A message with no call, more
 * than one, or one that is not a read ends a run. Sidechain (subagent) entries are not the lead's.
 *
 * @param {Array<object>} entries parsed transcript lines
 * @returns {{ toolCalls: number, batchedCalls: number, serialReadCalls: number }}
 */
export function leadBatching(entries) {
  let toolCalls = 0;
  let batchedCalls = 0;
  let serialReadCalls = 0;
  let runLength = 0;
  const closeRun = () => {
    if (runLength >= MIN_SERIAL_RUN) serialReadCalls += runLength;
    runLength = 0;
  };
  for (const toolNames of leadMessages(entries)) {
    toolCalls += toolNames.length;
    if (toolNames.length >= MIN_BATCH_SIZE) batchedCalls += toolNames.length;
    if (toolNames.length === 1 && isReadTool(toolNames[0])) {
      runLength += 1;
    } else {
      closeRun();
    }
  }
  closeRun();
  return { toolCalls, batchedCalls, serialReadCalls };
}
