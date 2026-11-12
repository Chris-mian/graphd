import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, startFakeDaemon } from "./helpers/fake-daemon.mjs";

const HOOK_PATH = fileURLToPath(new URL("../hooks/graph-emit.sh", import.meta.url));
const POLICY_CHECK_PATH = "/v1/policy/check";

async function runHookAgainst(decision, toolInput) {
  const daemon = await startFakeDaemon({ [POLICY_CHECK_PATH]: decision });
  const stateDir = mkdtempSync(join(tmpdir(), "graphd-emit-hook-"));
  writeFileSync(join(stateDir, "token"), "test-token");
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: "session-1",
    cwd: stateDir,
    tool_input: toolInput,
  };
  const result = await runCommand("bash", [HOOK_PATH], {
    env: { ...process.env, GRAPHD_URL: daemon.url, GRAPHD_STATE_DIR: stateDir },
    stdin: JSON.stringify(payload),
  });
  await daemon.close();
  const check = daemon.requests.find((request) => request.path === POLICY_CHECK_PATH);
  return { result, check };
}

test("the hook sends the spawn's agent type to the policy check", async () => {
  const { result, check } = await runHookAgainst(
    { isAllowed: true },
    { subagent_type: "Explore", prompt: "find the callers" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(check, "the hook never posted a policy check");
  assert.equal(check.body.agentType, "Explore");
});

test("the hook turns a denied policy check into a deny decision", async () => {
  const { result } = await runHookAgainst(
    { isAllowed: false, reason: "graphd: topology required" },
    { prompt: "implement unit A" },
  );
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.equal(decision.permissionDecisionReason, "graphd: topology required");
});
