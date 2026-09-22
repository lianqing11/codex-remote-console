import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionExecutionControl } from "../app/ExecutionModeSwitch";
import { deriveSessionExecutionState } from "../app/sessionExecution";
import type { QueueThreadSummary, QueuedPrompt } from "../app/queueModel";
import type { ModeKind } from "../app/sessionRuntime";
import type { Thread } from "../app/threadModel";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function queueSummary(items: QueuedPrompt[] = []): QueueThreadSummary {
  return {
    items,
    threadState: null,
    queuedCount: items.filter((item) => item.status === "queued").length,
    activeCount: items.filter((item) => ["dispatching", "running", "waiting_for_input"].includes(item.status)).length,
    attentionCount: 0,
    waitingForInput: items.some((item) => item.status === "waiting_for_input")
  };
}

function thread(id: string, mode: ModeKind, status = "idle"): Thread {
  return {
    id: `codex:${id}`,
    nativeId: id,
    provider: "codex",
    mode,
    runtime: { model: "gpt-test", reasoningEffort: "medium", serviceTier: null, mode },
    preview: id,
    cwd: "/tmp",
    updatedAt: 1,
    status: { type: status },
    name: id,
    turns: []
  };
}

function derive(target: Thread, modeOverride?: ModeKind | null) {
  return deriveSessionExecutionState({
    thread: target,
    provider: "codex",
    providerDefaultMode: "default",
    modeOverride,
    activeTurnId: null,
    queueSummary: queueSummary(),
    planPayload: target.mode === "plan" ? "1. Implement\n2. Verify" : ""
  });
}

const planSession = thread("plan-session", "plan");
const agentSession = thread("agent-session", "default");
assert.equal(derive(planSession).mode, "plan");
assert.equal(derive(agentSession).mode, "default");
assert.equal(derive(planSession, "default").mode, "default");
assert.equal(derive(agentSession).mode, "default", "one session override must not leak into another session");

const runningPlan = deriveSessionExecutionState({
  thread: thread("running-plan", "plan", "running"),
  provider: "codex",
  providerDefaultMode: "default",
  modeOverride: "default",
  activeTurnId: "turn-plan",
  queueSummary: queueSummary(),
  planPayload: "Draft plan"
});
assert.equal(runningPlan.mode, "plan", "the active Session mode is authoritative over an idle local selection");
assert.equal(runningPlan.phase, "running");

const queueItem: QueuedPrompt = {
  id: "queue-plan",
  provider: "codex",
  threadKey: "codex:queue-session",
  threadId: "queue-session",
  text: "Plan this",
  cwd: "/tmp",
  threadParams: {},
  turnParams: { collaborationMode: { mode: "plan" } },
  status: "running",
  runId: "run-plan",
  attempts: 1,
  lastError: null,
  baseTree: null,
  diff: null,
  createdAt: 1,
  updatedAt: 2
};
const queueDriven = deriveSessionExecutionState({
  thread: thread("queue-session", "default", "idle"),
  provider: "codex",
  providerDefaultMode: "default",
  modeOverride: "default",
  activeTurnId: "run-plan",
  queueSummary: queueSummary([queueItem])
});
assert.equal(queueDriven.mode, "plan", "the active queue turn is authoritative over an idle local selection");
assert.equal(queueDriven.phase, "running");

function render(state = runningPlan, supportsAsk = false) {
  return renderToStaticMarkup(React.createElement(SessionExecutionControl, {
    disabled: false,
    state,
    supportsAsk,
    transitioning: false,
    onChange: () => undefined,
    onExecutePlan: () => undefined
  }));
}

const activePlanMarkup = render({ ...runningPlan, mode: "plan" });
assert.match(activePlanMarkup, /sessionExecutionControl/);
assert.match(activePlanMarkup, /Plan/);
assert.match(activePlanMarkup, /Running/);
assert.match(activePlanMarkup, /Stop planning &amp; execute/);
assert.doesNotMatch(activePlanMarkup, /aria-pressed/, "active Plan must not render Agent or Plan mode buttons");

const waitingPlanMarkup = render({ ...runningPlan, mode: "plan", planPayload: "", planPayloadReady: false });
assert.match(waitingPlanMarkup, /Waiting for plan…/);
assert.match(waitingPlanMarkup, /disabled/);

const idlePlanMarkup = render(derive(planSession));
assert.match(idlePlanMarkup, /aria-pressed="true"/);
assert.match(idlePlanMarkup, /data-mode="plan"/);
assert.match(idlePlanMarkup, /Execute plan/);
assert.equal((idlePlanMarkup.match(/sessionExecutionControl/g) || []).length, 1);

const cursorThreeModeMarkup = render({ ...derive(planSession), provider: "cursor" }, true);
assert.match(cursorThreeModeMarkup, /data-mode-count="3"/);
assert.equal((cursorThreeModeMarkup.match(/data-mode="/g) || []).length, 3);
assert.match(cursorThreeModeMarkup, />Ask</);

const activeAgentMarkup = render({ ...runningPlan, mode: "default", planPayload: "", planPayloadReady: false });
assert.match(activeAgentMarkup, /Agent/);
assert.doesNotMatch(activeAgentMarkup, />Plan</);
assert.doesNotMatch(activeAgentMarkup, /aria-pressed/);

console.log("session execution state and shared control tests passed");
