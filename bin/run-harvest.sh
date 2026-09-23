#!/usr/bin/env bash
# Weekly unattended lesson harvest.
#
# Refreshes the store first so the harvest reads the current week, then runs /lesson-harvest
# headless. The skill writes a report and appends proposals; accepting any of them stays a
# human action in the Decisions panel.
set -uo pipefail

readonly REPO_DIR="/Users/chrisliu/romp/graph-mechanism"
readonly CLAUDE_BIN="/opt/homebrew/bin/claude"
readonly IMPORT_WINDOW_DAYS=8
readonly HARVEST_TIMEOUT_SECONDS=1800

"$REPO_DIR/bin/graph-import.mjs" "$IMPORT_WINDOW_DAYS" || exit 0

# A harvest that cannot reach the model should leave last week's report in place rather than
# half-write a new one.
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || exit 0

cd "$REPO_DIR" || exit 0
"$CLAUDE_BIN" -p \
  --permission-mode acceptEdits \
  --max-turns 60 \
  "Run the /lesson-harvest skill over the last 8 days. Write the report to \
~/.claude/telemetry/reports/ and append any proposed rules as pending proposals. \
Apply nothing: every proposal must stay pending for a human decision." \
  >/dev/null 2>&1 &

harvest_pid=$!
( sleep "$HARVEST_TIMEOUT_SECONDS"; kill "$harvest_pid" 2>/dev/null ) &
wait "$harvest_pid"
