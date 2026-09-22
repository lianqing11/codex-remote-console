import {
  AGENT_PROVIDER_IDS,
  AGENT_PROVIDER_LABELS,
  isAgentProviderId,
  type AgentProviderId
} from "../server/types";

export type ProviderId = AgentProviderId;
export { AGENT_PROVIDER_IDS, AGENT_PROVIDER_LABELS, isAgentProviderId };
export type ModeKind = "default" | "plan" | "ask";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
export type ServiceTier = "priority" | "fast" | "default" | "flex" | null;
export type ApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | { granular: Record<string, boolean> }
  | null;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access" | null;

export type SessionRuntimeSettings = {
  provider: ProviderId;
  mode: ModeKind;
  model: string;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
};

export type PermissionDraft = {
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
};

export type CollaborationModePreset = {
  name?: string | null;
  mode?: ModeKind | null;
  model?: string | null;
  reasoning_effort?: ReasoningEffort;
};

export type ThreadRuntimeResponse = Partial<
  Pick<SessionRuntimeSettings, "mode" | "model" | "reasoningEffort" | "serviceTier" | "approvalPolicy" | "sandboxMode">
> & {
  thread?: {
    mode?: unknown;
    runtime?: { mode?: unknown } | null;
  } | null;
};

export const defaultRuntimeSettings: SessionRuntimeSettings = {
  provider: "codex",
  mode: "default",
  model: "",
  reasoningEffort: "xhigh",
  serviceTier: null,
  approvalPolicy: null,
  sandboxMode: null
};

export const DEFAULT_CURSOR_MODEL = "cursor-grok-4.6-high-fast";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";

export const defaultProviderRuntimeSettings: Record<ProviderId, SessionRuntimeSettings> = {
  codex: defaultRuntimeSettings,
  cursor: {
    provider: "cursor",
    mode: "default",
    model: DEFAULT_CURSOR_MODEL,
    reasoningEffort: null,
    serviceTier: null,
    approvalPolicy: null,
    sandboxMode: null
  },
  claude: {
    provider: "claude",
    mode: "default",
    model: DEFAULT_CLAUDE_MODEL,
    reasoningEffort: "high",
    serviceTier: null,
    approvalPolicy: null,
    sandboxMode: null
  }
};

export function providerRuntimeDefaults(provider: ProviderId): SessionRuntimeSettings {
  return { ...defaultProviderRuntimeSettings[provider] };
}

export function restoreProviderRuntimeSettings(
  provider: ProviderId,
  stored: Partial<SessionRuntimeSettings>
): SessionRuntimeSettings {
  const defaults = providerRuntimeDefaults(provider);
  const restored = { ...defaults, ...stored, provider };
  // `auto` was the old Cursor default. Migrate only that legacy value (and
  // missing/blank values), while preserving a model the user chose explicitly.
  if (provider === "cursor" && (!String(stored.model || "").trim() || stored.model === "auto")) {
    restored.model = defaults.model;
  }
  return restored;
}

export function normalizeModeKind(value: unknown): ModeKind | null {
  if (value === "plan" || value === "ask") return value;
  if (value === "default" || value === "agent") return "default";
  return null;
}

/** Resolve the execution mode carried by a listed or hydrated provider session. */
export function sessionModeForThread(
  thread: { mode?: unknown; runtime?: { mode?: unknown } | null } | null | undefined,
  fallback: ModeKind = "default"
): ModeKind {
  return normalizeModeKind(thread?.mode) || normalizeModeKind(thread?.runtime?.mode) || fallback;
}

export function mergeThreadRuntimeSettings(
  current: SessionRuntimeSettings,
  response: ThreadRuntimeResponse,
  overrides: Partial<SessionRuntimeSettings> = {}
): SessionRuntimeSettings {
  const responseMode = normalizeModeKind(response.mode)
    || sessionModeForThread(response.thread, current.mode);
  return {
    ...current,
    mode: responseMode,
    model: response.model || current.model,
    reasoningEffort: current.reasoningEffort ?? response.reasoningEffort ?? null,
    serviceTier: current.serviceTier ?? response.serviceTier ?? null,
    approvalPolicy: response.approvalPolicy ?? current.approvalPolicy,
    sandboxMode: response.sandboxMode ?? current.sandboxMode,
    ...overrides
  };
}

export function modeLabel(mode: ModeKind) {
  if (mode === "plan") return "Plan";
  if (mode === "ask") return "Ask";
  return "Agent";
}

