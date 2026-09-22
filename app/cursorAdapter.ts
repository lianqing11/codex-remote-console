import { cursorEventToNotification, cursorTranscriptToTurns, streamEventToNotification, type ProviderId } from "./sessionRuntime";
import {
  epochSeconds,
  normalizeThread,
  normalizeThreads,
  nowSeconds,
  type Thread,
  type Turn
} from "./threadModel";

export { cursorEventToNotification, cursorTranscriptToTurns, streamEventToNotification };

export function cursorMethod(method: string) {
  const map: Record<string, string> = {
    "thread/list": "session/list",
    "thread/start": "session/create",
    "thread/read": "session/read",
    "thread/resume": "session/read",
    "thread/archive": "session/archive",
    "thread/unarchive": "session/unarchive",
    "thread/name/set": "session/rename",
    "thread/title/suggest": "session/suggest-title",
    "turn/start": "run/start",
    "turn/interrupt": "run/stop"
  };
  return map[method] || method;
}

export function cursorParams(method: string, params: any) {
  if (!params || typeof params !== "object") return params;
  const next = { ...params };
  if (next.threadId && !next.sessionId) next.sessionId = next.threadId;
  if (method === "thread/name/set" && next.name && !next.title) next.title = next.name;
  if (method === "turn/start" && Array.isArray(next.input)) {
    next.prompt = next.input
      .map((item: any) => (item?.type === "text" ? String(item.text || "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  delete next.threadId;
  delete next.collaborationMode;
  return next;
}

export function normalizeAgentThread(raw: any, provider: ProviderId): Thread | null {
  const source = raw?.thread || raw?.session || raw;
  if (!source || typeof source !== "object") return null;
  const id = String(source.id || source.sessionId || source.nativeId || "");
  if (!id) return null;
  const transcript = raw?.transcript || raw?.items || source.transcript || source.items;
  const sourceTurns = Array.isArray(source.turns) && source.turns.some((turn: { items?: unknown }) => Array.isArray(turn?.items))
    ? source.turns
    : null;
  const turns = sourceTurns
    || (provider === "cursor"
      ? cursorTranscriptToTurns(
        transcript,
        String(raw?.runId || source.runId || "cursor-run"),
        source.status && typeof source.status === "object" ? (source.status as { type?: unknown }).type : source.status
      )
      : Array.isArray(raw?.turns) && raw.turns.some((turn: { items?: unknown }) => Array.isArray(turn?.items))
        ? raw.turns
        : []);
  return normalizeThread({
    id,
    nativeId: String(source.nativeId || source.sessionId || id),
    provider,
    preview: String(source.preview || source.title || source.name || "New session"),
    cwd: String(source.cwd || ""),
    updatedAt: epochSeconds(source.updatedAt ?? source.updated_at),
    status: source.status && typeof source.status === "object" ? source.status : { type: String(source.status || "idle") },
    mode: source.mode === "plan" ? "plan" : source.mode === "ask" ? "ask" : "default",
    runtime: source.runtime || (provider === "cursor" && source.model
      ? { model: String(source.model), reasoningEffort: null, serviceTier: null, mode: String(source.mode || "agent") }
      : null),
    name: typeof source.name === "string" ? source.name : typeof source.title === "string" ? source.title : null,
    empty: Boolean(source.empty),
    turns
  });
}

export function normalizeAgentResponse(method: string, response: any, provider: ProviderId) {
  if (provider === "codex") return response;
  if (method === "thread/list") {
    const data = response?.data || response?.sessions || response?.items || [];
    return { ...response, data: normalizeThreads(data.map((item: any) => ({ ...item, provider }))) };
  }
  if (method === "thread/title/suggest") {
    return { ...response, title: String(response?.title || "").trim() };
  }
  if (method.startsWith("thread/")) {
    const thread = normalizeAgentThread(response, provider);
    return { ...response, thread: thread || response?.thread, mode: thread?.mode };
  }
  if (method === "turn/start") {
    const run = response?.turn || response?.run || response;
    return {
      ...response,
      turn: run?.id
        ? {
            id: String(run.id),
            items: [] as Turn["items"],
            status: run.status || "inProgress",
            startedAt: Number(run.startedAt || nowSeconds()),
            completedAt: null
          }
        : response?.turn
    };
  }
  return response;
}
