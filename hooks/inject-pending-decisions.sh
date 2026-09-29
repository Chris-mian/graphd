#!/usr/bin/env bash
# SessionStart hook: say when graphd is holding work that only Chris can unblock, and when its
# own scheduled jobs have gone quiet.
#
# Why a hook: a harvest files proposals into ~/.graphd/proposals.json and nothing reads them
# back. `graph decisions` answers only when someone remembers to ask, so an accepted rule can
# sit undecided for days while the sessions it would have changed go past.
#
# Contract: reads the hook payload on stdin and ignores it. Emits nothing when there is nothing
# pending and the jobs are current. Never fails the session: every error path exits 0.
set -uo pipefail

readonly STATE_DIR="${GRAPHD_STATE_DIR:-$HOME/.graphd}"
readonly PROPOSALS_PATH="$STATE_DIR/proposals.json"
readonly IMPORT_LOG_PATH="$STATE_DIR/logs/graphd-import.log"
readonly HARVEST_LOG_PATH="$STATE_DIR/logs/harvest.log"
readonly SPINE_REFRESH_LOG_PATH="${SPINE_STATE_DIR:-$HOME/.local/state/spine}/refresh.log"
readonly NIGHTSHIFT_STAMP_PATH="${NIGHTSHIFT_DIR:-$HOME/nightshift}/.last-healthy-run"
# A weekly job is late once a second Monday has passed; an hourly one within half a day.
readonly HARVEST_STALE_SECONDS=1209600
readonly HOURLY_JOB_STALE_SECONDS=43200
# The night shift runs every third night; late once a fourth day has passed.
readonly NIGHTSHIFT_STALE_SECONDS=345600

command -v jq >/dev/null 2>&1 || exit 0
cat >/dev/null

notes=()

if [[ -f "$PROPOSALS_PATH" ]]; then
  pending_titles="$(jq -r '[.[] | select(.status == "pending")] | .[0:3] | .[] | "  - \(.id): \(.title)"' \
    "$PROPOSALS_PATH" 2>/dev/null)"
  pending_count="$(jq -r '[.[] | select(.status == "pending")] | length' "$PROPOSALS_PATH" 2>/dev/null)"
  if [[ -n "${pending_count:-}" && "$pending_count" -gt 0 ]]; then
    notes+=("$pending_count graphd proposal(s) await a decision — \`graph decisions\`, then \`graph decide <id> accepted|rejected\`.")
    notes+=("$pending_titles")
  fi
fi

# A job that stops running is silent, which reads exactly like a job with nothing to report.
check_job_is_current() {
  local log_path="$1" label="$2" stale_seconds="$3" age
  [[ -f "$log_path" ]] || {
    notes+=("$label has never written a log — check \`launchctl list | grep -iE 'graphd|spine|nightshift'\`.")
    return
  }
  age=$(( $(date +%s) - $(stat -f %m "$log_path") ))
  ((age > stale_seconds)) &&
    notes+=("$label last ran $((age / 86400))d ago — its schedule may have stopped.")
}

check_job_is_current "$IMPORT_LOG_PATH" "graphd import" "$HOURLY_JOB_STALE_SECONDS"
check_job_is_current "$HARVEST_LOG_PATH" "graphd harvest" "$HARVEST_STALE_SECONDS"
check_job_is_current "$SPINE_REFRESH_LOG_PATH" "spine refresh" "$HOURLY_JOB_STALE_SECONDS"
check_job_is_current "$NIGHTSHIFT_STAMP_PATH" "nightshift" "$NIGHTSHIFT_STALE_SECONDS"

((${#notes[@]} == 0)) && exit 0

printf -v block '%s\n' "STANDING ITEMS — not this session's work:" "${notes[@]}"

jq -n \
  --arg additional_context "$block" \
  '{
     hookSpecificOutput: {
       hookEventName: "SessionStart",
       additionalContext: $additional_context
     },
     suppressOutput: true
   }' 2>/dev/null || exit 0
