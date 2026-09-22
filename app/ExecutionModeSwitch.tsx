"use client";

import { Bot, ListChecks, LoaderCircle, MessageCircleQuestion, Play } from "lucide-react";
import type { SessionExecutionState } from "./sessionExecution";
import { modeLabel, type ModeKind } from "./sessionRuntime";

const modeOptions: ModeKind[] = ["default", "plan", "ask"];

const modeIcons = {
  default: Bot,
  plan: ListChecks,
  ask: MessageCircleQuestion
} satisfies Record<ModeKind, typeof Bot>;

function phaseLabel(state: SessionExecutionState) {
  if (state.phase === "waiting") return "Needs input";
  if (state.phase === "running") return "Running";
  if (state.phase === "failed") return "Failed";
  if (state.mode === "plan" && state.planPayloadReady) return "Ready";
  return "Idle";
}

export function SessionExecutionControl({
  disabled,
  state,
  supportsAsk,
  transitioning,
  onChange,
  onExecutePlan
}: {
  disabled: boolean;
  state: SessionExecutionState;
  supportsAsk: boolean;
  transitioning: boolean;
  onChange: (mode: ModeKind) => Promise<void> | void;
  onExecutePlan: () => Promise<void> | void;
}) {
  const locked = state.phase === "running" || state.phase === "waiting";
  const modes = supportsAsk ? modeOptions : modeOptions.slice(0, 2);
  const showActivePlanAction = state.mode === "plan" && state.phase === "running";
  const showReadyPlanAction = state.mode === "plan" && state.phase === "idle" && state.hasThread && state.planPayloadReady;
  const showPlanAction = showActivePlanAction || showReadyPlanAction;
  const planActionLabel = transitioning
    ? "Starting Agent…"
    : showActivePlanAction
      ? state.planPayloadReady ? "Stop planning & execute" : "Waiting for plan…"
      : "Execute plan";

  return (
    <section
      aria-label="Session execution"
      className={`sessionExecutionControl phase-${state.phase}`}
      data-execution-mode={state.mode}
      data-execution-phase={state.phase}
      data-session-key={state.threadKey}
    >
      <div className="sessionExecutionMode">
        <span className="sessionExecutionLabel">Session mode</span>
        {locked ? (
          <div className="sessionRunStatus" role="status" aria-live="polite">
            {state.phase === "running" ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={15} /> : null}
            <strong>{modeLabel(state.mode)}</strong>
            <span aria-hidden="true">·</span>
            <small>{phaseLabel(state)}</small>
          </div>
        ) : (
          <div
            aria-label="Session mode"
            className="sessionModeSwitch"
            data-mode-count={modes.length}
            role="group"
          >
            {modes.map((option) => {
              const ModeIcon = modeIcons[option];
              return (
                <button
                  aria-pressed={state.mode === option}
                  className={state.mode === option ? "active" : ""}
                  data-mode={option}
                  disabled={disabled || transitioning}
                  key={option}
                  type="button"
                  onClick={() => void onChange(option)}
                >
                  <ModeIcon aria-hidden="true" size={15} strokeWidth={1.9} />
                  <span>{modeLabel(option)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {showPlanAction ? (
        <button
          className="sessionPlanAction"
          disabled={disabled || transitioning || !state.planPayloadReady}
          type="button"
          onClick={() => void onExecutePlan()}
        >
          {transitioning ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={16} /> : <Play aria-hidden="true" size={16} />}
          {planActionLabel}
        </button>
      ) : null}
    </section>
  );
}
