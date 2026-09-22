import { useSyncExternalStore } from "react";
import { assistantMessagePhase, uniqueAppend, uniqueItems, userItemMatchesPrompt, type ThreadItem, type Turn, type TurnGroup } from "./threadModel";

export const EMPTY_ITEMS: Record<string, ThreadItem> = Object.freeze({}) as Record<string, ThreadItem>;
export const EMPTY_TURNS: Record<string, TurnGroup> = Object.freeze({}) as Record<string, TurnGroup>;
export const EMPTY_ORDER: string[] = Object.freeze([]) as unknown as string[];

export type ThreadViewState = {
  itemsByThread: Record<string, Record<string, ThreadItem>>;
  itemOrderByThread: Record<string, string[]>;
  turnsByThread: Record<string, Record<string, TurnGroup>>;
  turnOrderByThread: Record<string, string[]>;
  pendingPromptByThread: Record<string, string>;
};

let state: ThreadViewState = {
  itemsByThread: {},
  itemOrderByThread: {},
  turnsByThread: {},
  turnOrderByThread: {},
  pendingPromptByThread: {}
};

const listeners = new Set<() => void>();
const threadListeners = new Map<string, Set<() => void>>();

function emitAll() {
  for (const listener of listeners) listener();
  for (const set of threadListeners.values()) {
    for (const listener of set) listener();
  }
}

function emitThread(threadId: string) {
  const set = threadListeners.get(threadId);
  if (set) for (const listener of set) listener();
}

export function getThreadViewState() {
  return state;
}

