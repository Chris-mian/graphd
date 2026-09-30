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
  assert.equal(classifyAssistantText("I also owe you a correction: the gate was never on."), SELF_CORRECTION);
});

test("an edit described as a correction is not a retraction", () => {
  assert.equal(classifyAssistantText("Tracker correction — inline on the stale claim."), null);
});

test("a retraction stated as a condition is not one yet", () => {
  const conditional =
    "If it is still red after the rerun, I was wrong about the cause and the pool is fine.";
  assert.equal(classifyAssistantText(conditional), null);
});

test("a rollback named as a measurement is not a human correction", () => {
  assert.equal(classifyHumanTurn("Rollback duration = f(pod count), so chart it that way."), null);
  assert.equal(classifyHumanTurn("if no, why does the job still enqueue?"), null);
});

test("an imperative rollback is still a correction", () => {
  assert.equal(classifyHumanTurn("revert that commit"), INTERVENTION_KINDS.CORRECTION);
  assert.equal(
    classifyHumanTurn("That landed badly. Now roll back the deploy."),
    INTERVENTION_KINDS.CORRECTION,
  );
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

test("a short reply questioning the agent's naming is a correction", () => {
  const turn = "why is it called this? we are simply doing rerouting. no account is blocked.";
  assert.equal(classifyHumanTurn(turn), INTERVENTION_KINDS.CORRECTION);
  const afterPreamble =
    "ok i read through the handler, the enum, the migration and the notice copy you added. " +
    turn;
  assert.equal(classifyHumanTurn(afterPreamble), INTERVENTION_KINDS.CORRECTION);
});

test("disagreement opening a numbered reply is a correction", () => {
  assert.equal(classifyHumanTurn("1. i dont really agree"), INTERVENTION_KINDS.CORRECTION);
  assert.equal(
    classifyHumanTurn("2. sounds good\n3. i don't agree, keep the old name"),
    INTERVENTION_KINDS.CORRECTION,
  );
  assert.equal(classifyHumanTurn("thats not how the queue drains"), INTERVENTION_KINDS.CORRECTION);
  assert.equal(classifyHumanTurn("what do you mean by stale?"), INTERVENTION_KINDS.CORRECTION);
});

test("a challenge phrase inside a long brief is not a correction", () => {
  const brief =
    "New task. Add a naming section to the guide. ".repeat(10) +
    "Readers keep asking why is it called a shard when it is really a partition.";
  assert.equal(classifyHumanTurn(brief), null);
});

test("an earlier measurement the agent retracts is a self-correction", () => {
  const text =
    "`rg` skips hidden dirs by default, and .claude is hidden, so my earlier 'zero' " +
    "measurements were wrong.";
  assert.equal(classifyAssistantText(text), SELF_CORRECTION);
  assert.equal(matchedSentence(text), text);
  assert.equal(classifyAssistantText("My earlier count of open PRs was wrong."), SELF_CORRECTION);
});

test("a retraction phrase the agent is quoting is not a retraction", () => {
  const quoting =
    'Detector false positives beyond the fixtures: "Tracker correction —" and ' +
    '"If it\'s still red ... I was wrong about the cause".';
  assert.equal(classifyAssistantText(quoting), null);
  assert.equal(classifyAssistantText("The pattern `\\bi was wrong\\b` fires anywhere."), null);
  assert.equal(
    classifyAssistantText("It matched 'If it's still red, I was wrong about the cause' again."),
    null,
  );
  assert.equal(classifyAssistantText('"Correction: the gate is off" is the quote it stored.'), null);
});

test("apostrophes around a real retraction do not hide it", () => {
  assert.equal(
    classifyAssistantText("I don't know why, but I was wrong about the pool — it's fine."),
    SELF_CORRECTION,
  );
});
