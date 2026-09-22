import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnPanel } from "../app/conversationViews";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function renderTurn({ active = false, items, status }: { active?: boolean; items: any[]; status: string }) {
  return renderToStaticMarkup(React.createElement(TurnPanel, {
    active,
    defaultOpen: true,
    diagnostic: null,
    provider: "codex",
    turn: {
      id: `turn-${status}`,
      items,
      status: { type: status },
      startedAt: 1,
      completedAt: active ? 0 : 2,
      updatedAt: 2
    } as any
  }));
}

function workLogTag(markup: string) {
  const tag = markup.match(/<details class="turnWorkLog[^"]*"[^>]*>/)?.[0] || "";
  assert.ok(tag, "Turn Work log should be rendered");
  return tag;
}

const completedPlan = renderTurn({
  status: "completed",
  items: [
    { id: "user", type: "userMessage", text: "Plan this" },
    { id: "commentary", type: "agentMessage", phase: "commentary", text: "Inspecting" },
    { id: "reasoning", type: "reasoning", text: "Comparing" },
    { id: "plan", type: "plan", text: "# Two-step plan" }
  ]
});
assert.match(completedPlan, /aria-label="Plan result"/);
assert.match(completedPlan, /class="message plan finalAnswerMessage/);
assert.match(completedPlan, /Plan<\/span><small>Codex<\/small>/);
assert.doesNotMatch(workLogTag(completedPlan), /\sopen(?:=|>)/);
assert.doesNotMatch(completedPlan, /turnWorkLogBody/);

const activePlan = renderTurn({
  active: true,
  status: "inProgress",
  items: [
    { id: "active-commentary", type: "agentMessage", phase: "commentary", text: "Planning" },
    { id: "active-plan", type: "plan", text: "Draft plan" }
  ]
});
assert.doesNotMatch(activePlan, /aria-label="Plan result"/);
assert.match(workLogTag(activePlan), /\sopen=""/);
assert.match(activePlan, /turnWorkLogBody/);
assert.match(activePlan, /Draft plan/);

const interruptedPlan = renderTurn({
  status: "interrupted",
  items: [
    { id: "interrupted-commentary", type: "agentMessage", phase: "commentary", text: "Planning" },
    { id: "interrupted-plan", type: "plan", text: "Partial plan" }
  ]
});
assert.doesNotMatch(interruptedPlan, /aria-label="Plan result"/);
assert.match(workLogTag(interruptedPlan), /\sopen=""/);
assert.match(interruptedPlan, /Partial plan/);

const completedAgent = renderTurn({
  status: "completed",
  items: [
    { id: "agent-commentary", type: "agentMessage", phase: "commentary", text: "Working" },
    { id: "agent-final", type: "agentMessage", phase: "final_answer", text: "Done" }
  ]
});
assert.match(completedAgent, /aria-label="Final answer"/);
assert.match(completedAgent, /<span><svg[^>]*>[\s\S]*?<\/svg>Final answer<\/span>/);
assert.doesNotMatch(workLogTag(completedAgent), /\sopen(?:=|>)/);

console.log("Plan Work log rendering tests passed");
