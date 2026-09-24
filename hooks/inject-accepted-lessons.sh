#!/usr/bin/env bash
# SessionStart hook: inject the rules Chris accepted from /lesson-harvest into the lead
# session, not only into implement-verify subagents.
#
# Why a hook: accepted rules live in ~/.graphd/lessons/accepted.md, and the only reader is
# the LESSONS_PREAMBLE in ~/.claude/workflows/implement-verify.js. The lead session, where
# every self-correction in the 2026-09-24 harvest happened, never sees them. Three repeats of
# accepted rules landed on 2026-09-24 in a session that could not have known the rules existed.
#
# SessionStart fires on startup, resume, clear and compact, so a long-running session picks
# up newly accepted rules at its next compaction.
#
# Contract: reads the hook payload on stdin and ignores it. Emits nothing when there are no
# accepted rules, otherwise a JSON object carrying hookSpecificOutput.additionalContext.
# Never fails the session: every error path exits 0.
set -uo pipefail

readonly ACCEPTED_RULES_PATH="${GRAPHD_STATE_DIR:-$HOME/.graphd}/lessons/accepted.md"
readonly MAX_INJECTED_RULES=25

cat >/dev/null
[[ -f "$ACCEPTED_RULES_PATH" ]] || exit 0

# Same parse as src/accepted.mjs readAcceptedRules: one rule per "- " line, capped at 25.
accepted_rules="$(grep -E '^[[:space:]]*-[[:space:]]+' "$ACCEPTED_RULES_PATH" | head -n "$MAX_INJECTED_RULES")"
[[ -z "$accepted_rules" ]] && exit 0

lessons_block="LESSONS — accepted corrections from earlier sessions. These were paid for once already; "
lessons_block+="do not make Chris give them again."
lessons_block+=$'\n'"$accepted_rules"

jq -n \
  --arg additional_context "$lessons_block" \
  '{
     hookSpecificOutput: {
       hookEventName: "SessionStart",
       additionalContext: $additional_context
     },
     suppressOutput: true
   }' 2>/dev/null || exit 0
