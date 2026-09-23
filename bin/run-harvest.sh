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
wait "$harvest_pid"
harvest_status=$?

if [[ "$harvest_status" -eq 0 ]]; then
  log "harvest finished"
else
  log "harvest exited ${harvest_status} — see the lines above for the model's own error"
fi
