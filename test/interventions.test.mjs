import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERVENTION_KINDS,
  classifyAssistantText,
  classifyHumanTurn,
  matchedSentence,
} from "../src/interventions.mjs";

const SELF_CORRECTION = INTERVENTION_KINDS.SELF_CORRECTION;

test("a correction opening a turn is a self-correction", () => {
  assert.equal(classifyAssistantText("Correction: no rewrite happened."), SELF_CORRECTION);
  assert.equal(classifyAssistantText("Important correction — #40040 is still open."), SELF_CORRECTION);
  assert.equal(classifyAssistantText("Tracker correction — inline on the stale claim."), SELF_CORRECTION);
});

test("a correction mentioned deep in a report is not one", () => {
  const report =
    "Deployed to staging and health is OK. The branch's canonical KV is bound, migrations ran, " +
    "and the dashboard is live. One open thread from review is the 422 correction: unresolved.";
  assert.equal(classifyAssistantText(report), null);
});

test("a hyphenated compound is not a correction marker", () => {
  assert.equal(classifyAssistantText("Accept the three proposed correction-based rules."), null);
});

test("retraction phrases count anywhere in the turn", () => {
  const buried = `${"filler sentence. ".repeat(20)}I was wrong about the pool.`;
  assert.equal(classifyAssistantText(buried), SELF_CORRECTION);
});

test("non-corrections and empty input classify as null", () => {
  assert.equal(classifyAssistantText("Tests pass, 394 green."), null);
  assert.equal(classifyAssistantText(""), null);
  assert.equal(classifyAssistantText(null), null);
});

test("the quote is the sentence carrying the correction", () => {
  const text = "Correction: the gate is off. Everything else in the summary holds.";
  assert.equal(matchedSentence(text), "Correction: the gate is off.");
});

test("romp recap blocks are not human turns", () => {
  const recap = "<blocked-goals 22792cd2> 1. Offered to squash the two cancelling commits";
  assert.equal(classifyHumanTurn(recap), null);
  assert.equal(classifyHumanTurn("<open-goals 22792cd2> no, that's wrong"), null);
});

test("a real interrupt still classifies", () => {
  assert.equal(classifyHumanTurn("[Request interrupted by user]"), INTERVENTION_KINDS.INTERRUPT);
});

test("an interrupt delivered as a block array still classifies", () => {
  const blocks = [{ type: "text", text: "[Request interrupted by user]" }];
  assert.equal(classifyHumanTurn(blocks), INTERVENTION_KINDS.INTERRUPT);
});

test("a correction delivered as a block array still classifies", () => {
  const blocks = [{ type: "text", text: "no, that's wrong — revert it" }];
  assert.equal(classifyHumanTurn(blocks), INTERVENTION_KINDS.CORRECTION);
});
