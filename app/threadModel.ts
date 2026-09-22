import { isAgentProviderId, type ModeKind, type ProviderId } from "./sessionRuntime";

export type ThreadItem = {
  id: string;
  type: string;
  text?: string;
  explanation?: string;
  planEntries?: Array<{ step: string; status: string }>;
  phase?: string | null;
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  content?: unknown[];
  summary?: string[];
  changes?: unknown[];
  output?: string;
  status?: string | object;
  [key: string]: unknown;
};

export type Turn = {
  id: string;
  items: ThreadItem[];
  status: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
};

export type ThreadRuntimeMetadata = {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  mode: string | null;
};

export type TurnGroup = {
  id: string;
  itemIds: string[];
  status?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt?: number | null;
  pending?: boolean;
};

export type DisplayTurn = TurnGroup & {
  items: ThreadItem[];
};

function sameDisplayTurn(previous: DisplayTurn, next: DisplayTurn) {
  return (
    previous.pending === next.pending &&
    previous.startedAt === next.startedAt &&
    previous.completedAt === next.completedAt &&
    previous.updatedAt === next.updatedAt &&
    previous.status === next.status &&
    previous.itemIds.length === next.itemIds.length &&
    previous.itemIds.every((id, index) => id === next.itemIds[index]) &&
    previous.items.length === next.items.length &&
    previous.items.every((item, index) => item === next.items[index])
  );
}

export function reuseDisplayTurns(previous: DisplayTurn[], next: DisplayTurn[]): DisplayTurn[] {
  if (previous === next) return previous;
  if (!previous.length) return next;
  const prevById = new Map(previous.map((turn) => [turn.id, turn]));
  let reusedAll = previous.length === next.length;
  const result = next.map((turn, index) => {
    const prev = prevById.get(turn.id);
    if (!prev || !sameDisplayTurn(prev, turn)) {
      reusedAll = false;
      return turn;
    }
    if (previous[index] !== prev) reusedAll = false;
    return prev;
  });
  return reusedAll ? previous : result;
}

export type Thread = {
  id: string;
  provider?: ProviderId;
  nativeId?: string;
  version?: string | null;
  authStatus?: string | null;
  capabilities?: Partial<Record<string, boolean>>;
  mode?: ModeKind;
  runtime?: ThreadRuntimeMetadata | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  status: { type: string; activeFlags?: unknown[] };
  name: string | null;
  turns: Turn[];
  empty?: boolean;
};

export type SessionPhase = "running" | "waiting" | "failed" | "idle";
export type AssistantMessagePhase = "commentary" | "final" | "unknown";

export type TurnItemSections = {
  userItem: ThreadItem | null;
  workItems: ThreadItem[];
  finalItems: ThreadItem[];
  diffItems: ThreadItem[];
};

const runningLabels = new Set(["active", "inprogress", "running", "streaming", "working"]);
const failedLabels = new Set(["error", "failed", "failed-after-restart"]);