export function subscribeThreadView(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeThreadViewFor(threadId: string, listener: () => void) {
  let set = threadListeners.get(threadId);
  if (!set) {
    set = new Set();
    threadListeners.set(threadId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) threadListeners.delete(threadId);
  };
}

function updateField<K extends keyof ThreadViewState>(field: K, next: ThreadViewState[K], threadId?: string) {
  if (state[field] === next) return;
  state = { ...state, [field]: next };
  if (threadId) emitThread(threadId);
  else emitAll();
}

function updateThreadBucket<T>(
  field: "itemsByThread" | "itemOrderByThread" | "turnsByThread" | "turnOrderByThread" | "pendingPromptByThread",
  threadId: string,
  empty: T,
  updater: T | ((current: T) => T)
) {
  if (!threadId) return;
  const current = state[field] as Record<string, T>;
  const old = (current[threadId] as T | undefined) || empty;
  const next = typeof updater === "function" ? (updater as (current: T) => T)(old) : updater;
  if (next === old) return;
  updateField(field, { ...current, [threadId]: next } as ThreadViewState[typeof field], threadId);
}

export function setItemsForThread(
  threadId: string,
  updater: Record<string, ThreadItem> | ((current: Record<string, ThreadItem>) => Record<string, ThreadItem>)
) {
  updateThreadBucket("itemsByThread", threadId, EMPTY_ITEMS, updater);
}

export function setItemOrderForThread(threadId: string, updater: string[] | ((current: string[]) => string[])) {
  updateThreadBucket("itemOrderByThread", threadId, EMPTY_ORDER, updater);
}

export function setTurnsForThread(
  threadId: string,
  updater: Record<string, TurnGroup> | ((current: Record<string, TurnGroup>) => Record<string, TurnGroup>)
) {
  updateThreadBucket("turnsByThread", threadId, EMPTY_TURNS, updater);
}

export function setTurnOrderForThread(threadId: string, updater: string[] | ((current: string[]) => string[])) {
  updateThreadBucket("turnOrderByThread", threadId, EMPTY_ORDER, updater);
}

export function setPendingPromptForThread(threadId: string, value: string) {
  updateThreadBucket("pendingPromptByThread", threadId, "", (current) => (current === value ? current : value));
}

export function clearPendingPrompt(threadId: string) {
  const current = state.pendingPromptByThread;
  if (!(threadId in current)) return;
  const next = { ...current };
  delete next[threadId];
  updateField("pendingPromptByThread", next, threadId);
}

export function threadHasLandedUserPrompt(threadId: string, text: string, turnId: string | null) {
  if (!threadId || !text || !turnId) return false;
  const items = state.itemsByThread[threadId] || EMPTY_ITEMS;
  const itemIds = state.turnsByThread[threadId]?.[turnId]?.itemIds || EMPTY_ORDER;
  return itemIds.some((itemId) => {
    const item = items[itemId];
    return Boolean(item && userItemMatchesPrompt(item, text));
  });
}

export function shouldRestoreQueuePendingPrompt(queueStatus: string, hasLandedUserPrompt: boolean) {
  return queueStatus === "queued" && !hasLandedUserPrompt;
}

export function reconcileQueuePendingPrompt(
  threadId: string,
  item: { text: string; status: string; runId: string | null } | null
) {
  if (!item) {
    clearPendingPrompt(threadId);
    return "cleared" as const;
  }
  const landed = threadHasLandedUserPrompt(threadId, item.text, item.runId);
  if (landed) {
    clearPendingPrompt(threadId);
    return "cleared" as const;
  }
  if (shouldRestoreQueuePendingPrompt(item.status, landed)) {
    setPendingPromptForThread(threadId, item.text);
    return "restored" as const;
  }
  return "unchanged" as const;
}

export function discardThreadView(threadId: string) {
  if (!threadId) return;
  let changed = false;
  const next = { ...state };
  for (const field of ["itemsByThread", "itemOrderByThread", "turnsByThread", "turnOrderByThread", "pendingPromptByThread"] as const) {
    if (!(threadId in next[field])) continue;
    const bucket = { ...next[field] };
    delete bucket[threadId];
    next[field] = bucket as never;
    changed = true;
  }
  if (!changed) return;
  state = next;
  transcriptCache.delete(threadId);
  emitThread(threadId);
}

export function applyItemsFromTurns(threadId: string, turns: Turn[]) {
  const currentItems = state.itemsByThread[threadId] || EMPTY_ITEMS;
  const currentTurns = state.turnsByThread[threadId] || EMPTY_TURNS;
  const currentTurnOrder = state.turnOrderByThread[threadId] || EMPTY_ORDER;
  const nextItems: Record<string, ThreadItem> = {};
  const nextItemOrder: string[] = [];
  const nextTurns: Record<string, TurnGroup> = {};
  const nextTurnOrder: string[] = [];

  function appendPreservedDiffs(turnId: string, itemIds: string[]) {
    for (const itemId of currentTurns[turnId]?.itemIds || []) {
      const item = currentItems[itemId];
      if (!item || item.type !== "diff" || nextItems[itemId]) continue;
      nextItems[itemId] = item;
      nextItemOrder.push(itemId);
      itemIds.push(itemId);
    }
  }

  for (const turn of turns) {
    const itemIds: string[] = [];
    for (const item of turn.items || []) {
      nextItems[item.id] = item;
      nextItemOrder.push(item.id);
      itemIds.push(item.id);
    }
    appendPreservedDiffs(turn.id, itemIds);
    nextTurns[turn.id] = {
      id: turn.id,
      itemIds: uniqueItems(itemIds),
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      updatedAt: turn.completedAt || turn.startedAt || null
    };
    nextTurnOrder.push(turn.id);
  }

  // Queue-backed turn diffs can arrive before the session history. Keep those
  // local synthetic items while replacing the rest with authoritative turns.
  for (const turnId of currentTurnOrder) {
    if (nextTurns[turnId]) continue;
    const itemIds: string[] = [];
    appendPreservedDiffs(turnId, itemIds);
    if (!itemIds.length) continue;
    nextTurns[turnId] = { ...currentTurns[turnId], id: turnId, itemIds };
    nextTurnOrder.push(turnId);
  }

  setItemsForThread(threadId, (current) => reuseUnchanged(current, nextItems));
  setItemOrderForThread(threadId, (current) => (sameIds(current, nextItemOrder) ? current : nextItemOrder));
  setTurnsForThread(threadId, (current) => reuseUnchanged(current, nextTurns));
  setTurnOrderForThread(threadId, (current) => (sameIds(current, nextTurnOrder) ? current : nextTurnOrder));
}

export function threadViewHasConversationHistory(threadId: string) {
  const items = state.itemsByThread[threadId] || EMPTY_ITEMS;
  const order = state.itemOrderByThread[threadId] || EMPTY_ORDER;
  return order.some((itemId) => {
    const item = items[itemId];
    return Boolean(item && item.type !== "diff");
  });
}

export function registerTurnItem(threadId: string, turnId: string | undefined, itemId: string) {
  if (!turnId) return;
  setTurnsForThread(threadId, (current) => {
    const turn = current[turnId] || { id: turnId, itemIds: [] };
    if (turn.itemIds.includes(itemId)) return current;
    return { ...current, [turnId]: { ...turn, itemIds: uniqueAppend(turn.itemIds, itemId) } };
  });
  setTurnOrderForThread(threadId, (current) => uniqueAppend(current, turnId));
}

export function reuseUnchanged<T>(current: Record<string, T>, incoming: Record<string, T>) {
  const keys = Object.keys(incoming);
  let changed = keys.length !== Object.keys(current).length;
  const next: Record<string, T> = {};
  for (const key of keys) {
    const previous = current[key];
    if (previous !== undefined && shallowSame(previous, incoming[key])) next[key] = previous;
    else {
      next[key] = incoming[key];
      changed = true;
    }
  }
  return changed ? next : current;
}

function sameIds(current: string[], next: string[]) {
  return current.length === next.length && current.every((id, index) => id === next[index]);
}

function shallowSame(left: unknown, right: unknown) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return left === right;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every((key) => leftRecord[key] === rightRecord[key]);
}

