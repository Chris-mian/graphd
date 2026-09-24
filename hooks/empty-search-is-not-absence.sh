#!/usr/bin/env bash
# PostToolUse hook: when a Bash search or process/container filter prints nothing, inject a
# reminder that an empty result from one probe is not evidence of absence.
#
# Why a hook and not only a rule: rule-absence-needs-second-probe and
# rule-liveness-before-declaring-dead are accepted, and the same failure still produced five
# self-corrections in eight days. Each came from one narrow filter that matched nothing:
# a grep pattern needing a space where the name had a hyphen, a docker filter that missed the
# container name, a process check that missed seven live pytest workers, and `rg` skipping
# the hidden ~/.claude directory. The moment of risk is the empty result itself, so the check
# fires there.
#
# Contract: reads the hook payload JSON on stdin, emits either nothing (exit 0) or a JSON
# object carrying hookSpecificOutput.additionalContext. Never blocks and never fails the call.
set -uo pipefail

# A command counts as a probe when it filters or searches for something by name.
readonly PROBE_PATTERN='(^|[;&|[:space:](])(grep|egrep|rg|ag|pgrep|fd|find)([[:space:]]|$)|ls-files|docker[[:space:]]+ps|--filter'

hook_payload_json="$(cat)"

bash_command="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[[ -z "$bash_command" ]] && exit 0
printf '%s' "$bash_command" | grep -qE -- "$PROBE_PATTERN" || exit 0

# Only an empty result (or a bare zero count) is the risky case. A multi-probe command with
# echo separators prints labels, so it is not caught here; that is a known gap, not a bug.
probe_stdout="$(printf '%s' "$hook_payload_json" | jq -r '.tool_response.stdout // empty' 2>/dev/null)"
trimmed_stdout="$(printf '%s' "$probe_stdout" | tr -d '[:space:]')"
[[ -n "$trimmed_stdout" && "$trimmed_stdout" != "0" ]] && exit 0

read -r -d '' SECOND_PROBE <<'SECOND_PROBE_EOF'
That probe matched nothing. One empty result is not evidence of absence.

Before writing that something is missing, stopped, unwired, or untracked, re-probe with a
different mechanism:
- `rg` skips hidden and .gitignored paths: add `--hidden --no-ignore`, or use `grep -r`.
- A pattern with a literal space or exact name misses hyphenated and suffixed variants.
  Loosen it, or list the directory and read the names.
- `pgrep` / `ps | grep` / `docker ps --filter`: list everything unfiltered and read it,
  or check a second signal (recent log output, a monitor event, a port).

If you already re-probed this turn, name the second probe in one line and proceed.
SECOND_PROBE_EOF

jq -n \
  --arg additional_context "$SECOND_PROBE" \
  '{
     hookSpecificOutput: {
       hookEventName: "PostToolUse",
       additionalContext: $additional_context
     },
     suppressOutput: true
   }' 2>/dev/null || exit 0
