#!/usr/bin/env bash
# Weekly unattended lesson harvest.
#
# Refreshes the store first so the harvest reads the current week, then runs /lesson-harvest
# headless. The skill writes a report and appends proposals; accepting any of them stays a
# human action in the Decisions panel.
set -uo pipefail

readonly REPO_DIR="/Users/chrisliu/romp/graph-mechanism"
readonly IMPORT_WINDOW_DAYS=8
readonly HARVEST_TIMEOUT_SECONDS=1800

# Pinned rather than inherited: the default model moves ahead of whatever CLI version is
# installed, and an unsupported default fails the whole run with a 400.
readonly HARVEST_MODEL="claude-opus-5"
readonly LOG_DIR="${HOME}/.graphd/logs"
readonly LOG_FILE="${LOG_DIR}/harvest.log"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE"
}

# A failed run otherwise looks like a quiet week, so it files a decision card. The id carries the
# date, so a re-run that fails again the same day is a no-op.
file_failure_decision() {
  local run_date failure_file
  run_date="$(date -u '+%Y-%m-%d')"
  failure_file="${LOG_DIR}/harvest-failed-${run_date}.json"
  tail -n 5 "$LOG_FILE" | jq -Rs --arg id "harvest-failed-${run_date}" '
    (split("\n") | map(select(length > 0))) as $lines
    | ($lines | map(select(test("error|failed|expired|timed out"; "i"))) | first // $lines[-1] // "unknown error") as $first
    | {proposals: [{
        id: $id,
        kind: "question",
        title: ("Scheduled harvest failed: " + ($first | .[0:120])),
        why: "The weekly /lesson-harvest run exited non-zero, so this week has no report or proposals.",
        evidence: ($lines | join("\n")),
        applies: {type: "manual", note: "Re-run /lesson-harvest, or fix the cause in the evidence first."}
      }]}' >"$failure_file" || return 0
  "$REPO_DIR/bin/graph.mjs" propose "$failure_file" >>"$LOG_FILE" 2>&1 || log "could not file the failure decision"
}

log "harvest starting"

"$REPO_DIR/bin/graph-import.mjs" "$IMPORT_WINDOW_DAYS" >>"$LOG_FILE" 2>&1 || {
  log "import failed, skipping harvest"
  exit 0
}

# The native build in ~/.local/bin wins over a package-managed one, which lags the model
# defaults. Resolved rather than hardcoded so replacing one install does not break the job.
readonly CLAUDE_CANDIDATES=(
  "${HOME}/.local/bin/claude"
  "/opt/homebrew/bin/claude"
)
claude_bin=""
for candidate in "${CLAUDE_CANDIDATES[@]}"; do
  if [[ -x "$candidate" ]]; then
    claude_bin="$candidate"
    break
  fi
done
[[ -n "$claude_bin" ]] || claude_bin="$(command -v claude 2>/dev/null || true)"

# A harvest that cannot reach the model should leave last week's report in place rather than
# half-write a new one.
if [[ -z "$claude_bin" ]]; then
  log "no claude binary found, skipping harvest"
  exit 0
fi
log "using ${claude_bin} ($("$claude_bin" --version 2>/dev/null || echo 'version unknown'))"

cd "$REPO_DIR" || exit 0
"$claude_bin" -p \
  --permission-mode acceptEdits \
  --model "$HARVEST_MODEL" \
  --max-turns 60 \
  "Run the /lesson-harvest skill over the last 8 days. Write the report to \
~/.claude/telemetry/reports/ and append any proposed rules as pending proposals. \
Apply nothing: every proposal must stay pending for a human decision." \
  >>"$LOG_FILE" 2>&1 &

harvest_pid=$!
( sleep "$HARVEST_TIMEOUT_SECONDS"; kill "$harvest_pid" 2>/dev/null ) &
watchdog_pid=$!
wait "$harvest_pid"
harvest_status=$?
# The watchdog outlives a harvest that finished early, and the PID it holds can be reused.
kill "$watchdog_pid" 2>/dev/null

if [[ "$harvest_status" -eq 0 ]]; then
  log "harvest finished"
else
  log "harvest exited ${harvest_status} — see the lines above for the model's own error"
  file_failure_decision
fi
