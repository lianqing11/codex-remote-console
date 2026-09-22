export type QueueStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_review";

import type { ProviderId } from "./sessionRuntime";

export type QueuedPrompt = {
  id: string;
  provider: ProviderId;
  threadKey: string;
  threadId: string;
  text: string;
  cwd: string;
  threadParams: Record<string, unknown>;
  turnParams: Record<string, unknown>;
  status: QueueStatus;
  runId: string | null;
  attempts: number;
  lastError: string | null;
  baseTree: string | null;
  diff: {
    hasChanges?: boolean;
    diff?: string;
    [key: string]: unknown;
  } | null;
  createdAt: number;
  updatedAt: number;
};

export type QueueThreadState = {
  threadKey: string;
  paused: boolean;
  reason: string | null;
  updatedAt: number;
};

export type QueueSnapshot = {
  items: QueuedPrompt[];
  threads: QueueThreadState[];
};

export type QueueThreadSummary = {
  items: QueuedPrompt[];
  threadState: QueueThreadState | null;
  queuedCount: number;
  activeCount: number;
  attentionCount: number;
  waitingForInput: boolean;
};

const unresolvedStatuses = new Set<QueueStatus>([
  "queued",
  "dispatching",
  "running",
  "waiting_for_input",
  "failed",
  "needs_review"
]);

export function queueStatusLabel(status: QueueStatus) {
  if (status === "dispatching") return "Starting";
  if (status === "running") return "Running";
  if (status === "waiting_for_input") return "Needs input";
  if (status === "needs_review") return "Needs review";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Removed";
  if (status === "completed") return "Completed";
  return "Queued";
}

export function queueThreadSummary(snapshot: QueueSnapshot, threadKey: string): QueueThreadSummary {
  const items = snapshot.items
    .filter((item) => item.threadKey === threadKey && unresolvedStatuses.has(item.status))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const threadState = snapshot.threads.find((thread) => thread.threadKey === threadKey) || null;

  return {
    items,
    threadState,
    queuedCount: items.filter((item) => item.status === "queued").length,
    activeCount: items.filter((item) => ["dispatching", "running", "waiting_for_input"].includes(item.status)).length,
    attentionCount: items.filter((item) => ["failed", "needs_review"].includes(item.status)).length,
    waitingForInput: items.some((item) => item.status === "waiting_for_input")
  };
}

export function queueBarHasActions(summary: QueueThreadSummary) {
  return Boolean(
    summary.threadState?.paused
    || summary.queuedCount
    || summary.attentionCount
    || summary.waitingForInput
  );
}

export function queueSummariesByThread(snapshot: QueueSnapshot) {
  const threadKeys = new Set(snapshot.items.filter((item) => unresolvedStatuses.has(item.status)).map((item) => item.threadKey));
  return new Map([...threadKeys].map((threadKey) => [threadKey, queueThreadSummary(snapshot, threadKey)]));
}

const activeQueueStatuses = new Set<QueueStatus>(["dispatching", "running", "waiting_for_input"]);

export function activeQueueTurns(snapshot: QueueSnapshot) {
  const turns = new Map<string, string>();
  for (const item of snapshot.items) {
    if (activeQueueStatuses.has(item.status) && item.runId) turns.set(item.threadKey, item.runId);
  }
  return turns;
}
