import assert from "node:assert/strict";
import {
  providerFromThreadKey,
  providerOf,
  activeTurnIdFromTurns,
  deriveSessionPhase,
  epochSeconds,
  hydrateListedThread,
  assistantMessagePhase,
  isAssistantMessageItem,
  isUserMessageItem,
  mergeThreadsById,
  nativeThreadId,
  normalizeThread,
  patchListedThread,
  partitionTurnItems,
  reuseDisplayTurns,
  sessionPhaseClaimsRunning,
  shouldShowPendingPrompt,
  threadIsActive,
  threadKey,
  threadTitle,
  turnsHaveItems
} from "../app/threadModel";

assert.equal(epochSeconds(1_786_838_400), 1_786_838_400);
assert.equal(epochSeconds(1_786_838_400_000), 1_786_838_400);
assert.equal(epochSeconds(0), 0);
assert.equal(epochSeconds(new Date(1_786_838_400_000).toISOString()), 1_786_838_400);
assert.equal(epochSeconds(new Date(1_786_838_400_000)), 1_786_838_400);

const cursor = normalizeThread({
  id: "abc",
  provider: "cursor",
  preview: "Work",
  cwd: "/tmp",
  updatedAt: 10,
  status: { type: "idle" },
  name: "Work",
  turns: []
});
assert.equal(cursor.id, "cursor:abc");
assert.equal(nativeThreadId(cursor), "abc");
assert.equal(threadKey(cursor), "cursor:abc");
assert.equal(threadKey("abc", "cursor"), "cursor:abc");
assert.equal(threadTitle(cursor), "Work");
assert.equal(providerFromThreadKey("claude:550e8400-e29b-41d4-a716-446655440000"), "claude");
assert.equal(providerOf({ id: "claude:abc", provider: "claude" } as any), "claude");
assert.equal(threadKey("abc", "claude"), "claude:abc");

assert.equal(sessionPhaseClaimsRunning("inProgress"), true);
assert.equal(sessionPhaseClaimsRunning("active"), true);
assert.equal(sessionPhaseClaimsRunning("idle"), false);

const running = { id: "codex:t1", status: { type: "completed" } };
assert.equal(deriveSessionPhase(running, { "codex:t1": "turn-1" }), "running");
assert.equal(deriveSessionPhase({ id: "codex:t1", status: { type: "inProgress" } }), "running");
assert.equal(deriveSessionPhase({ id: "codex:t1", status: { type: "idle" } }, {}, new Set(["codex:t1"])), "waiting");
assert.equal(deriveSessionPhase({ id: "codex:t1", status: { type: "failed" } }), "failed");
assert.equal(deriveSessionPhase({ id: "codex:t1", status: { type: "idle" } }, {}, new Set(), { waiting: true }), "waiting");
assert.equal(threadIsActive({ id: "codex:t1", status: { type: "streaming" } }), true);

assert.equal(
  activeTurnIdFromTurns([
    { id: "old", items: [], status: "completed" },
    { id: "live", items: [], status: "inProgress" }
  ]),
  "live"
);

const older = normalizeThread({
  id: "older",
  provider: "codex",
  preview: "Older",
  cwd: "/tmp",
  updatedAt: 10,
  status: { type: "idle" },
  name: "Older",
  turns: []
});
const newer = normalizeThread({
  id: "newer",
  provider: "codex",
  preview: "Newer",
  cwd: "/tmp",
  updatedAt: 20,
  status: { type: "idle" },
  name: "Newer",
  turns: []
});
const opened = mergeThreadsById([newer, older], [{ ...older, preview: "Opened", updatedAt: 99 }]);
assert.deepEqual(opened.map((thread) => thread.id), ["codex:newer", "codex:older"]);
assert.equal(opened[1].preview, "Opened");
assert.equal(opened[1].updatedAt, 10);

const created = mergeThreadsById([newer, older], [{
  id: "fresh",
  provider: "codex",
  preview: "Fresh",
  cwd: "/tmp",
  updatedAt: 30,
  status: { type: "idle" },
  name: "Fresh",
  turns: []
}]);
assert.deepEqual(created.map((thread) => thread.id), ["codex:fresh", "codex:newer", "codex:older"]);

