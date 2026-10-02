import assert from "node:assert/strict";
import {
  applyItemsFromTurns,
  discardThreadView,
  getThreadViewState,
  latestPlanPayloadFor,
  registerTurnItem,
  setItemOrderForThread,
  setItemsForThread,
  setPendingPromptForThread,
  setTurnsForThread,
  shouldRestoreQueuePendingPrompt,
  subscribeThreadViewFor,
  threadHasLandedUserPrompt,
  threadViewHasConversationHistory
} from "../app/threadViewStore";
import type { ThreadItem } from "../app/threadModel";

const threadKey = "codex:history-after-diff";
const turnId = "turn-1";
const diffId = `${turnId}-diff`;

setItemsForThread(threadKey, {
  [diffId]: { id: diffId, type: "diff", text: "diff --git a/a b/a" }
});
setItemOrderForThread(threadKey, [diffId]);
registerTurnItem(threadKey, turnId, diffId);

assert.equal(threadViewHasConversationHistory(threadKey), false);

applyItemsFromTurns(threadKey, [{
  id: turnId,
  status: "completed",
  items: [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Fix it" }] },
    { id: "agent-1", type: "agentMessage", text: "Fixed." }
  ]
}]);

const view = getThreadViewState();
assert.equal(threadViewHasConversationHistory(threadKey), true);
assert.deepEqual(view.itemOrderByThread[threadKey], ["user-1", "agent-1", diffId]);
assert.deepEqual(view.turnsByThread[threadKey][turnId].itemIds, ["user-1", "agent-1", diffId]);
assert.equal(view.itemsByThread[threadKey][diffId].type, "diff");

discardThreadView(threadKey);
assert.equal(threadViewHasConversationHistory(threadKey), false);

const watched = "codex:watched";
const background = "codex:background";
let watchedFires = 0;
let backgroundFires = 0;
const stopWatched = subscribeThreadViewFor(watched, () => {
  watchedFires += 1;
});
const stopBackground = subscribeThreadViewFor(background, () => {
  backgroundFires += 1;
});
setItemsForThread(background, { "bg-1": { id: "bg-1", type: "agentMessage", text: "bg" } });
assert.equal(watchedFires, 0);
assert.equal(backgroundFires, 1);
setItemsForThread(watched, { "w-1": { id: "w-1", type: "agentMessage", text: "w" } });
assert.equal(watchedFires, 1);
assert.equal(backgroundFires, 1);
stopWatched();
stopBackground();
discardThreadView(watched);
discardThreadView(background);

const replay = "codex:queue-replay";
setItemsForThread(replay, {
  "user-landed": { id: "user-landed", type: "userMessage", content: [{ type: "text", text: "Ship the fix" }] }
});
registerTurnItem(replay, "turn-landed", "user-landed");
assert.equal(threadHasLandedUserPrompt(replay, "Ship the fix", "turn-landed"), true);
assert.equal(threadHasLandedUserPrompt(replay, "Something else", "turn-landed"), false);
assert.equal(threadHasLandedUserPrompt(replay, "Ship the fix", "turn-new"), false, "historical duplicate text is outside a new turn");
assert.equal(threadHasLandedUserPrompt(replay, "Ship the fix", null), false, "an unstarted queued item has no landed turn");
assert.equal(shouldRestoreQueuePendingPrompt("queued", true), false, "snapshot replay must not restore a landed user prompt");
assert.equal(shouldRestoreQueuePendingPrompt("dispatching", false), false, "a dispatching item must not restore pending prompt");
assert.equal(shouldRestoreQueuePendingPrompt("running", false), false, "a running item must not restore pending prompt");
assert.equal(shouldRestoreQueuePendingPrompt("waiting_for_input", false), false, "an input wait must not restore pending prompt");
assert.equal(shouldRestoreQueuePendingPrompt("queued", false), true, "an unstarted queued item can restore pending prompt");
discardThreadView(replay);

const claudePlan = "claude:plan-result";
const planText = "1. Implement the change\n2. Verify it";
const oldPlan = {
  id: "old-plan", status: "completed", items: [
    { id: "old-reply", type: "agentMessage", text: "Old plan" }
  ]
};
function loadClaudeTurn(status: unknown, items: ThreadItem[], pending = false) {
  applyItemsFromTurns(claudePlan, [oldPlan, { id: "latest-plan", status, items }]);
  if (pending) {
    setTurnsForThread(claudePlan, (current) => ({
      ...current, "latest-plan": { ...current["latest-plan"], pending: true }
    }));
  }
}
loadClaudeTurn("completed", [
  { id: "progress", type: "agentMessage", phase: "commentary", text: "Inspecting" },
  { id: "reasoning", type: "reasoning", text: "Comparing" },
  { id: "reply", type: "agentMessage", text: planText }
]);
assert.equal(latestPlanPayloadFor(claudePlan, true), planText, "completed Claude legacy reply is executable");
assert.equal(latestPlanPayloadFor(claudePlan), "", "legacy replies require Plan-mode opt-in");
const otherClaudePlan = "claude:other-plan-result";
applyItemsFromTurns(otherClaudePlan, [{ id: "other-turn", status: "completed", items: [
  { id: "other-reply", type: "agentMessage", text: "Other session plan" }
] }]);
assert.equal(latestPlanPayloadFor(otherClaudePlan, true), "Other session plan");
assert.equal(latestPlanPayloadFor(claudePlan, true), planText, "switching sessions keeps each plan isolated");
discardThreadView(claudePlan);
loadClaudeTurn({ type: "completed" }, [{ id: "reply", type: "agentMessage", text: planText }]);
assert.equal(latestPlanPayloadFor(claudePlan, true), planText, "rehydrated history restores the plan");
for (const status of ["inProgress", "running", "failed", "interrupted", "cancelled", "failed-after-restart", undefined]) {
  loadClaudeTurn(status, [{ id: "reply", type: "agentMessage", phase: "final_answer", text: planText }]);
  assert.equal(latestPlanPayloadFor(claudePlan, true), "", `turn ${String(status)} must not execute a reply or old plan`);
}
loadClaudeTurn("completed", [
  { id: "progress", type: "agentMessage", phase: "commentary", text: "Inspecting" },
  { id: "reasoning", type: "reasoning", text: "Comparing" }
]);
assert.equal(latestPlanPayloadFor(claudePlan, true), "", "progress-only turns must not reuse history");
loadClaudeTurn("completed", [{ id: "reply", type: "agentMessage", text: planText }], true);
assert.equal(latestPlanPayloadFor(claudePlan, true), "", "pending turns are not executable");
loadClaudeTurn("completed", [{ id: "reply", type: "agentMessage", text: planText }]);
setItemsForThread(claudePlan, (current) => ({ ...current, "old-diff": { id: "old-diff", type: "diff", text: "old diff" } }));
registerTurnItem(claudePlan, "old-diff-run", "old-diff");
loadClaudeTurn("completed", [{ id: "reply", type: "agentMessage", text: planText }]);
assert.equal(latestPlanPayloadFor(claudePlan, true), planText, "preserved diff-only groups must not hide the latest reply");
setPendingPromptForThread(claudePlan, "Refine the plan");
assert.equal(latestPlanPayloadFor(claudePlan, true), "", "a new pending prompt must not execute the old plan");
discardThreadView(claudePlan);
discardThreadView(otherClaudePlan);

console.log("thread view store tests passed");
