import assert from "node:assert/strict";
import {
  applyItemsFromTurns,
  discardThreadView,
  getThreadViewState,
  registerTurnItem,
  setItemOrderForThread,
  setItemsForThread,
  shouldRestoreQueuePendingPrompt,
  subscribeThreadViewFor,
  threadHasLandedUserPrompt,
  threadViewHasConversationHistory
} from "../app/threadViewStore";

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

console.log("thread view store tests passed");
