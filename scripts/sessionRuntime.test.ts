import assert from "node:assert/strict";
import {
  buildCollaborationMode,
  cursorEventToNotification,
  streamEventToNotification,
  cursorTranscriptToTurns,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CURSOR_MODEL,
  defaultRuntimeSettings,
  fastModeLabel,
  isFastServiceTier,
  mergeThreadRuntimeSettings,
  providerRuntimeDefaults,
  restoreProviderRuntimeSettings,
  sessionModeForThread,
  runtimeStorageKey,
  runtimeThreadParams,
  runtimeTurnParams
} from "../app/sessionRuntime";
import { normalizeAgentThread } from "../app/cursorAdapter";

assert.equal(defaultRuntimeSettings.provider, "codex");
assert.equal(defaultRuntimeSettings.reasoningEffort, "xhigh");
assert.deepEqual(runtimeTurnParams(defaultRuntimeSettings), { effort: "xhigh" });

const presets = [
  { name: "Default", mode: "default" as const, reasoning_effort: "medium" as const },
  { name: "Plan", mode: "plan" as const, reasoning_effort: "medium" as const }
];
const configuredSettings = { ...defaultRuntimeSettings, model: "gpt-test" };
assert.equal(
  buildCollaborationMode(configuredSettings, presets, undefined, "default")?.settings.reasoning_effort,
  "xhigh"
);
assert.equal(
  buildCollaborationMode(configuredSettings, presets, undefined, "plan")?.settings.reasoning_effort,
  "xhigh"
);

const resumed = mergeThreadRuntimeSettings(defaultRuntimeSettings, {
  model: "gpt-test",
  reasoningEffort: "medium",
  sandboxMode: "read-only"
});
assert.equal(resumed.model, "gpt-test");
assert.equal(resumed.reasoningEffort, "xhigh");
assert.equal(resumed.sandboxMode, "read-only");

const explicitMedium = { ...defaultRuntimeSettings, reasoningEffort: "medium" as const };
assert.equal(mergeThreadRuntimeSettings(explicitMedium, { reasoningEffort: "xhigh" }).reasoningEffort, "medium");
assert.deepEqual(runtimeTurnParams(explicitMedium), { effort: "medium" });
assert.equal(
  buildCollaborationMode(
    { ...explicitMedium, model: "gpt-test" },
    [{ mode: "default", reasoning_effort: "xhigh" }]
  )?.settings.reasoning_effort,
  "medium"
);

const cursorDefaults = providerRuntimeDefaults("cursor");
assert.equal(cursorDefaults.provider, "cursor");
assert.equal(cursorDefaults.model, DEFAULT_CURSOR_MODEL);
assert.equal(cursorDefaults.mode, "default");
assert.equal(cursorDefaults.reasoningEffort, null);
assert.equal(cursorDefaults.serviceTier, null);
assert.deepEqual(runtimeThreadParams(cursorDefaults), {
  model: DEFAULT_CURSOR_MODEL,
  mode: "agent"
});
assert.deepEqual(runtimeTurnParams({ ...cursorDefaults, mode: "ask" }), {
  model: DEFAULT_CURSOR_MODEL,
  mode: "ask"
});
assert.equal(runtimeStorageKey("codex"), "codex.runtime");
assert.equal(runtimeStorageKey("cursor"), "cursor.runtime");
const claudeDefaults = providerRuntimeDefaults("claude");
assert.equal(claudeDefaults.provider, "claude");
assert.equal(claudeDefaults.model, DEFAULT_CLAUDE_MODEL);
assert.deepEqual(runtimeTurnParams(claudeDefaults), {
  model: DEFAULT_CLAUDE_MODEL,
  mode: "agent",
  effort: "high"
});
assert.deepEqual(runtimeTurnParams({ ...claudeDefaults, mode: "plan" }), {
  model: DEFAULT_CLAUDE_MODEL,
  mode: "plan",
  effort: "high"
});
assert.equal(streamEventToNotification({
  type: "agent:event",
  provider: "claude",
  sessionId: "c1",
  runId: "r1",
  event: "assistant_text",
  text: "hi"
}, "claude")?.params.provider, "claude");
assert.equal((streamEventToNotification({
  type: "agent:event",
  provider: "claude",
  sessionId: "c1",
  runId: "r1",
  event: "assistant_text",
  text: "pong",
  delta: true
}, "claude")?.params as { delta?: string }).delta, "pong");
assert.equal(streamEventToNotification({
  type: "agent:event",
  provider: "claude",
  sessionId: "c1",
  runId: "r1",
  event: "rate_limits",
  result: { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 20 } } }
}, "claude")?.method, "account/rateLimits/updated");
assert.equal(restoreProviderRuntimeSettings("cursor", { model: "auto" }).model, DEFAULT_CURSOR_MODEL);
assert.equal(restoreProviderRuntimeSettings("cursor", {}).model, DEFAULT_CURSOR_MODEL);
assert.equal(restoreProviderRuntimeSettings("cursor", { model: "cursor-custom" }).model, "cursor-custom");
assert.equal(sessionModeForThread({ mode: "plan" }), "plan");
assert.equal(sessionModeForThread({ mode: "agent" }), "default");
assert.equal(sessionModeForThread({ runtime: { mode: "plan" } }), "plan");
assert.equal(sessionModeForThread({ runtime: { mode: null } }, "ask"), "ask");
assert.equal(
  mergeThreadRuntimeSettings(defaultRuntimeSettings, { thread: { runtime: { mode: "plan" } } }).mode,
  "plan"
);
assert.equal(isFastServiceTier("priority"), true);
assert.equal(isFastServiceTier("fast"), true);
assert.equal(isFastServiceTier("default"), false);
assert.equal(isFastServiceTier("flex"), false);
assert.equal(isFastServiceTier(null), false);
assert.equal(fastModeLabel("priority"), "Fast");
assert.equal(fastModeLabel("default"), "Standard");

