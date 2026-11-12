#!/usr/bin/env bash
# PreToolUse / PostToolUse hook for Agent and Workflow spawns.
#
# Emits node lifecycle events to graphd and, on PreToolUse, asks it whether the spawn is
# allowed. Every failure path allows the spawn: a daemon that is down, slow, or confused
# must never be able to stop a session.
set -uo pipefail

readonly GRAPHD_URL="${GRAPHD_URL:-http://127.0.0.1:8787}"
readonly TOKEN_FILE="${GRAPHD_STATE_DIR:-$HOME/.graphd}/token"
readonly REQUEST_TIMEOUT_SECONDS=0.2
readonly MAX_TEXT_CHARS=4000
readonly TRACKED_TOOLS='Agent|Workflow|Task|Skill|SendMessage'
readonly SPAWN_TOOLS='Agent|Workflow|Task'

allow_and_exit() { exit 0; }

# Client-side hatch: works even when the daemon is unreachable or misconfigured.
[ "${GRAPHD_DISABLE:-0}" = "1" ] && allow_and_exit

command -v jq >/dev/null 2>&1 || allow_and_exit
command -v curl >/dev/null 2>&1 || allow_and_exit
[ -r "$TOKEN_FILE" ] || allow_and_exit
readonly TOKEN="$(cat "$TOKEN_FILE")"

hook_payload_json="$(cat)"

tool_name="$(printf '%s' "$hook_payload_json" | jq -r '.tool_name // ""')"
[[ "$tool_name" =~ ^($TRACKED_TOOLS)$ ]] || allow_and_exit

hook_event="$(printf '%s' "$hook_payload_json" | jq -r '.hook_event_name // ""')"
session_id="$(printf '%s' "$hook_payload_json" | jq -r '.session_id // ""')"
session_cwd="$(printf '%s' "$hook_payload_json" | jq -r '.cwd // ""')"
agent_prompt="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.prompt // ""')"
agent_type="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.subagent_type // ""')"
agent_label="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.description // .tool_input.name // ""')"
agent_name="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.name // ""')"
agent_model="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.model // ""')"

# The prompt hash pairs a spawn with its result; the random suffix keeps two identical prompts
# in one session as two nodes. The daemon matches an end to the oldest running node by hash.
prompt_sha="$(printf '%s|%s|%s' "$session_id" "$tool_name" "$agent_prompt" | shasum -a 256 | cut -c1-16)"
node_id="$prompt_sha-$(head -c 4 /dev/urandom | xxd -p)"

post_json() {
  curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -H "Authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    -X POST "$GRAPHD_URL$1" -d "$2" 2>/dev/null
}

# Neither Skill nor SendMessage spawns anything, so neither is ever gated. SendMessage is
# recorded because a resume is the only way a blocked agent gets unblocked, and without it an
# agent that stopped to ask a question looks the same as one that finished.
if [[ ! "$tool_name" =~ ^($SPAWN_TOOLS)$ ]]; then
  [ "$hook_event" = "PreToolUse" ] || allow_and_exit
  if [ "$tool_name" = "SendMessage" ]; then
    resume_target="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.to // ""')"
    resume_body="$(jq -nc --arg sessionId "$session_id" --arg cwd "$session_cwd" \
      --arg targetRef "$resume_target" \
      '{kind: "resumption", sessionId: $sessionId, cwd: $cwd, targetRef: $targetRef}')"
    post_json /v1/events "$resume_body" >/dev/null
    allow_and_exit
  fi
  skill_name="$(printf '%s' "$hook_payload_json" | jq -r '.tool_input.skill // ""')"
  skill_body="$(jq -nc --arg sessionId "$session_id" --arg cwd "$session_cwd" --arg skill "$skill_name" \
    '{kind: "skill_invoked", sessionId: $sessionId, cwd: $cwd, skill: $skill}')"
  post_json /v1/events "$skill_body" >/dev/null
  allow_and_exit
fi

if [ "$hook_event" = "PostToolUse" ]; then
  # A background agent's tool call returns in milliseconds and the work happens after, so this
  # event closes the handoff only. taskId (the output file's basename) is what a later task
  # notification uses to report the real finish time.
  end_body="$(printf '%s' "$hook_payload_json" | jq -c \
    --arg nodeId "$node_id" --arg sessionId "$session_id" --arg label "$agent_label" \
    --arg prompt "$agent_prompt" --argjson maxResultChars "$MAX_TEXT_CHARS" \
    '{kind: "node_end", nodeId: $nodeId, sessionId: $sessionId, label: $label, prompt: $prompt,
      status: (.tool_response.status // "ok"),
      result: {
        agentId:       .tool_response.agentId,
        resolvedModel: .tool_response.resolvedModel,
        totalTokens:   .tool_response.totalTokens,
        toolUseCount:  .tool_response.totalToolUseCount,
        durationMs:    .tool_response.totalDurationMs,
        isAsync:       (.tool_response.isAsync // false),
        outputFile:    .tool_response.outputFile,
        taskId:        ((.tool_response.outputFile // "") | split("/") | last | split(".") | first),
        resultText:    ((.tool_response.content // null) | if . == null then null
                        else (if type == "array" then (map(.text // "") | join("\n")) else tostring end)
                             | .[0:$maxResultChars] end)
      }}')"
  post_json /v1/events "$end_body" >/dev/null
  allow_and_exit
fi

check_body="$(jq -nc --arg sessionId "$session_id" --arg cwd "$session_cwd" --arg tool "$tool_name" \
  --arg agentType "$agent_type" \
  '{sessionId: $sessionId, cwd: $cwd, tool: $tool, agentType: $agentType}')"
decision_json="$(post_json /v1/policy/check "$check_body")"

spawn_body="$(jq -nc \
  --arg nodeId "$node_id" --arg sessionId "$session_id" --arg cwd "$session_cwd" \
  --arg tool "$tool_name" --arg agentType "$agent_type" --arg label "$agent_label" \
  --arg name "$agent_name" --arg model "$agent_model" --arg prompt "$agent_prompt" \
  '{kind: "node_spawn", nodeId: $nodeId, sessionId: $sessionId, cwd: $cwd, tool: $tool,
    agentType: $agentType, label: $label, name: $name, model: $model, prompt: $prompt}')"

# jq's // treats false as empty, so `.isAllowed // true` would swallow every deny.
is_allowed="$(printf '%s' "$decision_json" \
  | jq -r 'if .isAllowed == false then "false" else "true" end' 2>/dev/null)"
if [ "$is_allowed" = "false" ]; then
  deny_reason="$(printf '%s' "$decision_json" | jq -r '.reason // "graphd: topology required"')"
  jq -nc --arg reason "$deny_reason" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
                           permissionDecisionReason: $reason}}'
  exit 0
fi

post_json /v1/events "$spawn_body" >/dev/null
allow_and_exit
