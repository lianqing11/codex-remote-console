import { streamCompletionNotification, type ThreadMeta } from "./feishuNotify";
import {
  extractTitleSource,
  fallbackSessionTitle,
  isUntitledSessionTitle
} from "./sessionTitle";
import type { AgentNormalizedEvent, JsonRpcNotification } from "./types";

export const cursorFeishuSource = {
  id: "cursor",
  label: "Cursor Agent"
} as const;

type CursorTitleProvider = {
  handle(method: string, params?: unknown): Promise<unknown>;
};

function record(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** Ensure Cursor sessions have an immediate local title before Feishu naming uses them. */
export async function ensureCursorSessionTitle(provider: CursorTitleProvider, sessionId: string) {
  const read = record(await provider.handle("session/read", { sessionId }));
  const session = record(read.session);
  const cwd = stringValue(session.cwd);
  const current = stringValue(session.title) || stringValue(session.name);
  if (!isUntitledSessionTitle(current, cwd)) return current || null;

  const transcript = Array.isArray(read.transcript) ? read.transcript.map(record) : [];
  const next = fallbackSessionTitle(extractTitleSource(transcript).userText);
  if (!next) return current || null;

  await provider.handle("session/rename", { sessionId, title: next });
  return next;
}

export function cursorCompletionNotification(
  event: AgentNormalizedEvent,
  completedAt = Math.floor(Date.now() / 1000)
): JsonRpcNotification | null {
  if (event.provider !== "cursor") return null;
  return streamCompletionNotification(event, completedAt);
}

export function cursorThreadMeta(value: unknown, provider: "cursor" | "claude" = "cursor"): ThreadMeta {
  const result = record(value);
  const thread = record(result.thread);
  const session = record(result.session);
  const transcript = Array.isArray(result.transcript) ? result.transcript.map(record) : [];
  const turns = Array.isArray(result.turns) ? result.turns.map(record) : [];

  return {
    cwd: stringValue(thread.cwd) || stringValue(session.cwd),
    name:
      stringValue(thread.title) ||
      stringValue(thread.name) ||
      stringValue(session.title) ||
      stringValue(session.name) ||
      null,
    preview: stringValue(session.preview),
    source: { provider },
    turns: turns.map((turn) => {
      const id = stringValue(turn.id);
      const transcriptForTurn = transcript.filter((item) => stringValue(item.runId) === id);
      const userMessage =
        stringValue(turn.userMessage) ||
        stringValue(transcriptForTurn.find((item) => item.event === "user_text")?.text);
      const assistantFromTranscript = transcriptForTurn
        .filter((item) => item.event === "assistant_text")
        .map((item) => stringValue(item.text))
        .join("");
      const resultText = stringValue(
        [...transcriptForTurn].reverse().find((item) => item.event === "result")?.text
      );
      const agentMessage = stringValue(turn.agentMessage) || assistantFromTranscript || resultText;
      const items = [
        ...(userMessage ? [{ id: `${id}-user`, type: "userMessage", text: userMessage }] : []),
        ...(agentMessage ? [{ id: `${id}-agent`, type: "agentMessage", text: agentMessage }] : [])
      ];

      return {
        id,
        status: turn.status,
        items
      };
    })
  };
}
