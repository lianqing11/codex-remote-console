import type { AgentQueueEnqueueInput, AgentQueueSnapshot } from "./queueTypes";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type BrowserMessage =
  | {
      type: "queue:enqueue";
      requestId: string;
      item: AgentQueueEnqueueInput;
    }
  | {
      type: "queue:list";
      requestId: string;
    }
  | {
      type: "queue:cancel" | "queue:retry";
      requestId: string;
      queueId: string;
    }
  | {
      type: "queue:pause" | "queue:resume" | "queue:clear";
      requestId: string;
      threadKey: string;
    }
  | {
      type: "agent:request";
      requestId: string;
      provider: AgentProviderName;
      method: string;
      params?: unknown;
    }
  | {
      type: "codex:request";
      requestId: string;
      method: string;
      params?: unknown;
    }
  | {
      type: "codex:serverResponse";
      requestId: string;
      serverRequestId: JsonRpcId;
      result: unknown;
    }
  | {
      type: "project:resolve";
      requestId: string;
      cwd: string;
    };

export type BrowserReply = {
  type: "reply";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export const AGENT_PROVIDER_IDS = ["codex", "cursor", "claude"] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];
export type AgentProviderName = AgentProviderId;

export const AGENT_PROVIDER_LABELS: Record<AgentProviderId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  claude: "Claude"
};

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

export type AgentRunStatus = "idle" | "running" | "completed" | "failed" | "cancelled" | "failed-after-restart";

export type AgentSession = {
  provider: AgentProviderId;
  id: string;
  key: string;
  cwd: string;
  name: string | null;
  preview: string;
  model: string;
  status: AgentRunStatus;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  turns: unknown[];
};

export type AgentSessionSummary = {
  provider: AgentProviderName;
  id: string;
  key: string;
  sessionId: string;
  nativeSessionId: string | null;
  cwd: string;
  name: string;
  title: string;
  preview: string;
  empty?: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  mode?: "agent" | "plan" | "ask";
  status: AgentRunStatus;
  turns: number;
  lastError?: string;
};

export type AgentCapabilities = {
  models: boolean;
  planMode: boolean;
  askMode: boolean;
  approvals: boolean;
  steering: boolean;
  images: boolean;
  fork: boolean;
  compact: boolean;
  plugins: boolean;
  skills: boolean;
  mcpStatus: boolean;
  memory: boolean;
  serviceTier: boolean;
  reasoningEffort: boolean;
  rename: boolean;
  archive: boolean;
  diff: boolean;
} & Partial<{
  sessions: boolean;
  threads: boolean;
  turnStart: boolean;
  turnInterrupt: boolean;
  agentMode: boolean;
  unarchive: boolean;
  steer: boolean;
  mcp: boolean;
}>;

export type AgentModelSummary = {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
};

export type AgentProviderSnapshot = {
  provider: AgentProviderName;
  available: boolean;
  status: "ready" | "degraded" | "unavailable";
  diagnostic?: string | null;
  diagnostics?: Record<string, string | null>;
  version?: string;
  authenticated?: boolean;
  capabilities: AgentCapabilities;
  sessions?: AgentSessionSummary[];
  models?: AgentModelSummary[];
  rateLimit?: unknown;
};

export type AgentNormalizedEvent =
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "assistant_text";
      text: string;
      delta?: boolean;
    }
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "tool_started" | "tool_completed" | "tool_failed";
      toolName?: string;
      toolCallId?: string;
      summary?: string;
    }
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "status";
      status: AgentRunStatus;
      message?: string;
    }
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "result";
      result: unknown;
    }
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "error";
      message: string;
    }
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "rate_limits";
      result: unknown;
    }
  | {
      type: "agent:event";
      provider: AgentProviderName;
      sessionId: string;
      runId?: string;
      event: "token_usage";
      result: unknown;
    };

export type CodexGatewayDiagnostic = {
  code: "upstream_connection";
  title: string;
  detail: string;
  retrying: boolean;
  occurredAt: number;
};

export type BrowserEvent =
  | AgentNormalizedEvent
  | {
      type: "queue:snapshot";
      snapshot: AgentQueueSnapshot;
    }
  | {
      type: "codex:notification";
      message: JsonRpcNotification;
    }
  | {
      type: "codex:serverRequest";
      request: JsonRpcRequest;
    }
  | {
      type: "codex:serverRequestResolved";
      requestId: JsonRpcId;
    }
  | {
      type: "gateway:diagnostic";
      diagnostic: CodexGatewayDiagnostic | null;
    }
  | {
      type: "gateway:state";
      status: "starting" | "connected" | "disconnected" | "error";
      detail?: string;
    };

export type CodexGatewaySnapshot = {
  initializeInfo?: unknown;
  collaborationModes?: unknown[];
  pendingServerRequests?: JsonRpcRequest[];
  diagnostic?: CodexGatewayDiagnostic | null;
};

export type ProjectInfo = {
  cwd: string;
  realpath: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  git?: {
    insideWorkTree: boolean;
    branch: string | null;
    root: string | null;
  };
};

export type ProjectDirectoryEntry = {
  name: string;
  path: string;
};

export type ProjectDirectoryListing = {
  cwd: string;
  realpath: string;
  parent: string | null;
  entries: ProjectDirectoryEntry[];
};

export type ProjectSuggestion = {
  label: string;
  path: string;
};

export type ProjectTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modifiedAt: number | null;
  extension: string | null;
  symlink: boolean;
  accessible: boolean;
};

export type ProjectTreeListing = {
  root: string;
  path: string;
  parent: string | null;
  entries: ProjectTreeEntry[];
  truncated: boolean;
};

export type ProjectFilePreview = {
  root: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  viewer: "markdown" | "code" | "text" | "unsupported";
  language: string;
};

export type ProjectUploadResult = {
  root: string;
  directory: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  overwritten: boolean;
};