const listed = [
  normalizeThread({
    id: "top",
    provider: "codex",
    preview: "Top",
    cwd: "/work/a",
    updatedAt: 30,
    status: { type: "idle" },
    name: "Top",
    turns: []
  }),
  normalizeThread({
    id: "mid",
    provider: "codex",
    preview: "Mid",
    cwd: "/work/a",
    updatedAt: 20,
    status: { type: "idle" },
    name: "Mid",
    empty: false,
    turns: []
  }),
  normalizeThread({
    id: "bottom",
    provider: "codex",
    preview: "Bottom",
    cwd: "/work/b",
    updatedAt: 10,
    status: { type: "idle" },
    name: "Bottom",
    turns: []
  })
];
const openedMid = mergeThreadsById(listed, [{
  ...listed[1],
  preview: "Opened mid",
  cwd: "/other",
  updatedAt: 1
}]);
assert.deepEqual(openedMid.map((thread) => thread.id), ["codex:top", "codex:mid", "codex:bottom"]);
assert.equal(openedMid[1].preview, "Opened mid");
assert.equal(openedMid[1].cwd, "/work/a");
assert.equal(openedMid[1].updatedAt, 20);

const patched = patchListedThread(listed, {
  ...listed[1],
  id: "other-id",
  preview: "Patched mid",
  cwd: "/moved",
  empty: true,
  updatedAt: 99
}, "codex:mid");
assert.deepEqual(patched.map((thread) => thread.id), ["codex:top", "codex:mid", "codex:bottom"]);
assert.equal(patched[1].preview, "Patched mid");
assert.equal(patched[1].cwd, "/work/a");
assert.equal(patched[1].updatedAt, 20);
assert.equal(patched[1].empty, false);

const openedIdentity = hydrateListedThread(listed[1], {
  ...listed[1],
  id: "other-id",
  updatedAt: 99,
  cwd: "/moved"
});
assert.equal(threadKey(openedIdentity), "codex:mid");
assert.equal(openedIdentity.updatedAt, 20);
assert.equal(openedIdentity.cwd, "/work/a");

assert.equal(isUserMessageItem({ type: "userMessage" }), true);
assert.equal(isUserMessageItem({ type: "user_message" }), true);
assert.equal(isUserMessageItem({ type: "message", role: "user" }), true);
assert.equal(isUserMessageItem({ type: "agentMessage" }), false);
assert.equal(isAssistantMessageItem({ type: "agentMessage" }), true);
assert.equal(isAssistantMessageItem({ type: "message", role: "assistant" }), true);
assert.equal(assistantMessagePhase({ type: "agentMessage", phase: "commentary" }), "commentary");
assert.equal(assistantMessagePhase({ type: "agentMessage", phase: "final_answer" }), "final");
assert.equal(assistantMessagePhase({ type: "agentMessage" }), "unknown");

const phasedSections = partitionTurnItems([
  { id: "user", type: "userMessage" },
  { id: "update-1", type: "agentMessage", phase: "commentary", text: "Checking" },
  { id: "tool-1", type: "toolCall", tool: "rg" },
  { id: "answer", type: "agentMessage", phase: "final_answer", text: "Done" },
  { id: "diff", type: "diff", text: "diff --git" }
]);
assert.equal(phasedSections.userItem?.id, "user");
assert.deepEqual(phasedSections.workItems.map((item) => item.id), ["update-1", "tool-1"]);
assert.deepEqual(phasedSections.finalItems.map((item) => item.id), ["answer"]);
assert.deepEqual(phasedSections.diffItems.map((item) => item.id), ["diff"]);

const legacyTerminalSections = partitionTurnItems([
  { id: "legacy-update", type: "agentMessage", text: "Working" },
  { id: "legacy-tool", type: "toolCall", tool: "Glob" },
  { id: "legacy-answer", type: "agentMessage", text: "Finished" }
]);
assert.deepEqual(legacyTerminalSections.workItems.map((item) => item.id), ["legacy-update", "legacy-tool"]);
assert.deepEqual(legacyTerminalSections.finalItems.map((item) => item.id), ["legacy-answer"]);

const legacyActiveSections = partitionTurnItems([
  { id: "live", type: "agentMessage", text: "Still working" }
], true);
assert.deepEqual(legacyActiveSections.workItems.map((item) => item.id), ["live"]);
assert.equal(legacyActiveSections.finalItems.length, 0);

