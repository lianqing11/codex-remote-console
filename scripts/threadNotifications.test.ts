import assert from "node:assert/strict";
import { applyTranscriptNotification, terminalKindForTurn } from "../app/threadNotifications";
import {
  discardThreadView,
  getThreadViewState,
  reconcileQueuePendingPrompt,
  setPendingPromptForThread
} from "../app/threadViewStore";

applyTranscriptNotification("codex:t1", {
  method: "turn/started",
  params: { turn: { id: "turn-1", items: [], status: "inProgress", startedAt: 10 } }
});
assert.equal(getThreadViewState().turnsByThread["codex:t1"]["turn-1"].id, "turn-1");

applyTranscriptNotification("codex:t1", {
  method: "item/started",
  params: { turnId: "turn-1", item: { id: "msg-1", type: "agentMessage", text: "Hi" } }
});
assert.equal(getThreadViewState().itemsByThread["codex:t1"]["msg-1"].text, "Hi");
assert.deepEqual(getThreadViewState().itemOrderByThread["codex:t1"], ["msg-1"]);

applyTranscriptNotification("codex:t1", {
  method: "turn/completed",
  params: {
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ id: "msg-1", type: "agentMessage", text: "Hi there" }]
    }
  }
});
assert.equal(getThreadViewState().itemsByThread["codex:t1"]["msg-1"].text, "Hi there");
assert.equal(getThreadViewState().pendingPromptByThread["codex:t1"], undefined);
assert.equal(terminalKindForTurn({ id: "x", items: [], status: "failed" }), "failed");
assert.equal(terminalKindForTurn({ id: "x", items: [], status: "completed" }), "idle");

const fallbackThread = "codex:t2";
applyTranscriptNotification(fallbackThread, {
  method: "turn/started",
  params: { turn: { id: "turn-2", items: [], status: "inProgress", startedAt: 20 } }
});
applyTranscriptNotification(fallbackThread, {
  method: "item/started",
  params: { item: { id: "user-2", type: "userMessage", content: [{ type: "text", text: "Inspect it" }] } }
});
applyTranscriptNotification(fallbackThread, {
  method: "item/completed",
  params: { item: { id: "cmd-2", type: "commandExecution", command: "rg TODO", status: "completed" } }
});
assert.deepEqual(getThreadViewState().turnsByThread[fallbackThread]["turn-2"].itemIds, ["user-2", "cmd-2"]);

applyTranscriptNotification(fallbackThread, {
  method: "turn/completed",
  params: { turn: { id: "turn-2", status: "completed", items: [] } }
});
assert.deepEqual(
  getThreadViewState().turnsByThread[fallbackThread]["turn-2"].itemIds,
  ["user-2", "cmd-2"],
  "a partial completion notification must not discard streamed turn items"
);

discardThreadView("codex:t1");
discardThreadView(fallbackThread);

function assertSingleUserItem(threadId: string, message: string) {
  const view = getThreadViewState();
  const officialCount = Object.values(view.itemsByThread[threadId] || {}).filter((item) => item.type === "userMessage").length;
  assert.equal(officialCount, 1, message);
  assert.equal(view.pendingPromptByThread[threadId], undefined, `${message}: optimistic prompt must be cleared`);
}

const itemThenSnapshot = "codex:item-then-snapshot";
setPendingPromptForThread(itemThenSnapshot, "Race marker A");
applyTranscriptNotification(itemThenSnapshot, {
  method: "turn/started",
  params: { turn: { id: "turn-a", items: [], status: "inProgress", startedAt: 30 } }
});
applyTranscriptNotification(itemThenSnapshot, {
  method: "item/started",
  params: {
    turnId: "turn-a",
    item: { id: "user-a", type: "userMessage", content: [{ type: "text", text: "Race marker A" }] }
  }
});
assert.equal(
  reconcileQueuePendingPrompt(itemThenSnapshot, { text: "Race marker A", status: "running", runId: "turn-a" }),
  "cleared",
  "a late running snapshot must keep a landed prompt cleared"
);
assertSingleUserItem(itemThenSnapshot, "item/started followed by queue:snapshot(running) must end with one card");
discardThreadView(itemThenSnapshot);

const snapshotThenItem = "codex:snapshot-then-item";
setPendingPromptForThread(snapshotThenItem, "Race marker B");
assert.equal(
  reconcileQueuePendingPrompt(snapshotThenItem, { text: "Race marker B", status: "running", runId: "turn-b" }),
  "unchanged",
  "a running snapshot must not create another pending prompt"
);
applyTranscriptNotification(snapshotThenItem, {
  method: "turn/started",
  params: { turn: { id: "turn-b", items: [], status: "inProgress", startedAt: 40 } }
});
applyTranscriptNotification(snapshotThenItem, {
  method: "item/started",
  params: {
    turnId: "turn-b",
    item: { id: "user-b", type: "userMessage", content: [{ type: "text", text: "Race marker B" }] }
  }
});
assertSingleUserItem(snapshotThenItem, "queue:snapshot(running) followed by item/started must end with one card");
discardThreadView(snapshotThenItem);

console.log("thread notification tests passed");