type TranscriptSnap = {
  items: Record<string, ThreadItem>;
  itemOrder: string[];
  turnsById: Record<string, TurnGroup>;
  turnOrder: string[];
  pendingPrompt: string;
};

const transcriptCache = new Map<string, TranscriptSnap>();

function readTranscript(threadKey: string): TranscriptSnap {
  const next: TranscriptSnap = {
    items: state.itemsByThread[threadKey] || EMPTY_ITEMS,
    itemOrder: state.itemOrderByThread[threadKey] || EMPTY_ORDER,
    turnsById: state.turnsByThread[threadKey] || EMPTY_TURNS,
    turnOrder: state.turnOrderByThread[threadKey] || EMPTY_ORDER,
    pendingPrompt: state.pendingPromptByThread[threadKey] || ""
  };
  const prev = transcriptCache.get(threadKey);
  if (
    prev &&
    prev.items === next.items &&
    prev.itemOrder === next.itemOrder &&
    prev.turnsById === next.turnsById &&
    prev.turnOrder === next.turnOrder &&
    prev.pendingPrompt === next.pendingPrompt
  ) {
    return prev;
  }
  transcriptCache.set(threadKey, next);
  return next;
}

export function useThreadTranscript(threadKey: string) {
  return useSyncExternalStore(
    (listener) => subscribeThreadViewFor(threadKey, listener),
    () => readTranscript(threadKey),
    () => readTranscript(threadKey)
  );
}

export function latestPlanTextFor(threadKey: string) {
  const { items, itemOrder } = {
    items: state.itemsByThread[threadKey] || EMPTY_ITEMS,
    itemOrder: state.itemOrderByThread[threadKey] || EMPTY_ORDER
  };
  for (let index = itemOrder.length - 1; index >= 0; index -= 1) {
    const item = items[itemOrder[index]];
    if (!item || (item.type !== "agentMessage" && item.type !== "plan")) continue;
    const text = String(item.text || "").trim();
    if (text) return text.slice(0, 12000);
  }
  return "";
}

/** Return executable Plan content without promoting commentary or reasoning. */
export function latestPlanPayloadFor(threadKey: string, allowLegacyFinal = false) {
  const items = state.itemsByThread[threadKey] || EMPTY_ITEMS;
  const itemOrder = state.itemOrderByThread[threadKey] || EMPTY_ORDER;
  for (let index = itemOrder.length - 1; index >= 0; index -= 1) {
    const item = items[itemOrder[index]];
    if (!item || item.type !== "plan") continue;
    const text = String(item.text || "").trim();
    if (text) return text.slice(0, 12000);
  }
  if (!allowLegacyFinal) return "";
  for (let index = itemOrder.length - 1; index >= 0; index -= 1) {
    const item = items[itemOrder[index]];
    if (!item || assistantMessagePhase(item) !== "final") continue;
    const text = String(item.text || "").trim();
    if (text) return text.slice(0, 12000);
  }
  return "";
}

export function useLatestPlanPayload(threadKey: string, allowLegacyFinal = false) {
  return useSyncExternalStore(
    (listener) => subscribeThreadViewFor(threadKey, listener),
    () => latestPlanPayloadFor(threadKey, allowLegacyFinal),
    () => latestPlanPayloadFor(threadKey, allowLegacyFinal)
  );
}