const terminalPlanSections = partitionTurnItems([
  { id: "plan-user", type: "userMessage", text: "Make a plan" },
  { id: "plan-update", type: "agentMessage", phase: "commentary", text: "Inspecting" },
  { id: "plan-reasoning", type: "reasoning", text: "Comparing options" },
  { id: "plan-result", type: "plan", text: "1. Implement\n2. Verify" }
], false, true);
assert.deepEqual(terminalPlanSections.workItems.map((item) => item.id), ["plan-update", "plan-reasoning"]);
assert.deepEqual(terminalPlanSections.finalItems.map((item) => item.id), ["plan-result"]);

const activePlanSections = partitionTurnItems([
  { id: "active-plan-update", type: "agentMessage", phase: "commentary", text: "Still planning" },
  { id: "active-plan-result", type: "plan", text: "Draft plan" }
], true, false);
assert.deepEqual(activePlanSections.workItems.map((item) => item.id), ["active-plan-update", "active-plan-result"]);
assert.equal(activePlanSections.finalItems.length, 0);

const interruptedPlanSections = partitionTurnItems([
  { id: "interrupted-plan-update", type: "agentMessage", phase: "commentary", text: "Planning" },
  { id: "interrupted-plan-result", type: "plan", text: "Partial plan" }
], false, false);
assert.deepEqual(interruptedPlanSections.workItems.map((item) => item.id), ["interrupted-plan-update", "interrupted-plan-result"]);
assert.equal(interruptedPlanSections.finalItems.length, 0);
assert.equal(turnsHaveItems([{ id: "t", items: [], status: "completed" }]), false);
assert.equal(turnsHaveItems([{ id: "t", items: [{ id: "i", type: "agentMessage" }], status: "completed" }]), true);

const idleUser = { id: "user-1", type: "userMessage", text: "Hi" };
const idleAgent = { id: "agent-1", type: "agentMessage", text: "Hello" };
const idleTurn = {
  id: "turn-idle",
  itemIds: ["user-1", "agent-1"],
  items: [idleUser, idleAgent],
  status: { type: "completed" },
  pending: false
};
const liveTurn = {
  id: "turn-live",
  itemIds: ["live-1"],
  items: [{ id: "live-1", type: "agentMessage", text: "He" }],
  status: { type: "inProgress" }
};
const firstRounds = reuseDisplayTurns([], [idleTurn, liveTurn]);
const nextRounds = reuseDisplayTurns(firstRounds, [
  { ...idleTurn, items: [idleUser, idleAgent] },
  { ...liveTurn, items: [{ id: "live-1", type: "agentMessage", text: "Hello" }] }
]);
assert.equal(nextRounds[0], firstRounds[0]);
assert.notEqual(nextRounds[1], firstRounds[1]);
assert.equal(nextRounds[1].items[0].text, "Hello");

assert.equal(shouldShowPendingPrompt("Fix the leak", null, null), true);
assert.equal(
  shouldShowPendingPrompt(
    "Fix the leak",
    {
      id: "turn-active",
      items: [{ id: "user-2", type: "userMessage", content: [{ type: "text", text: "Fix the leak" }] }]
    },
    "turn-active"
  ),
  false,
  "a matching user item in the active turn must hide the optimistic pending card"
);
assert.equal(
  shouldShowPendingPrompt(
    "Fix the leak",
    { id: "turn-active", items: [{ id: "user-3", type: "userMessage", text: "Something else" }] },
    "turn-active"
  ),
  true
);
assert.equal(
  shouldShowPendingPrompt(
    "Fix the leak",
    { id: "turn-history", items: [{ id: "user-history", type: "userMessage", text: "Fix the leak" }] },
    "turn-new"
  ),
  true,
  "the same text in a historical turn must not hide a new optimistic card"
);
assert.equal(
  shouldShowPendingPrompt(
    "Fix the leak",
    { id: "turn-history", items: [{ id: "user-history", type: "userMessage", text: "Fix the leak" }] },
    null
  ),
  true,
  "history must not suppress pending while the new active turn id is unknown"
);
assert.equal(
  shouldShowPendingPrompt(
    "  Fix\n the   leak ",
    { id: "turn-active", items: [{ id: "user-normalized", type: "userMessage", text: "Fix the leak" }] },
    "turn-active"
  ),
  false,
  "matching uses normalized whitespace"
);
assert.equal(
  shouldShowPendingPrompt("", { id: "turn-active", items: [{ id: "user-4", type: "userMessage", text: "Hi" }] }, "turn-active"),
  false
);

console.log("thread model tests passed");
