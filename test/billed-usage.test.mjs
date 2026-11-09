import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeCost, nodeTokens, pricingBasis, ratesFor, usageCost } from "../src/pricing.mjs";
import { mergeUsage, subagentMeta, usageByModel } from "../src/transcriptusage.mjs";

function assistantEntry({ id, model = "claude-opus-5-5", usage }) {
  return { type: "assistant", uuid: `uuid-${id}-${Math.random()}`, message: { id, model, usage } };
}

const TURN_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 1_000,
  cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
  cache_read_input_tokens: 100_000,
  output_tokens: 500,
};

test("usage is summed per response, at the largest output its entries report", () => {
  const entries = [
    assistantEntry({ id: "msg-1", usage: { ...TURN_USAGE, output_tokens: 4 } }),
    assistantEntry({ id: "msg-1", usage: TURN_USAGE }),
    assistantEntry({ id: "msg-2", usage: TURN_USAGE }),
    { type: "user", message: { content: "next" } },
  ];
  const usage = usageByModel(entries)["claude-opus-5-5"];
  assert.deepEqual(usage, {
    input: 20,
    cacheWrite5m: 1_200,
    cacheWrite1h: 800,
    cacheRead: 200_000,
    output: 1_000,
    turns: 2,
  });
});

test("a response of several iterations sums them rather than reading the last", () => {
  const iteration = { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 5 };
  const entries = [
    assistantEntry({ id: "msg-1", usage: { ...iteration, iterations: [iteration, iteration, iteration] } }),
  ];
  const usage = usageByModel(entries)["claude-opus-5-5"];
  assert.equal(usage.cacheRead, 30);
  assert.equal(usage.output, 15);
  assert.equal(usage.turns, 1);
});

test("excluded message ids, such as a fork's inherited parent turn, are not counted", () => {
  const entries = [
    assistantEntry({ id: "parent-turn", usage: TURN_USAGE }),
    assistantEntry({ id: "own-turn", usage: TURN_USAGE }),
  ];
  assert.equal(usageByModel(entries, new Set(["parent-turn"]))["claude-opus-5-5"].turns, 1);
});

test("a partially billed Workflow keeps the billed sum as its floor and scales the estimate", () => {
  const partial = {
    billed_share: 0.5,
    billed_usage: JSON.stringify({
      "claude-opus-5-5": { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, turns: 1 },
    }),
  };
  assert.deepEqual(nodeCost(partial), { low: 4, high: 8, estimate: 8 });
  assert.equal(pricingBasis(partial), "partial");
});

test("synthetic turns bill nothing and are skipped", () => {
  const entries = [assistantEntry({ id: "msg-1", model: "<synthetic>", usage: TURN_USAGE })];
  assert.deepEqual(usageByModel(entries), {});
});

test("cache reads are priced at the model's own read rate, not the input rate", () => {
  const cost = usageCost({
    "claude-opus-5-5": { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000, output: 0, turns: 1 },
  });
  assert.equal(cost, 0.2);
});

test("cache writes cost 1.25x input for 5 minutes and 2x for an hour", () => {
  const cost = usageCost({
    "claude-opus-5": { input: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 0, output: 0, turns: 1 },
  });
  assert.equal(cost, 5 * 1.25 + 5 * 2);
});

test("a dotted model id is not priced as its shorter prefix", () => {
  assert.equal(ratesFor("claude-opus-5-5").input, 4);
  assert.equal(ratesFor("claude-haiku-5-5").input, 0.1);
  assert.equal(ratesFor("opus").input, 4);
});

test("a billed node's bounds collapse onto its exact cost; an unbilled one keeps the estimate", () => {
  const billed = {
    total_tokens: 50_000,
    model: "opus",
    billed_usage: JSON.stringify({
      "claude-opus-5-5": { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, turns: 3 },
    }),
  };
  assert.deepEqual(nodeCost(billed), { low: 4, high: 4, estimate: 4 });
  assert.equal(nodeTokens(billed), 1_000_000);
  assert.equal(pricingBasis(billed), "billed");

  const contextOnly = { total_tokens: 1_000_000, resolved_model: "claude-opus-5" };
  assert.equal(nodeCost(contextOnly).low, 5);
  assert.equal(nodeTokens(contextOnly), 1_000_000);
  assert.equal(pricingBasis(contextOnly), "context");
  assert.equal(pricingBasis({}), "none");
});

test("usage records merge model by model", () => {
  const one = { a: { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5, turns: 1 } };
  const two = { a: { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, output: 1, turns: 1 }, b: one.a };
  assert.deepEqual(mergeUsage([one, two]), {
    a: { input: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5, output: 6, turns: 2 },
    b: one.a,
  });
});

test("subagent meta resolves a top-level agent and ignores workflow agents and main transcripts", () => {
  const root = mkdtempSync(join(tmpdir(), "graphd-meta-"));
  const subagents = join(root, "session-1", "subagents");
  mkdirSync(join(subagents, "workflows", "run-1"), { recursive: true });
  writeFileSync(join(subagents, "agent-abc.meta.json"), JSON.stringify({ toolUseId: "toolu_1" }));
  writeFileSync(join(subagents, "agent-abc.jsonl"), "");
  writeFileSync(join(subagents, "agent-ateam-x.meta.json"), JSON.stringify({ name: "team-x" }));
  writeFileSync(join(subagents, "workflows", "run-1", "agent-def.meta.json"), "{}");

  assert.deepEqual(subagentMeta(join(subagents, "agent-abc.jsonl")), {
    agentId: "abc",
    sessionId: "session-1",
    toolUseId: "toolu_1",
    name: null,
    isFork: false,
  });
  assert.equal(subagentMeta(join(subagents, "agent-ateam-x.jsonl")).name, "team-x");
  assert.equal(subagentMeta(join(subagents, "workflows", "run-1", "agent-def.jsonl")), null);
  assert.equal(subagentMeta(join(root, "session-1.jsonl")), null);
  assert.equal(subagentMeta(join(subagents, "agent-missing.jsonl")), null);
});
