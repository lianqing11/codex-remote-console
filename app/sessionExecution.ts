import type { QueueThreadSummary, QueuedPrompt } from "./queueModel";
import {
  normalizeModeKind,
  sessionModeForThread,
  type ModeKind,
  type ProviderId
} from "./sessionRuntime";
import {
  sessionPhaseClaimsRunning,
  statusLabel,
  threadKey,
  type SessionPhase,
  type Thread
} from "./threadModel";

export type SessionExecutionState = {
  threadKey: string;
  provider: ProviderId;
  mode: ModeKind;
  phase: SessionPhase;
  activeTurnId: string | null;
  planPayload: string;
  planPayloadReady: boolean;
  hasThread: boolean;
};

export type DeriveSessionExecutionStateInput = {
  thread: Thread | null;
  provider: ProviderId;
  providerDefaultMode: ModeKind;
  modeOverride?: ModeKind | null;
  activeTurnId?: string | null;
  queueSummary: QueueThreadSummary;
  waitingForInput?: boolean;
  planPayload?: string;
};

const activeQueueStatuses = new Set(["dispatching", "running", "waiting_for_input"]);
const failedStatuses = new Set(["error", "failed", "failed-after-restart"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function queuedPromptMode(item: QueuedPrompt | null | undefined): ModeKind | null {
  if (!item) return null;
  const collaborationMode = record(item.turnParams?.collaborationMode);
  return normalizeModeKind(item.turnParams?.mode)
    || normalizeModeKind(collaborationMode?.mode)
    || normalizeModeKind(item.threadParams?.mode);
}

export function activeQueuePrompt(summary: QueueThreadSummary) {
  return summary.items.find((item) => activeQueueStatuses.has(item.status)) || null;
}

function normalizedStatus(value: unknown) {
  return statusLabel(value).replace(/[\s_-]+/g, "").toLowerCase();
}

export function deriveSessionExecutionState({
  thread,
  provider,
  providerDefaultMode,
  modeOverride = null,
  activeTurnId = null,
  queueSummary,
  waitingForInput = false,
  planPayload = ""
}: DeriveSessionExecutionStateInput): SessionExecutionState {
  const key = thread ? threadKey(thread) : "";
  const queuePrompt = activeQueuePrompt(queueSummary);
  const queueMode = queuedPromptMode(queuePrompt);
  const serverMode = thread
    ? sessionModeForThread(thread, "default")
    : providerDefaultMode;
  const waiting = waitingForInput || queueSummary.waitingForInput;
  const running = Boolean(
    activeTurnId
    || queuePrompt
    || (thread && sessionPhaseClaimsRunning(statusLabel(thread.status)))
  );
  const phase: SessionPhase = waiting
    ? "waiting"
    : running
      ? "running"
      : thread && failedStatuses.has(normalizedStatus(thread.status))
        ? "failed"
        : "idle";
  const lockedMode = queueMode || serverMode;
  const mode = phase === "running" || phase === "waiting"
    ? lockedMode
    : modeOverride || serverMode;
  const payload = planPayload.trim();

  return {
    threadKey: key,
    provider,
    mode,
    phase,
    activeTurnId,
    planPayload: payload,
    planPayloadReady: Boolean(payload),
    hasThread: Boolean(thread)
  };
}
