import { nowSeconds, statusLabel, uniqueAppend, uniqueItems, type ThreadItem, type Turn } from "./threadModel";
import {
  clearPendingPrompt,
  getThreadViewState,
  registerTurnItem,
  setItemOrderForThread,
  setItemsForThread,
  setTurnOrderForThread,
  setTurnsForThread
} from "./threadViewStore";

const pendingDeltas = new Map<string, { text: string; flush: (text: string) => void; frame: number }>();

export function coalesceDelta(key: string, delta: string, flush: (text: string) => void) {
  const existing = pendingDeltas.get(key);
  if (existing) {
    existing.text += delta;
    return;
  }
  const frame = requestAnimationFrame(() => {
    const entry = pendingDeltas.get(key);
    pendingDeltas.delete(key);
    if (entry) entry.flush(entry.text);
  });
  pendingDeltas.set(key, { text: delta, flush, frame });
}

export function flushPendingDeltas() {
  for (const [key, entry] of pendingDeltas) {
    cancelAnimationFrame(entry.frame);
    pendingDeltas.delete(key);
    entry.flush(entry.text);
  }
}

function appendItem(threadId: string, item: ThreadItem, turnId?: string) {
  setItemsForThread(threadId, (current) => ({ ...current, [item.id]: item }));
  setItemOrderForThread(threadId, (current) => uniqueAppend(current, item.id));
  registerTurnItem(threadId, turnId, item.id);
}

function notificationTurnId(threadId: string, explicitTurnId: unknown) {
  if (typeof explicitTurnId === "string" && explicitTurnId) return explicitTurnId;
  const view = getThreadViewState();
  const order = view.turnOrderByThread[threadId] || [];
  const turns = view.turnsByThread[threadId] || {};
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const turnId = order[index];
    const status = statusLabel(turns[turnId]?.status).replace(/[^a-z]/gi, "").toLowerCase();
    if (status === "inprogress" || status === "running") return turnId;
  }
  return order[order.length - 1];
}

