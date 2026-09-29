#!/usr/bin/env bash
# Unattended night shift, every third night.
#
# launchd fires this nightly; the stamp gate below turns that into one real shift every three
# nights. A nightly trigger rather than a 72-hour StartInterval because launchd's interval clock
# drifts across sleep, and a shift that slides into the working day would edit repos in use.
# Accepted graphd proposals are filed into ~/nightshift/TASKS.md, so without this
# job they wait for someone to remember `/loop /nightshift`.
#
# Each iteration is one headless `/nightshift` call, which handles one task and prints a
# NIGHTSHIFT_CONTINUE / NIGHTSHIFT_TERMINATE marker. The loop here replaces `/loop`, which only
# exists inside an interactive session.
set -uo pipefail

readonly NIGHTSHIFT_DIR="${HOME}/nightshift"
readonly TASKS_PATH="${NIGHTSHIFT_DIR}/TASKS.md"
readonly STOP_PATH="${NIGHTSHIFT_DIR}/STOP"
# Written when a shift actually starts. graph doctor and the SessionStart hook read its age, so
# a schedule that keeps skipping is reported rather than silent.
readonly STAMP_PATH="${NIGHTSHIFT_DIR}/.last-scheduled-run"
readonly LOG_DIR="${HOME}/.graphd/logs"
readonly LOG_FILE="${LOG_DIR}/nightshift.log"

readonly SECONDS_PER_HOUR=3600
# Three nights less six hours of slack, so a trigger that fires late one night does not push
# the next shift to the fourth night.
readonly MIN_SECONDS_BETWEEN_SHIFTS=$((3 * 24 * SECONDS_PER_HOUR - 6 * SECONDS_PER_HOUR))
# A trigger missed during sleep fires on wake. Starting only before this local hour keeps a
# morning wake from launching a shift into the working day; the next night retries. Override with
# NIGHTSHIFT_LATEST_START_HOUR=24 to start a shift by hand in the daytime.
readonly LATEST_START_HOUR="${NIGHTSHIFT_LATEST_START_HOUR:-5}"
readonly MAX_ITERATIONS=8
readonly ITERATION_TIMEOUT_SECONDS=$((90 * 60))
readonly ITERATION_MAX_TURNS=200
readonly TODO_PATTERN='^- \[todo\] '

# Pinned rather than inherited, for the same reason as run-harvest.sh: the default model moves
# ahead of the installed CLI and fails the whole run with a 400.
readonly NIGHTSHIFT_MODEL="claude-opus-5"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE"
}

has_todo() {
  grep -qE "$TODO_PATTERN" "$TASKS_PATH" 2>/dev/null
}

# Runs one command with a wall-clock limit and returns its exit status.
run_with_timeout() {
  local timeout_seconds="$1"
  shift
  "$@" &
  local command_pid=$!
  ( sleep "$timeout_seconds"; kill "$command_pid" 2>/dev/null ) &
  local watchdog_pid=$!
  wait "$command_pid"
  local command_status=$?
  # The watchdog outlives a command that finished early, and the PID it holds can be reused.
  kill "$watchdog_pid" 2>/dev/null
  return "$command_status"
}

[[ -f "$TASKS_PATH" ]] || {
  log "skip: ${TASKS_PATH} missing"
  exit 0
}
[[ -f "$STOP_PATH" ]] && {
  log "skip: STOP file present"
  exit 0
}

now_seconds="$(date +%s)"
if [[ -f "$STAMP_PATH" ]]; then
  seconds_since_last=$((now_seconds - $(stat -f %m "$STAMP_PATH")))
  if ((seconds_since_last < MIN_SECONDS_BETWEEN_SHIFTS)); then
    log "skip: last shift $((seconds_since_last / SECONDS_PER_HOUR))h ago"
    exit 0
  fi
fi

current_hour=$((10#$(date '+%H')))
if ((current_hour >= LATEST_START_HOUR)); then
  log "skip: ${current_hour}:00 is past the ${LATEST_START_HOUR}:00 start cutoff, retrying tomorrow night"
  exit 0
fi

has_todo || {
  log "skip: no todo tasks"
  exit 0
}

# The native build in ~/.local/bin wins over a package-managed one, which lags the model defaults.
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
if [[ -z "$claude_bin" ]]; then
  log "no claude binary found, skipping shift"
  exit 0
fi

touch "$STAMP_PATH"
log "shift starting with ${claude_bin} ($("$claude_bin" --version 2>/dev/null || echo 'version unknown'))"

# Idle sleep would suspend the shift mid-task; hold it off only for as long as this script lives.
caffeinate -i -w "$$" &

cd "$NIGHTSHIFT_DIR" || exit 0
iterations_run=0
for ((iteration = 1; iteration <= MAX_ITERATIONS; iteration++)); do
  [[ -f "$STOP_PATH" ]] && { log "STOP file appeared, ending shift"; break; }
  has_todo || { log "no todo tasks remain"; break; }

  tasks_before="$(md5 -q "$TASKS_PATH")"
  iteration_output="$(mktemp -t nightshift-iteration)"
  log "iteration ${iteration} starting"
  run_with_timeout "$ITERATION_TIMEOUT_SECONDS" \
    "$claude_bin" -p \
    --permission-mode auto \
    --model "$NIGHTSHIFT_MODEL" \
    --max-turns "$ITERATION_MAX_TURNS" \
    "/nightshift" \
    >"$iteration_output" 2>&1
  iteration_status=$?
  cat "$iteration_output" >>"$LOG_FILE"
  iterations_run=$((iterations_run + 1))

  if ((iteration_status != 0)); then
    log "iteration ${iteration} exited ${iteration_status}, ending shift"
    rm -f "$iteration_output"
    break
  fi
  if grep -q "NIGHTSHIFT_TERMINATE" "$iteration_output"; then
    log "iteration ${iteration} reported TERMINATE, ending shift"
    rm -f "$iteration_output"
    break
  fi
  rm -f "$iteration_output"
  # An iteration always flips its task's status. An unchanged file means it neither finished nor
  # blocked anything, and running again would pick the same task.
  if [[ "$(md5 -q "$TASKS_PATH")" == "$tasks_before" ]]; then
    log "iteration ${iteration} left TASKS.md unchanged, ending shift"
    break
  fi
done

if ((iterations_run > 0)); then
  log "writing morning summary"
  run_with_timeout "$ITERATION_TIMEOUT_SECONDS" \
    "$claude_bin" -p \
    --permission-mode auto \
    --model "$NIGHTSHIFT_MODEL" \
    --max-turns 60 \
    "/nightshift-summary" \
    >>"$LOG_FILE" 2>&1 || log "summary exited $?"
fi
log "shift finished after ${iterations_run} iteration(s)"
