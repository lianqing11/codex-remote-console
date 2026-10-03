import { threadKey, providerOf, type Thread } from "./threadModel";

/** Preserve sibling recency, keep branches adjacent, tolerate missing/archived parents. */
export function orderBranchThreads(threads: Thread[], collapsed: Set<string>): Thread[] {
  const keys = new Set(threads.map(thread => threadKey(thread)));
  const children = new Map<string, Thread[]>();
  const roots: Thread[] = [];
  for (const thread of threads) {
    const parent = thread.forkedFromId ? threadKey(thread.forkedFromId, providerOf(thread)) : "";
    if (parent && keys.has(parent) && parent !== threadKey(thread)) {
      const list = children.get(parent) || [];
      list.push(thread); children.set(parent, list);
    } else roots.push(thread);
  }
  const output: Thread[] = [], visited = new Set<string>();
  function visit(thread: Thread, hidden = false) {
    const key = threadKey(thread);
    if (visited.has(key)) return;
    visited.add(key);
    if (!hidden) output.push(thread);
    for (const child of children.get(key) || []) visit(child, hidden || collapsed.has(key));
  }
  roots.forEach(thread => visit(thread));
  threads.filter(thread => !visited.has(threadKey(thread))).forEach(thread => visit(thread));
  return output;
}