export function isFastServiceTier(serviceTier: string | null | undefined) {
  const normalized = String(serviceTier || "").trim().toLowerCase();
  return normalized === "priority" || normalized === "fast";
}

export function fastModeLabel(serviceTier: string | null | undefined) {
  return isFastServiceTier(serviceTier) ? "Fast" : "Standard";
}

export function withRuntimeMode(settings: SessionRuntimeSettings, mode: ModeKind) {
  return { ...settings, mode };
}

export function buildCollaborationMode(
  settings: SessionRuntimeSettings,
  presets: CollaborationModePreset[],
  modelOverride?: string,
  turnMode: ModeKind = settings.mode
) {
  const preset =
    presets.find((item) => item.mode === turnMode) ||
    presets.find((item) => String(item.name || "").toLowerCase() === (turnMode === "plan" ? "plan" : "default"));
  const model = preset?.model || modelOverride || settings.model;
  if (!model) return undefined;

  return {
    mode: turnMode,
    settings: {
      model,
      reasoning_effort: settings.reasoningEffort ?? preset?.reasoning_effort ?? null,
      developer_instructions: null
    }
  };
}

function cursorLikeMode(settings: SessionRuntimeSettings) {
  return settings.mode === "plan" ? "plan" : settings.mode === "ask" ? "ask" : "agent";
}

export function runtimeThreadParams(settings: SessionRuntimeSettings) {
  if (settings.provider === "cursor") {
    return {
      ...(settings.model ? { model: settings.model } : {}),
      mode: cursorLikeMode(settings)
    };
  }

  if (settings.provider === "claude") {
    return {
      ...(settings.model ? { model: settings.model } : {}),
      mode: settings.mode === "plan" ? "plan" : "agent",
      ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {})
    };
  }

  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.sandboxMode ? { sandbox: settings.sandboxMode } : {})
  };
}

export function runtimeTurnParams(settings: SessionRuntimeSettings) {
  if (settings.provider === "cursor") {
    return {
      ...(settings.model ? { model: settings.model } : {}),
      mode: cursorLikeMode(settings)
    };
  }

  if (settings.provider === "claude") {
    return {
      ...(settings.model ? { model: settings.model } : {}),
      mode: settings.mode === "plan" ? "plan" : "agent",
      ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {})
    };
  }

  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {})
  };
}

export function runtimeStorageKey(provider: ProviderId) {
  return `${provider}.runtime`;
}

function recordOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function streamEventToNotification(raw: unknown, provider: ProviderId = "cursor") {
  if (!raw || typeof raw !== "object") return null;
  const eventRecord = raw as Record<string, any>;
  const event = String(eventRecord.event || eventRecord.type || "");
  const threadId = eventRecord.threadId || eventRecord.sessionId || eventRecord.session_id;
  const turnId = String(eventRecord.turnId || eventRecord.runId || eventRecord.run_id || `${provider}-run`);
  if (!threadId) return null;
  const base = { provider, threadId, turnId };
  const now = Date.now() / 1000;

  if (event === "run_started" || event === "run:started" || (event === "status" && eventRecord.status === "running")) {
    return { method: "turn/started", params: { ...base, turn: { id: turnId, items: [], status: "inProgress", startedAt: now } } };
  }
  if (
    event === "run_completed"
    || event === "run:completed"
    || event === "result"
    || (event === "status" && ["completed", "failed", "cancelled", "failed-after-restart"].includes(String(eventRecord.status)))
  ) {
    const status = event === "status" ? String(eventRecord.status) : "completed";
    return { method: "turn/completed", params: { ...base, turn: { id: turnId, items: [], status, completedAt: now } } };
  }
  if (event === "assistant_text" || event === "assistant_text_delta" || event === "assistant") {
    const text = typeof eventRecord.delta === "string"
      ? eventRecord.delta
      : String(eventRecord.text || eventRecord.message || "");
    return {
      method: "item/agentMessage/delta",
      params: {
        ...base,
        itemId: String(eventRecord.itemId || `${turnId}-assistant`),
        delta: text
      }
    };
  }
  if (event === "rate_limits") {
    return { method: "account/rateLimits/updated", params: { ...base, provider, ...(recordOf(eventRecord.result) || {}) } };
  }
  if (event === "token_usage") {
    return { method: "thread/tokenUsage/updated", params: { ...base, provider, usage: eventRecord.result || eventRecord.usage } };
  }
  if (event === "tool_started" || event === "tool_completed" || event === "tool_failed" || event === "tool_call") {
    const status = event.includes("failed") ? "failed" : event.includes("completed") ? "completed" : "started";
    return {
      method: event.includes("started") ? "item/started" : "item/completed",
      params: {
        ...base,
        item: {
          id: String(eventRecord.itemId || eventRecord.toolCallId || `${turnId}-tool-${eventRecord.toolName || eventRecord.name || "call"}`),
          type: "toolCall",
          tool: String(eventRecord.toolName || eventRecord.name || eventRecord.tool || "tool"),
          status,
          output: String(eventRecord.output || eventRecord.summary || "")
        }
      }
    };
  }
  return null;
}

