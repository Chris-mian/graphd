import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "graphd-state-"));
const settingsPath = join(stateDir, "settings.json");
process.env.GRAPHD_SETTINGS_PATH = settingsPath;
process.env.GRAPHD_STATE_DIR = stateDir;
const { decideProposal } = await import("../src/proposals.mjs");

const HOOK_COMMAND = 'bash "$HOME/.graphd/hooks/empty-search-is-not-absence.sh"';

test("a hook already registered by hand is not registered a second time", () => {
  writeFileSync(
    join(stateDir, "proposals.json"),
    JSON.stringify([
      {
        id: "hook-under-test",
        kind: "hook",
        title: "Prompt a second probe when a search matches nothing",
        status: "pending",
        applies: {
          type: "hook",
          event: "PostToolUse",
          matcher: "Bash",
          command: HOOK_COMMAND,
        },
      },
    ]),
  );
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: HOOK_COMMAND }] }],
      },
    }),
  );

  const decided = decideProposal("hook-under-test", "accepted");

  assert.equal(decided.applied.installed, false);
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  const commands = written.hooks.PostToolUse.flatMap((group) =>
    group.hooks.map((hook) => hook.command),
  );
  assert.deepEqual(commands, [HOOK_COMMAND]);
});
