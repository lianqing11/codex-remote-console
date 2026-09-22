import type { GitDiffResult } from "./gitDiff";
import type { AgentProviderId } from "./types";

export type AgentQueueStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_review";

export type AgentQueueItem = {
  id: string;
  provider: AgentProviderId;
  threadKey: string;
  threadId: string;
  text: string;
  cwd: string;
  threadParams: Record<string, unknown>;
  turnParams: Record<string, unknown>;
  status: AgentQueueStatus;
  runId: string | null;
  attempts: number;
  lastError: string | null;
  baseTree: string | null;
  diff: GitDiffResult | null;
  createdAt: number;
  updatedAt: number;
};

export type AgentQueueThreadState = {
  threadKey: string;
  paused: boolean;
  reason: string | null;
  updatedAt: number;
};

export type AgentQueueSnapshot = {
  items: AgentQueueItem[];
  threads: AgentQueueThreadState[];
};

export type AgentQueueEnqueueInput = Pick<
  AgentQueueItem,
  "id" | "provider" | "threadKey" | "threadId" | "text" | "cwd" | "threadParams" | "turnParams" | "createdAt"
>;