export function epochSeconds(timestamp: unknown) {
  if (timestamp instanceof Date) return epochSeconds(timestamp.getTime());
  if (typeof timestamp === "string") {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) return epochSeconds(numeric);
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp > 1e12 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function formatTime(timestamp: number) {
  const seconds = epochSeconds(timestamp);
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}

export function statusLabel(status: unknown) {
  if (typeof status === "string") return status;
  if (!status || typeof status !== "object" || !("type" in status)) return "unknown";
  return String((status as { type: unknown }).type);
}

export function isUserMessageItem(item: Pick<ThreadItem, "type"> & { role?: unknown }) {
  const type = String(item?.type || "").replace(/[\s_-]/g, "").toLowerCase();
  const role = String(item?.role || "").replace(/[\s_-]/g, "").toLowerCase();
  return type === "usermessage" || role === "user";
}

export function normalizePromptText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function userMessageText(item: ThreadItem) {
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text || "") : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function userItemMatchesPrompt(item: ThreadItem, prompt: string) {
  return isUserMessageItem(item) && normalizePromptText(userMessageText(item)) === normalizePromptText(prompt);
}

export function shouldShowPendingPrompt(
  pendingPrompt: string,
  latestRound: Pick<DisplayTurn, "id" | "items"> | null,
  activeTurnId: string | null
) {
  const normalized = normalizePromptText(pendingPrompt);
  if (!normalized) return false;
  if (!activeTurnId || latestRound?.id !== activeTurnId) return true;
  return !latestRound.items.some((item) => userItemMatchesPrompt(item, normalized));
}

export function isAssistantMessageItem(item: Pick<ThreadItem, "type"> & { role?: unknown }) {
  const type = String(item?.type || "").replace(/[\s_-]/g, "").toLowerCase();
  const role = String(item?.role || "").replace(/[\s_-]/g, "").toLowerCase();
  return type === "agentmessage" || role === "assistant";
}

export function assistantMessagePhase(item: Pick<ThreadItem, "type" | "phase"> & { role?: unknown }): AssistantMessagePhase {
  if (!isAssistantMessageItem(item)) return "unknown";
  const phase = String(item.phase || "").replace(/[\s_-]/g, "").toLowerCase();
  if (phase === "commentary" || phase === "progress") return "commentary";
  if (phase === "final" || phase === "finalanswer") return "final";
  return "unknown";
}

/**
 * Preserve protocol order while giving the conversation a stable visual hierarchy.
 * Codex reports commentary/final phases explicitly. Cursor and older histories do
 * not, so only a terminal turn may promote their last assistant message to final.
 * A completed Plan turn promotes its final plan payload while interrupted drafts
 * remain traceable in the Work log.
 */
export function partitionTurnItems(
  items: ThreadItem[],
  active = false,
  completed = !active
): TurnItemSections {
  const userItem = items.find(isUserMessageItem) || null;
  const diffItems: ThreadItem[] = [];
  const workItems: ThreadItem[] = [];
  const finalItems: ThreadItem[] = [];

  for (const item of items) {
    if (isUserMessageItem(item)) continue;
    if (item.type === "diff") {
      diffItems.push(item);
      continue;
    }
    if (assistantMessagePhase(item) === "final") finalItems.push(item);
    else workItems.push(item);
  }

  if (!active && finalItems.length === 0) {
    for (let index = workItems.length - 1; index >= 0; index -= 1) {
      const item = workItems[index];
      const terminalPlan = completed && item.type === "plan";
      const legacyAssistant = isAssistantMessageItem(item) && assistantMessagePhase(item) === "unknown";
      if (!terminalPlan && !legacyAssistant) continue;
      finalItems.push(item);
      workItems.splice(index, 1);
      break;
    }
  }

  return { userItem, workItems, finalItems, diffItems };
}

export function turnsHaveItems(turns?: Turn[] | null) {
  return Boolean(turns?.some((turn) => Array.isArray(turn.items) && turn.items.length > 0));
}

function normalizedStatusLabel(value: string) {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

export function sessionPhaseClaimsRunning(value: string) {
  return runningLabels.has(normalizedStatusLabel(value));
}

export function providerOf(thread: Thread | null | undefined): ProviderId {
  if (isAgentProviderId(thread?.provider)) return thread.provider;
  return providerFromThreadKey(typeof thread?.id === "string" ? thread.id : "");
}

export function providerFromThreadKey(key: string | null | undefined): ProviderId {
  const prefix = key?.split(":")[0];
  return isAgentProviderId(prefix) ? prefix : "codex";
}

export function nativeThreadId(threadOrId: Thread | string | null | undefined) {
  const id =
    typeof threadOrId === "string"
      ? threadOrId
      : String(threadOrId?.nativeId || threadOrId?.id || "");
  const delimiter = id.indexOf(":");
  return delimiter > 0 ? id.slice(delimiter + 1) : id;
}

export function threadKey(thread: Thread | string | null | undefined, provider?: ProviderId) {
  if (!thread) return "";
  const inferredProvider = typeof thread === "string" ? provider || "codex" : providerOf(thread);
  return `${inferredProvider}:${nativeThreadId(thread)}`;
}

function threadTimestamp(thread: Thread) {
  const raw = thread as Thread & { updated_at?: unknown };
  return epochSeconds(raw.updatedAt ?? raw.updated_at);
}

export function normalizeThread(thread: Thread): Thread {
  const provider = providerOf(thread);
  const nativeId = nativeThreadId(thread);
  return {
    ...thread,
    id: threadKey(nativeId, provider),
    nativeId,
    provider,
    updatedAt: threadTimestamp(thread)
  };
}

export function normalizeThreads(threads: Thread[] = []) {
  return threads.map(normalizeThread);
}

export function compareThreadsByRecency(left: Pick<Thread, "id" | "updatedAt">, right: Pick<Thread, "id" | "updatedAt">) {
  return (right.updatedAt || 0) - (left.updatedAt || 0) || left.id.localeCompare(right.id);
}

export function hydrateListedThread(prior: Thread, incoming: Thread): Thread {
  const listed = normalizeThread(prior);
  const next = normalizeThread(incoming);
  return {
    ...listed,
    ...next,
    id: listed.id,
    nativeId: listed.nativeId,
    provider: listed.provider,
    cwd: listed.cwd || next.cwd,
    preview: next.preview || listed.preview,
    name: next.name ?? listed.name,
    empty: next.turns?.length ? next.empty : listed.empty,
    updatedAt: listed.updatedAt > 0 ? listed.updatedAt : next.updatedAt
  };
}

/** Update an existing sidebar row in place. Never inserts and never reorders. */
export function patchListedThread(current: Thread[], incoming: Thread, retainKey: string) {
  if (!retainKey) return current;
  let found = false;
  const patched = current.map((thread) => {
    if (threadKey(thread) !== retainKey) return thread;
    found = true;
    return hydrateListedThread(thread, incoming);
  });
  return found ? patched : current;
}

/** Merge thread records. Full list loads sort by recency; existing rows keep their place. */
export function mergeThreadsById(current: Thread[], incoming: Thread[]) {
  const incomingNormalized = incoming.map(normalizeThread);
  if (!current.length) return incomingNormalized.sort(compareThreadsByRecency);

  const previous = new Map(current.map((thread) => {
    const normalized = normalizeThread(thread);
    return [threadKey(normalized), normalized] as const;
  }));
  const incomingByKey = new Map(incomingNormalized.map((thread) => [threadKey(thread), thread] as const));
  const seen = new Set<string>();
  const merged: Thread[] = [];

  for (const thread of incomingNormalized) {
    const key = threadKey(thread);
    if (previous.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push(thread);
  }
  for (const thread of current) {
    const prior = normalizeThread(thread);
    const key = threadKey(prior);
    if (seen.has(key)) continue;
    seen.add(key);
    const next = incomingByKey.get(key);
    merged.push(next ? hydrateListedThread(prior, next) : prior);
  }
  return merged;
}

export function threadTitle(thread: Thread | null) {
  if (!thread) return "No session selected";
  return thread.name || thread.preview || "New session";
}

export function activeTurnIdFromTurns(turns: Turn[] = []) {
  return [...turns].reverse().find((turn) => sessionPhaseClaimsRunning(statusLabel(turn.status)))?.id || null;
}

export function deriveSessionPhase(
  thread: Pick<Thread, "id" | "status"> | null | undefined,
  activeTurns: Record<string, string> = {},
  waitingIds: Set<string> = new Set(),
  queue?: { waiting?: boolean } | null
): SessionPhase {
  if (!thread) return "idle";
  const key = threadKey(thread as Thread);
  if (queue?.waiting || waitingIds.has(key) || waitingIds.has(thread.id)) return "waiting";
  if (activeTurns[key] || sessionPhaseClaimsRunning(statusLabel(thread.status))) return "running";
  if (failedLabels.has(normalizedStatusLabel(statusLabel(thread.status)))) return "failed";
  return "idle";
}

export function threadIsActive(
  thread: Pick<Thread, "id" | "status">,
  activeTurns: Record<string, string> = {}
) {
  return deriveSessionPhase(thread, activeTurns) === "running";
}

export function threadStatusText(kind: SessionPhase) {
  if (kind === "running") return "Running";
  if (kind === "waiting") return "Needs input";
  if (kind === "failed") return "Failed";
  return "Idle";
}

export function uniqueAppend<T>(items: T[], item: T) {
  return items.includes(item) ? items : [...items, item];
}

export function uniqueItems<T>(items: T[]) {
  return [...new Set(items)];
}