export function cursorEventToNotification(raw: unknown, provider: ProviderId = "cursor") {
  return streamEventToNotification(raw, provider);
}

function endedCursorSessionStatus(value: unknown) {
  const status = String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  return status === "completed" || status === "failed" || status === "failedafterrestart" || status === "cancelled";
}

export function cursorTranscriptToTurns(transcript: unknown, fallbackRunId = "cursor-run", sessionStatus?: unknown) {
  const entries = Array.isArray(transcript) ? transcript : [];
  const turns = new Map<string, any>();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, any>;
    const runId = String(record.runId || record.run_id || record.turnId || fallbackRunId);
    const turn = turns.get(runId) || {
      id: runId,
      items: [],
      status: "completed",
      startedAt: record.startedAt || record.createdAt || null,
      completedAt: record.completedAt || null
    };
    const kind = String(record.type || record.event || record.role || "");
    const id = String(record.id || record.itemId || record.toolCallId || `${runId}-${index}`);
    if (kind.includes("user")) {
      turn.items.push({
        id,
        type: "userMessage",
        content: [{ type: "text", text: String(record.text || record.content || record.prompt || ""), text_elements: [] }]
      });
    } else if (kind.includes("tool")) {
      const toolItem = {
        id,
        type: "toolCall",
        tool: String(record.toolName || record.name || record.tool || "tool"),
        status: String(record.status || (kind.includes("failed") ? "failed" : kind.includes("completed") ? "completed" : "started")),
        output: String(record.output || record.summary || record.text || "")
      };
      const existingTool = turn.items.find((item: any) => item.id === id);
      if (existingTool) Object.assign(existingTool, toolItem);
      else turn.items.push(toolItem);
    } else if (kind === "assistant_text" || kind.includes("assistant")) {
      const assistantId = `${runId}-assistant`;
      const assistant = turn.items.find((item: any) => item.id === assistantId);
      const text = String(record.text || record.content || record.message || record.delta || "");
      if (assistant) assistant.text = `${assistant.text || ""}${text}`;
      else turn.items.push({ id: assistantId, type: "agentMessage", text });
    } else if (kind === "result") {
      const resultText = String(record.text || record.content || record.message || "");
      const assistantId = `${runId}-assistant`;
      const assistant = turn.items.find((item: any) => item.id === assistantId);
      if (resultText && !assistant) turn.items.push({ id: assistantId, type: "agentMessage", text: resultText });
      else if (resultText && assistant) {
        const currentText = String(assistant.text || "");
        if (resultText.startsWith(currentText)) assistant.text = resultText;
        else if (!currentText.endsWith(resultText)) assistant.text = `${currentText}${resultText}`;
      }
    } else if (kind === "error") {
      turn.items.push({
        id,
        type: "agentMessage",
        text: String(record.message || record.text || "Cursor run failed.")
      });
    }
    if (record.status) turn.status = record.status;
    if (record.startedAt || record.createdAt) turn.startedAt = turn.startedAt || record.startedAt || record.createdAt;
    if (record.completedAt) turn.completedAt = record.completedAt;
    turns.set(runId, turn);
  }
  const list = [...turns.values()];
  if (endedCursorSessionStatus(sessionStatus)) {
    for (const turn of list) {
      const status = String(turn.status || "").replace(/[\s_-]+/g, "").toLowerCase();
      if (status === "running" || status === "inprogress" || status === "active" || status === "idle") {
        turn.status = String(sessionStatus);
      }
    }
  }
  return list;
}

export function runtimePermissionDraft(settings: SessionRuntimeSettings): PermissionDraft {
  return {
    approvalPolicy: settings.approvalPolicy || "on-request",
    sandboxMode: settings.sandboxMode || "workspace-write"
  };
}