const cursorTurns = cursorTranscriptToTurns([
  { id: "u1", runId: "run-1", type: "user", text: "inspect repo", createdAt: 10 },
  { id: "a1", runId: "run-1", type: "assistant_text", text: "I found " },
  { id: "a2", runId: "run-1", type: "assistant_text", text: "the issue." },
  { id: "s1", runId: "run-1", type: "status", status: "completed" },
  { runId: "run-1", type: "tool_started", toolCallId: "t1", name: "shell", status: "started" },
  { runId: "run-1", type: "tool_completed", toolCallId: "t1", name: "shell", output: "ok", status: "completed" },
  { id: "a3", runId: "run-2", type: "assistant", text: "Second run" }
]);
assert.equal(cursorTurns.length, 2);
assert.equal(cursorTurns[0].id, "run-1");
assert.deepEqual(
  cursorTurns[0].items.map((item: any) => item.type),
  ["userMessage", "agentMessage", "toolCall"]
);
assert.equal(cursorTurns[0].items[0].content[0].text, "inspect repo");
assert.equal(cursorTurns[0].items[1].text, "I found the issue.");
assert.equal(cursorTurns[0].items.filter((item: any) => item.type === "toolCall").length, 1);
assert.equal(cursorTurns[0].items[2].status, "completed");
assert.equal(cursorTurns[0].items[2].output, "ok");
assert.equal(cursorTurns[1].items[0].text, "Second run");

assert.deepEqual(
  cursorEventToNotification({
    type: "agent:event",
    provider: "cursor",
    sessionId: "chat-1",
    runId: "run-1",
    event: "assistant_text",
    text: "live delta"
  }),
  {
    method: "item/agentMessage/delta",
    params: {
      provider: "cursor",
      threadId: "chat-1",
      turnId: "run-1",
      itemId: "run-1-assistant",
      delta: "live delta"
    }
  }
);
const failedEvent = cursorEventToNotification({
  type: "agent:event",
  provider: "cursor",
  sessionId: "chat-1",
  runId: "run-1",
  event: "status",
  status: "failed"
});
assert.equal(failedEvent?.method, "turn/completed");
assert.equal((failedEvent?.params as any).turn.status, "failed");
const toolEvent = cursorEventToNotification({
  type: "agent:event",
  provider: "cursor",
  sessionId: "chat-1",
  runId: "run-1",
  event: "tool_completed",
  toolName: "Glob",
  toolCallId: "call-1",
  summary: "2 files"
});
assert.equal(toolEvent?.method, "item/completed");
assert.equal((toolEvent?.params as any).item.tool, "Glob");
assert.equal((toolEvent?.params as any).item.status, "completed");

const eventTurns = cursorTranscriptToTurns([
  { event: "user_text", text: "from event", runId: "r1" },
  { event: "assistant_text", text: "reply", runId: "r1" }
]);
assert.equal(eventTurns[0].items[0].type, "userMessage");
assert.equal(eventTurns[0].items[0].content[0].text, "from event");

const orphanedTurns = cursorTranscriptToTurns([
  { event: "user_text", text: "stuck", runId: "r-stuck" },
  { event: "status", status: "running", runId: "r-stuck" },
  { event: "tool_started", toolName: "Await", runId: "r-stuck" }
], "cursor-run", "failed-after-restart");
assert.equal(orphanedTurns[0].status, "failed-after-restart");

const adapted = normalizeAgentThread({
  thread: { id: "s1", cwd: "/tmp", title: "Work", turns: [{ id: "r1", userMessage: "hi", agentMessage: "yo", toolCall: [] }] },
  transcript: [
    { event: "user_text", text: "hi", runId: "r1" },
    { event: "assistant_text", text: "yo", runId: "r1" }
  ]
}, "cursor");
assert.ok(adapted);
assert.equal(adapted!.turns[0].items[0].type, "userMessage");
assert.equal(adapted!.turns[0].items[1].type, "agentMessage");

console.log("session runtime settings tests passed");
