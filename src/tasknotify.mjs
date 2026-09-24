const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/g;
const RESULT_PATTERN = /<result>([\s\S]*?)(?:<\/result>|$)/;
const STATUS_PATTERN = /<status>([^<]+)<\/status>/;
const TOOL_USE_ID_PATTERN = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const NOTIFICATION_MARKER = "<task-notification>";
const MAX_RESULT_CHARS = 4000;

const USAGE_PATTERN = /<usage>([\s\S]*?)<\/usage>/;
const USAGE_FIELD_PATTERNS = {
  totalTokens: /<subagent_tokens>(\d+)<\/subagent_tokens>/,
  toolUseCount: /<tool_uses>(\d+)<\/tool_uses>/,
  durationMs: /<duration_ms>(\d+)<\/duration_ms>/,
};

// A notification reaches the transcript as whichever of these the lead thread was doing at the
// time. queue-operation and attachment together outnumber plain user entries roughly 2:1, so
// reading only `user` drops most real finish times.
const NOTIFICATION_ENTRY_TYPES = new Set(["user", "queue-operation", "attachment", "assistant"]);

function entryText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => block.text ?? "").join("\n");
  if (typeof entry.content === "string") return entry.content;
  if (typeof entry.attachment?.prompt === "string") return entry.attachment.prompt;
  return "";
}

/**
 * Task notifications in a transcript, each carrying the real completion time of one or more
 * background agents. A background agent's tool call returns immediately, so this is the only
 * place its actual finish time appears.
 * The result text is attached only when the notification covers a single agent; a batched
 * notification does not say which result belongs to which task.
 */
/**
 * The token, tool-use and duration totals a notification reports, or null when it carries none.
 * A background agent's tool call returns before the work starts, so this is the only accounting
 * it ever produces; a plain background command reports no usage at all.
 */
export function parseUsage(text) {
  const block = USAGE_PATTERN.exec(text)?.[1];
  if (!block) return null;
  const usage = {};
  for (const [field, pattern] of Object.entries(USAGE_FIELD_PATTERNS)) {
    const matched = pattern.exec(block);
    usage[field] = matched ? Number(matched[1]) : null;
  }
  return Object.values(usage).some((value) => value !== null) ? usage : null;
}

export function parseTaskNotifications(entries) {
  const notifications = [];
  for (const entry of entries) {
    if (!NOTIFICATION_ENTRY_TYPES.has(entry.type) || !entry.timestamp) continue;
    const text = entryText(entry);
    if (!text.includes(NOTIFICATION_MARKER)) continue;

    const taskIds = [...text.matchAll(TASK_ID_PATTERN)].map((match) => match[1]);
    if (taskIds.length === 0) continue;
    const isBatched = taskIds.length > 1;
    const resultText = isBatched ? null : (RESULT_PATTERN.exec(text)?.[1] ?? null);
    notifications.push({
      taskIds,
      notifiedAt: entry.timestamp,
      status: STATUS_PATTERN.exec(text)?.[1] ?? null,
      resultText: resultText ? resultText.trim().slice(0, MAX_RESULT_CHARS) : null,
      usage: isBatched ? null : parseUsage(text),
      toolUseId: isBatched ? null : (TOOL_USE_ID_PATTERN.exec(text)?.[1] ?? null),
      isBatched,
    });
  }
  return notifications;
}
