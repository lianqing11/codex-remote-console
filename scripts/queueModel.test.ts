import assert from "node:assert/strict";
import { activeQueueTurns, queueBarHasActions, queueStatusLabel, queueSummariesByThread, queueThreadSummary, type QueueSnapshot } from "../app/queueModel";

const snapshot: QueueSnapshot = {
  items: [
    {
      id: "queued-a",
      provider: "codex",
      threadKey: "codex:thread-a",
      threadId: "thread-a",
      text: "first",
      cwd: "/tmp",
      threadParams: {},
      turnParams: {},
      status: "needs_review",
      runId: null,
      attempts: 1,
      lastError: "restart",
      baseTree: null,
      diff: null,
      createdAt: 1,
      updatedAt: 2
    },
    {
      id: "queued-b",
      provider: "codex",
      threadKey: "codex:thread-a",
      threadId: "thread-a",
      text: "second",
      cwd: "/tmp",
      threadParams: {},
      turnParams: {},
      status: "queued",
      runId: null,
      attempts: 0,
      lastError: null,
      baseTree: null,
      diff: null,
      createdAt: 3,
      updatedAt: 3
    },
    {
      id: "completed-a",
      provider: "codex",
      threadKey: "codex:thread-a",
      threadId: "thread-a",
      text: "done",
      cwd: "/tmp",
      threadParams: {},
      turnParams: {},
      status: "completed",
      runId: "turn-a",
      attempts: 1,
      lastError: null,
      baseTree: null,
      diff: null,
      createdAt: 0,
      updatedAt: 4
    }
  ],
  threads: [
    {
      threadKey: "codex:thread-a",
      paused: true,
      reason: "Interrupted by restart.",
      updatedAt: 4
    }
  ]
};

const summary = queueThreadSummary(snapshot, "codex:thread-a");
assert.deepEqual(summary.items.map((item) => item.id), ["queued-a", "queued-b"]);
assert.equal(summary.queuedCount, 1);
assert.equal(summary.activeCount, 0);
assert.equal(summary.attentionCount, 1);
assert.equal(summary.threadState?.paused, true);
assert.equal(queueSummariesByThread(snapshot).get("codex:thread-a")?.items.length, 2);
assert.equal(queueBarHasActions(summary), true);
assert.equal(queueBarHasActions({
  items: [{ ...snapshot.items[1], status: "running", runId: "turn-live" }],
  threadState: { threadKey: "codex:thread-a", paused: false, reason: null, updatedAt: 1 },
  queuedCount: 0,
  activeCount: 1,
  attentionCount: 0,
  waitingForInput: false
}), false);
assert.equal(queueStatusLabel("waiting_for_input"), "Needs input");
assert.equal(queueStatusLabel("needs_review"), "Needs review");
assert.deepEqual([...activeQueueTurns({
  items: [
    { ...snapshot.items[0], status: "running", runId: "turn-live", threadKey: "codex:thread-a" },
    { ...snapshot.items[1], status: "queued", runId: null }
  ],
  threads: snapshot.threads
})], [["codex:thread-a", "turn-live"]]);

console.log("queue presentation model tests passed");
