import assert from "node:assert/strict";
import { attentionThreadKeys, buildFleetSections, epochSeconds, reconcileActiveTurns, type FleetThreadSource } from "../app/fleetModel";

const threads: FleetThreadSource[] = [
  {
    key: "codex:same-id",
    provider: "codex",
    title: "Codex task",
    cwd: "/work/a",
    directory: "a",
    updatedAt: 20,
    statusLabel: "active"
  },
  {
    key: "cursor:same-id",
    provider: "cursor",
    title: "Cursor task",
    cwd: "/work/b",
    directory: "b",
    updatedAt: 30,
    statusLabel: "failed"
  },
  {
    key: "codex:idle",
    provider: "codex",
    title: "Pinned idle",
    cwd: "/work/a",
    directory: "a",
    updatedAt: 10,
    statusLabel: "completed",
    model: "gpt-test",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    mode: "default"
  },
  {
    key: "codex:queued",
    provider: "codex",
    title: "Queued work",
    cwd: "/work/c",
    directory: "c",
    updatedAt: 40,
    statusLabel: "idle",
    queueCount: 2,
    queuePaused: true
  }
];

const sections = buildFleetSections({
  threads,
  requests: [{ threadKey: "codex:same-id", label: "Approval" }],
  activeThreadKeys: ["codex:same-id", "cursor:same-id"],
  pinnedThreadKeys: ["codex:idle", "cursor:same-id", "missing:thread"]
});

assert.equal(sections.all.length, threads.length, "mirrors must not remove source sessions");
assert.deepEqual(sections.needsYou.map((thread) => thread.key), ["codex:queued", "codex:same-id"]);
const approvalThread = sections.needsYou.find((thread) => thread.key === "codex:same-id");
assert.equal(approvalThread?.status, "needsInput", "waiting input outranks active state");
assert.equal(approvalThread?.requestLabel, "Approval");
assert.deepEqual(sections.running.map((thread) => thread.key), ["cursor:same-id"]);
assert.equal(sections.all.find((thread) => thread.key === "cursor:same-id")?.status, "running");
assert.deepEqual(sections.pinned.map((thread) => thread.key), ["codex:idle", "cursor:same-id"]);
assert.equal(sections.all.find((thread) => thread.key === "codex:idle")?.pinned, true);
assert.deepEqual(
  (({ model, reasoningEffort, serviceTier, mode }) => ({ model, reasoningEffort, serviceTier, mode }))(
    sections.all.find((thread) => thread.key === "codex:idle")!
  ),
  { model: "gpt-test", reasoningEffort: "xhigh", serviceTier: "fast", mode: "default" }
);
assert.equal(sections.all.find((thread) => thread.key === "codex:queued")?.status, "paused");
assert.equal(sections.all.find((thread) => thread.key === "codex:queued")?.queueCount, 2);
assert.ok(sections.needsYou.some((thread) => thread.key === "codex:queued"));
assert.deepEqual(sections.queued, []);
assert.deepEqual([...attentionThreadKeys(sections)].sort(), ["codex:queued", "codex:same-id", "cursor:same-id"].sort());

const queuedLive = buildFleetSections({
  threads: [{
    key: "codex:waiting-queue",
    provider: "codex",
    title: "Waiting in queue",
    cwd: "/work/d",
    directory: "d",
    updatedAt: 50,
    statusLabel: "idle",
    queueCount: 1
  }]
});
assert.deepEqual(queuedLive.queued.map((thread) => thread.key), ["codex:waiting-queue"]);
assert.deepEqual([...attentionThreadKeys(queuedLive)], ["codex:waiting-queue"]);

const pendingSend = buildFleetSections({
  threads: [{
    key: "codex:just-sent",
    provider: "codex",
    title: "Just sent",
    cwd: "/work/e",
    directory: "e",
    updatedAt: 60,
    statusLabel: "idle"
  }],
  pendingLiveThreadKeys: ["codex:just-sent"]
});
assert.deepEqual(pendingSend.queued.map((thread) => thread.key), ["codex:just-sent"]);
assert.equal(pendingSend.all[0]?.status, "queued");
assert.ok(attentionThreadKeys(pendingSend).has("codex:just-sent"), "a just-sent session must leave the history list immediately");

const providerIsolation = buildFleetSections({
  threads,
  requests: [{ threadKey: "cursor:same-id", label: "Question" }]
});
assert.equal(providerIsolation.needsYou.find((thread) => thread.key === "cursor:same-id")?.provider, "cursor");
assert.equal(providerIsolation.all.find((thread) => thread.key === "codex:same-id")?.requestCount, 0);

const reconciled = reconcileActiveTurns(
  { "codex:finished": "turn-finished", "codex:live": "turn-live", "codex:not-listed": "turn-unknown" },
  [
    { key: "codex:finished", statusLabel: "idle" },
    { key: "codex:live", statusLabel: "active" }
  ]
);
assert.deepEqual(reconciled, {
  "codex:live": "turn-live",
  "codex:not-listed": "turn-unknown"
}, "an authoritative idle snapshot clears only the stale active marker it covers");

assert.deepEqual(
  reconcileActiveTurns(
    { "codex:finished": "turn-finished", "codex:queued": "turn-queued" },
    [
      { key: "codex:finished", statusLabel: "idle" },
      { key: "codex:queued", statusLabel: "idle" }
    ],
    ["codex:queued"]
  ),
  { "codex:queued": "turn-queued" },
  "queue-active keys stay even when the thread list says idle"
);

assert.equal(epochSeconds(1_786_838_400), 1_786_838_400);
assert.equal(epochSeconds(1_786_838_400_000), 1_786_838_400);
assert.equal(epochSeconds(0), 0);

console.log("fleet model tests passed");
