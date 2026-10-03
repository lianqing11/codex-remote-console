import assert from "node:assert/strict";
import {
  applyItemsFromTurns,
  discardThreadView,
  getThreadViewState,
  latestPlanPayloadFor,
  registerTurnItem,
  reconcileQueueTurnIdentities,
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
import type { QueuedPrompt } from "../app/queueModel";
import { canonicalClaudeTurns } from "../app/claudeTurnIdentity";

// Real Claude transcripts use a user UUID, while queue diffs use a run UUID.
for (const queueFirst of [true, false]) {
  const key = `claude:turn-identity-${queueFirst}`;
  const queue = [1, 2].map((n) => ({
    id: `queue-${n}`, provider: "claude", threadKey: key, runId: `run-${n}`,
    text: "Continue", status: "completed", createdAt: n * 100, updatedAt: n * 100 + 30,
    timings: { startRequestedAt: n * 100_000 + 100, completedAt: n * 100_000 + 30_000 }
  } as QueuedPrompt));
  const history = [1, 2].map((n) => ({
    id: `native-${n}`, startedAt: n * 100 + 2, status: "completed", items: [
      { id: `user-${n}`, type: "userMessage", content: [{ type: "text", text: "Continue" }] },
      { id: `answer-${n}`, type: "agentMessage", text: `Answer ${n}` }
    ]
  }));
  function snapshot() {
    reconcileQueueTurnIdentities(queue);
    for (const n of [1, 2]) {
      const id = `run-${n}-diff`;
      setItemsForThread(key, (items) => ({ ...items, [id]: { id, type: "diff", text: `patch ${n}` } }));
      setItemOrderForThread(key, (ids) => ids.includes(id) ? ids : [...ids, id]);
      registerTurnItem(key, `run-${n}`, id);
    }
  }
  if (queueFirst) snapshot();
  applyItemsFromTurns(key, history);
  if (!queueFirst) snapshot();
  // Repeated reconnect/snapshot hydration must not accumulate synthetic turns.
  for (let i = 0; i < 3; i += 1) {
    snapshot();
    applyItemsFromTurns(key, history);
  }
  const state = getThreadViewState();
  assert.deepEqual(state.turnOrderByThread[key], ["run-1", "run-2"]);
  for (const n of [1, 2]) {
    assert.deepEqual(state.turnsByThread[key][`run-${n}`].itemIds, [`user-${n}`, `answer-${n}`, `run-${n}-diff`]);
  }
  assert.equal(history[0].id, "native-1", "do not mutate provider history");
  assert.equal(canonicalClaudeTurns([{ ...history[0], startedAt: 50 }], queue)[0].id, "native-1", "same text outside execution is not a match");
  assert.equal(canonicalClaudeTurns([{ ...history[0], startedAt: null }], queue)[0].id, "native-1", "missing timing cannot prove identity");
  assert.equal(canonicalClaudeTurns([history[0]], [queue[0], { ...queue[0], runId: "retry" }])[0].id, "native-1", "ambiguous runs stay separate");
  assert.deepEqual(canonicalClaudeTurns([history[0], { ...history[0], id: "compacted" }], queue).map((turn) => turn.id), ["native-1", "compacted"], "one run cannot swallow multiple native turns");
  discardThreadView(key);
  applyItemsFromTurns(key, history);
  assert.deepEqual(getThreadViewState().turnOrderByThread[key], ["run-1", "run-2"], "reopening keeps the queue identity");
  discardThreadView(key);
}

const liveClaude = "claude:live-prompt";
setItemsForThread(liveClaude, { reply: { id: "reply", type: "agentMessage", text: "Working" } });
setItemOrderForThread(liveClaude, ["reply"]);
registerTurnItem(liveClaude, "live-run", "reply");
const liveQueue = { provider: "claude", threadKey: liveClaude, runId: "live-run", text: "Fix the bug",
  status: "running", createdAt: 100, updatedAt: 105 } as QueuedPrompt;
reconcileQueueTurnIdentities([liveQueue]);
assert.equal(threadHasLandedUserPrompt(liveClaude, "Fix the bug", "live-run"), true, "live Claude events omit the user prompt");
assert.deepEqual(getThreadViewState().itemOrderByThread[liveClaude], ["live-run-queue-user", "reply"]);
reconcileQueueTurnIdentities([{ ...liveQueue, status: "completed", updatedAt: 130 }]);
applyItemsFromTurns(liveClaude, [{ id: "native-user", startedAt: 102, status: "completed", items: [
  { id: "native-user-message", type: "userMessage", content: [{ type: "text", text: "Fix the bug" }] },
  { id: "reply", type: "agentMessage", text: "Done" }
] }]);
assert.deepEqual(getThreadViewState().itemOrderByThread[liveClaude], ["native-user-message", "reply"], "history replaces the temporary prompt without duplication");
discardThreadView(liveClaude);

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
