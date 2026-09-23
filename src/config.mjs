import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.GRAPHD_STATE_DIR ?? join(homedir(), ".graphd");
export const DB_PATH = join(STATE_DIR, "graph.db");
export const TOKEN_PATH = join(STATE_DIR, "token");
export const CONFIG_PATH = join(STATE_DIR, "config.json");
export const KILL_SWITCH_PATH = join(STATE_DIR, "DISABLED");

const STATE_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
const TOKEN_BYTE_LENGTH = 32;

export const DEFAULT_CONFIG = {
  bind: "127.0.0.1",
  port: 8787,
  enforce: false,
  rules: {
    requireTopologyBeyondNAgents: {
      enabled: true,
      threshold: 2,
      windowMinutes: 30,
    },
  },
};

export function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: STATE_DIR_MODE });
}

/**
 * Returns the daemon auth token, generating it on first call.
 * Required on loopback too, so remote exposure needs no redesign.
 */
export function readOrCreateToken() {
  ensureStateDir();
  if (!existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, randomBytes(TOKEN_BYTE_LENGTH).toString("hex"), {
      mode: SECRET_FILE_MODE,
    });
  }
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

/** Reads config from disk, writing defaults on first call. A corrupt file yields defaults. */
export function loadConfig() {
  ensureStateDir();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      mode: SECRET_FILE_MODE,
    });
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const configOnDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...structuredClone(DEFAULT_CONFIG), ...configOnDisk };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Merges a patch into config.json and returns the stored result. */
export function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  return merged;
}

/** Creates or removes the kill-switch file. */
export function setPaused(isPaused) {
  ensureStateDir();
  if (isPaused) writeFileSync(KILL_SWITCH_PATH, "", { mode: SECRET_FILE_MODE });
  else if (existsSync(KILL_SWITCH_PATH)) rmSync(KILL_SWITCH_PATH);
  return isPaused;
}

/**
 * True when the daemon may deny a spawn.
 * Three independent off switches, all read per request so a session can be freed from a
 * shell without restarting the daemon.
 */
export function isEnforcementEnabled(config) {
  if (process.env.GRAPHD_DISABLE === "1") return false;
  if (existsSync(KILL_SWITCH_PATH)) return false;
  return config.enforce === true;
}
