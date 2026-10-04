import { partitionTurnItems, statusLabel, workLogCounts, type ThreadItem, type WorkLogSummary } from "../app/threadModel";

type Turn = { id: string; status?: unknown; items?: ThreadItem[]; workLog?: WorkLogSummary };

// Work logs are ~96% of a history reply but start collapsed once a turn has its
// final answer. Replies carry counts; the items wait here until a log is expanded.
const cache = new Map<string, Map<string, ThreadItem[]>>();
const cachedThreads = 20;

export function deferWorkLogs<T>(provider: string, result: T): T {
  const thread = (result as { thread?: { id?: string; turns?: Turn[] } } | null)?.thread;
  if (!thread?.id || !Array.isArray(thread.turns)) return result;
  const key = `${provider}:${thread.id}`;
  const stored = new Map<string, ThreadItem[]>();
  const turns = thread.turns.map((turn) => {
    const items = turn.items || [];
    const completed = ["completed", "success", "succeeded"].includes(statusLabel(turn.status).replace(/[^a-z]/gi, "").toLowerCase());
    if (!completed) return turn;
    // Same split the browser renders, so a deferred log holds exactly its collapsed items.
    const { workItems, finalItems } = partitionTurnItems(items, false, true);
    if (!workItems.length || !finalItems.length) return turn;
    stored.set(turn.id, workItems);
    const deferred = new Set(workItems);
    return { ...turn, items: items.filter((item) => !deferred.has(item)), workLog: { turnId: turn.id, ...workLogCounts(workItems) } };
  });
  cache.delete(key);
  cache.set(key, stored);
  if (cache.size > cachedThreads) cache.delete(cache.keys().next().value!);
  return { ...result, thread: { ...thread, turns } };
}

export async function readWorkLog(
  provider: string,
  threadId: string,
  turnId: string,
  read: () => Promise<unknown>
) {
  const key = `${provider}:${threadId}`;
  // After a restart or eviction, one full read refills this thread's logs.
  if (!cache.get(key)?.has(turnId)) deferWorkLogs(provider, await read());
  const items = cache.get(key)?.get(turnId);
  if (!items) throw new Error("This turn's work log is no longer available.");
  return items;
}
