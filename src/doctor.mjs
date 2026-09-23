import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KILL_SWITCH_PATH, TOKEN_PATH, loadConfig, isEnforcementEnabled } from "./config.mjs";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const ENG_TASK_PATH = join(homedir(), ".claude", "skills", "eng-task", "SKILL.md");
const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "graph-emit.sh");
const LAUNCHD_LABEL = "com.chrisliu.graphd";
const SECRET_FILE_MODE = 0o600;
const MINIMUM_RUNS_BEFORE_ENFORCING = 10;

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";

function check(name, status, detail) {
  return { name, status, detail };
}

function checkHookRegistration() {
  if (!existsSync(SETTINGS_PATH)) return check("hook registration", FAIL, "no settings.json");
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  const registered = ["PreToolUse", "PostToolUse"].filter((event) =>
    (settings.hooks?.[event] ?? []).some((group) =>
      group.hooks?.some((hook) => (hook.command ?? "").includes("graph-emit")),
    ),
  );
  if (registered.length === 2) return check("hook registration", PASS, "PreToolUse + PostToolUse");
  return check("hook registration", FAIL, `only ${registered.join(", ") || "none"} registered`);
}

function checkHookDependencies() {
  const missing = ["jq", "curl"].filter((binary) => {
    try {
      execFileSync("command", ["-v", binary], { shell: "/bin/bash", stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  if (!existsSync(HOOK_PATH)) return check("hook script", FAIL, "graph-emit.sh missing");
  const isExecutable = Boolean(statSync(HOOK_PATH).mode & 0o111);
  if (!isExecutable) return check("hook script", WARN, "not executable (runs via bash anyway)");
  if (missing.length > 0) return check("hook script", FAIL, `missing ${missing.join(", ")}`);
  return check("hook script", PASS, "executable, jq and curl present");
}

function checkTokenPermissions() {
  if (!existsSync(TOKEN_PATH)) return check("token", FAIL, "no token file");
  const mode = statSync(TOKEN_PATH).mode & 0o777;
  if (mode !== SECRET_FILE_MODE) return check("token", WARN, `mode ${mode.toString(8)}, want 600`);
  return check("token", PASS, "mode 600");
}

function checkLaunchAgent() {
  try {
    const listed = execFileSync("launchctl", ["list"], { encoding: "utf8" });
    return listed.includes(LAUNCHD_LABEL)
      ? check("launch agent", PASS, `${LAUNCHD_LABEL} loaded`)
      : check("launch agent", WARN, "not loaded; daemon will not survive a reboot");
  } catch {
    return check("launch agent", WARN, "launchctl unavailable");
  }
}

function checkEngTaskWiring() {
  if (!existsSync(ENG_TASK_PATH)) return check("eng-task wiring", WARN, "eng-task skill not found");
  const hasTopologyPost = readFileSync(ENG_TASK_PATH, "utf8").includes("/v1/topology");
  return hasTopologyPost
    ? check("eng-task wiring", PASS, "declares and registers topology")
    : check("eng-task wiring", FAIL, "no /v1/topology call — the gate has no door");
}

function checkEnforcementReadiness(store) {
  const config = loadConfig();
  const runCount = store.prepare("SELECT COUNT(*) AS runCount FROM runs").get()?.runCount ?? 0;
  if (existsSync(KILL_SWITCH_PATH)) return check("enforcement", WARN, "paused by kill switch");
  if (!isEnforcementEnabled(config)) return check("enforcement", PASS, `shadow mode, ${runCount} runs`);
  if (runCount < MINIMUM_RUNS_BEFORE_ENFORCING) {
    return check("enforcement", WARN, `blocking with only ${runCount} runs of evidence`);
  }
  const wouldDeny = store
    .prepare("SELECT COUNT(*) AS denyCount FROM policy_checks WHERE would_deny = 1")
    .get()?.denyCount ?? 0;
  return check("enforcement", PASS, `blocking, ${wouldDeny} denies across ${runCount} runs`);
}

const MAX_UNRECONCILED_SHARE = 0.4;

/**
 * Share of background agents still missing a finish time.
 * Their tool call returns in milliseconds, so without a task notification they look instant and
 * every parallelism number silently reads low.
 */
function checkAsyncReconciliation(store) {
  const row = store
    .prepare(
      `SELECT COUNT(*) AS asyncCount,
              SUM(CASE WHEN notified_at IS NULL THEN 1 ELSE 0 END) AS unreconciledCount
         FROM nodes WHERE is_async = 1`,
    )
    .get();
  const asyncCount = row?.asyncCount ?? 0;
  if (asyncCount === 0) return check("async completions", PASS, "no background agents recorded");
  const unreconciled = row?.unreconciledCount ?? 0;
  const detail = `${unreconciled} of ${asyncCount} background agents have no finish time`;
  return unreconciled / asyncCount > MAX_UNRECONCILED_SHARE
    ? check("async completions", WARN, `${detail} — run graph-import`)
    : check("async completions", PASS, detail);
}

/** Runs every configuration check and returns them with the worst status first. */
export function runDiagnostics(store) {
  const order = { [FAIL]: 0, [WARN]: 1, [PASS]: 2 };
  return [
    checkHookRegistration(),
    checkHookDependencies(),
    checkTokenPermissions(),
    checkLaunchAgent(),
    checkEngTaskWiring(),
    checkAsyncReconciliation(store),
    checkEnforcementReadiness(store),
  ].sort((left, right) => order[left.status] - order[right.status]);
}