export function applyTranscriptNotification(
  threadId: string,
  message: { method: string; params?: any }
): "handled" | "ignored" {
  const params = message.params || {};
  const method = message.method;
  const eventTurnId = notificationTurnId(threadId, params.turnId);

  if (method === "turn/started") {
    const turn = params.turn as Turn | undefined;
    if (turn?.id) {
      setTurnsForThread(threadId, (current) => ({
        ...current,
        [turn.id]: {
          id: turn.id,
          itemIds: current[turn.id]?.itemIds || [],
          status: turn.status,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          updatedAt: nowSeconds()
        }
      }));
      setTurnOrderForThread(threadId, (current) => uniqueAppend(current, turn.id));
    }
    return "handled";
  }

  if (method === "turn/completed") {
    const turn = params.turn as Turn | undefined;
    clearPendingPrompt(threadId);
    if (turn?.id) {
      const turnItems = turn.items || [];
      setItemsForThread(threadId, (current) => {
        const next = { ...current };
        for (const item of turnItems) next[item.id] = item;
        return next;
      });
      setItemOrderForThread(threadId, (current) => {
        let next = current;
        for (const item of turnItems) next = uniqueAppend(next, item.id);
        return next;
      });
      setTurnsForThread(threadId, (current) => ({
        ...current,
        [turn.id]: {
          id: turn.id,
          itemIds: uniqueItems([
            ...(current[turn.id]?.itemIds || []),
            ...turnItems.map((item) => item.id)
          ]),
          status: turn.status,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          updatedAt: turn.completedAt || nowSeconds()
        }
      }));
      setTurnOrderForThread(threadId, (current) => uniqueAppend(current, turn.id));
    }
    return "handled";
  }

  if ((method === "item/started" || method === "item/completed") && params.item) {
    clearPendingPrompt(threadId);
    appendItem(threadId, params.item, params.turnId || params.item.turnId || eventTurnId);
    return "handled";
  }

  if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
    const itemId = String(params.itemId || "");
    const turnId = params.turnId;
    coalesceDelta(`${threadId}:${itemId}:text`, String(params.delta || ""), (text) => {
      setItemsForThread(threadId, (current) => {
        const item = current[itemId] || { id: itemId, type: method.includes("plan") ? "plan" : "agentMessage", text: "" };
        return { ...current, [itemId]: { ...item, text: `${item.text || ""}${text}` } };
      });
      setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
      registerTurnItem(threadId, turnId || eventTurnId, itemId);
    });
    return "handled";
  }

  if (method === "item/reasoning/summaryPartAdded") {
    setItemsForThread(threadId, (current) => {
      const item = current[params.itemId] || { id: params.itemId, type: "reasoning", summary: [], content: [] };
      const summary = [...(item.summary || [])];
      summary[params.summaryIndex || 0] = summary[params.summaryIndex || 0] || "";
      return { ...current, [params.itemId]: { ...item, summary } };
    });
    setItemOrderForThread(threadId, (current) => uniqueAppend(current, params.itemId));
    registerTurnItem(threadId, eventTurnId, params.itemId);
    return "handled";
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const itemId = String(params.itemId || "");
    coalesceDelta(`${threadId}:${itemId}:summary:${params.summaryIndex || 0}`, String(params.delta || ""), (text) => {
      setItemsForThread(threadId, (current) => {
        const item = current[itemId] || { id: itemId, type: "reasoning", summary: [], content: [] };
        const summary = [...(item.summary || [])];
        summary[params.summaryIndex || 0] = `${summary[params.summaryIndex || 0] || ""}${text}`;
        return { ...current, [itemId]: { ...item, summary } };
      });
      setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
      registerTurnItem(threadId, eventTurnId, itemId);
    });
    return "handled";
  }

  if (method === "item/reasoning/textDelta") {
    const itemId = String(params.itemId || "");
    coalesceDelta(`${threadId}:${itemId}:content:${params.contentIndex || 0}`, String(params.delta || ""), (text) => {
      setItemsForThread(threadId, (current) => {
        const item = current[itemId] || { id: itemId, type: "reasoning", summary: [], content: [] };
        const content = [...((item.content || []).filter((part): part is string => typeof part === "string"))];
        content[params.contentIndex || 0] = `${content[params.contentIndex || 0] || ""}${text}`;
        return { ...current, [itemId]: { ...item, content } };
      });
      setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
      registerTurnItem(threadId, eventTurnId, itemId);
    });
    return "handled";
  }

  if (method === "item/commandExecution/outputDelta") {
    const itemId = String(params.itemId || "");
    coalesceDelta(`${threadId}:${itemId}:cmd`, String(params.delta || ""), (text) => {
      setItemsForThread(threadId, (current) => {
        const item = current[itemId] || { id: itemId, type: "commandExecution", aggregatedOutput: "" };
        return { ...current, [itemId]: { ...item, aggregatedOutput: `${item.aggregatedOutput || ""}${text}` } };
      });
      setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
      registerTurnItem(threadId, eventTurnId, itemId);
    });
    return "handled";
  }

  if (method === "item/fileChange/outputDelta") {
    const itemId = String(params.itemId || "");
    coalesceDelta(`${threadId}:${itemId}:file`, String(params.delta || ""), (text) => {
      setItemsForThread(threadId, (current) => {
        const item = current[itemId] || { id: itemId, type: "fileChange", output: "" };
        return { ...current, [itemId]: { ...item, output: `${item.output || ""}${text}` } };
      });
      setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
      registerTurnItem(threadId, eventTurnId, itemId);
    });
    return "handled";
  }

  if (method === "item/fileChange/patchUpdated") {
    setItemsForThread(threadId, (current) => {
      const item = current[params.itemId] || { id: params.itemId, type: "fileChange" };
      return { ...current, [params.itemId]: { ...item, changes: params.changes || [] } };
    });
    setItemOrderForThread(threadId, (current) => uniqueAppend(current, params.itemId));
    registerTurnItem(threadId, eventTurnId, params.itemId);
    return "handled";
  }

  if (method === "turn/diff/updated") {
    const itemId = `${params.turnId}-diff`;
    setItemsForThread(threadId, (current) => ({
      ...current,
      [itemId]: { id: itemId, type: "diff", text: params.diff || "" }
    }));
    setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
    registerTurnItem(threadId, eventTurnId, itemId);
    return "handled";
  }

  if (method === "turn/plan/updated") {
    const itemId = `${params.turnId}-plan`;
    const explanation = params.explanation ? `${params.explanation}\n\n` : "";
    const planEntries = Array.isArray(params.plan)
      ? params.plan.map((step: any) => ({
          status: String(step.status || "pending"),
          step: String(step.step || "")
        }))
      : [];
    const plan = planEntries.length
      ? planEntries.map((step: { step: string; status: string }) => `- ${step.status}: ${step.step}`).join("\n")
      : "";
    setItemsForThread(threadId, (current) => ({
      ...current,
      [itemId]: {
        id: itemId,
        type: "plan",
        text: `${explanation}${plan}`.trim(),
        explanation: String(params.explanation || ""),
        planEntries
      }
    }));
    setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
    registerTurnItem(threadId, eventTurnId, itemId);
    return "handled";
  }

  return "ignored";
}

export function terminalKindForTurn(turn?: Turn) {
  return ["failed", "error"].includes(statusLabel(turn?.status)) ? "failed" : "idle";
}
