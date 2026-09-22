"use client";

import {
  Archive,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Home as HomeIcon,
  Info,
  ListTree,
  LoaderCircle,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Terminal,
  X
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  Fragment,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  memo,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  findSlashCommand,
  slashCommandDisabledReason,
  type SlashCommand
} from "./slashCommands";
import {
  buildCollaborationMode,
  defaultRuntimeSettings,
  fastModeLabel,
  isFastServiceTier,
  providerRuntimeDefaults,
  restoreProviderRuntimeSettings,
  runtimeStorageKey,
  mergeThreadRuntimeSettings,
  modeLabel,
  AGENT_PROVIDER_LABELS,
  isAgentProviderId,
  sessionModeForThread,
  runtimePermissionDraft,
  runtimeThreadParams,
  runtimeTurnParams,
  type ApprovalPolicy,
  type ModeKind,
  type PermissionDraft,
  type ProviderId,
  type ReasoningEffort,
  type SandboxMode,
  type ServiceTier,
  type SessionRuntimeSettings
} from "./sessionRuntime";
import { cursorEventToNotification } from "./cursorAdapter";
import { appPath, getJson, postJson } from "./apiClient";
import { ConversationPane } from "./ConversationPane";
import { ProjectDiffPanel, userMessageParts, type ProjectDiff } from "./conversationViews";
import { cursorMethod, cursorParams, normalizeAgentResponse, normalizeAgentThread } from "./cursorAdapter";
import { formatBytes } from "./formatUtils";
import {
  formatCodexPercent,
  formatCodexResetFull,
  formatCodexResetShort,
  remainingCodexPercent,
  standardCodexRateLimit,
  type StandardCodexRateLimit
} from "./codexUsage";
import {
  formatClaudeResetRelative,
  formatClaudeUsageLabel,
  formatClaudeWeekReset,
  standardClaudeRateLimit,
  type StandardClaudeRateLimit
} from "./claudeUsage";
import {
  formatCursorUsageLabel,
  formatCursorUsageTitle,
  formatCursorUsedPercent,
  parseCursorUsage,
  type CursorUsageSnapshot
} from "./cursorUsage";
import { AgentFleet, FleetSessionRow } from "./AgentFleet";
import { Composer, type ComposerHandle } from "./Composer";
import { deriveSessionExecutionState } from "./sessionExecution";
import {
  expandFileContext,
  isMentionablePath,
  removeChip,
  sliceFileLines,
  upsertChip,
  type FileContextChip,
  type FileMentionHit
} from "./fileContext";
import {
  type ProjectFilePreview,
  type ProjectTreeListing
} from "./projectFileUtils";
import {
  attentionThreadKeys,
  buildFleetSections,
  reconcileActiveTurns,
  type FleetRequestSource,
  type FleetThreadSource
} from "./fleetModel";
import {
  activeTurnIdFromTurns,
  deriveSessionPhase,
  epochSeconds,
  formatTime,
  compareThreadsByRecency,
  hydrateListedThread,
  isUserMessageItem,
  mergeThreadsById,
  patchListedThread,
  nativeThreadId,
  normalizeThread,
  normalizeThreads,
  nowSeconds,
  providerFromThreadKey,
  providerOf,
  statusLabel,
  threadIsActive,
  threadKey,
  threadStatusText,
  threadTitle,
  turnsHaveItems,
  uniqueAppend,
  uniqueItems,
  type Thread,
  type ThreadItem,
  type Turn
} from "./threadModel";
import {
  applyItemsFromTurns,
  clearPendingPrompt,
  discardThreadView,
  getThreadViewState,
  latestPlanTextFor,
  registerTurnItem,
  reconcileQueuePendingPrompt,
  setItemOrderForThread,
  setItemsForThread,
  setPendingPromptForThread,
  setTurnOrderForThread,
  setTurnsForThread,
  threadViewHasConversationHistory,
  useLatestPlanPayload
} from "./threadViewStore";
import { applyTranscriptNotification, terminalKindForTurn } from "./threadNotifications";
import {
  activeQueueTurns,
  queueSummariesByThread,
  queueThreadSummary,
  type QueuedPrompt,
  type QueueSnapshot
} from "./queueModel";
import { RuntimePanel } from "./RuntimePanel";
import { deleteServerFile, uploadPreviewUrl, uploadServerFile } from "./uploads";

type JsonRpcId = string | number;

type ThreadGroup = {
  cwd: string;
  label: string;
  pinned: boolean;
  updatedAt: number;
  threads: Thread[];
};

type MobilePanel = "sessions" | null;
type ThreadLayout = "directories" | "recent";
type ProviderFilter = "all" | ProviderId;
type WorkspaceView = "chat" | "files" | "diff" | "runtime";
type NoticeTone = "info" | "success" | "warning" | "error";
type CommandPanel =
  | "provider"
  | "collab"
  | "model"
  | "permissions"
  | "rename"
  | "mention"
  | "status"
  | "mcp"
  | "plugins"
  | "skills"
  | "experimental"
  | "memories"
  | "diff"
  | null;

type CompletionPopup = {
  id: string;
  title: string;
  detail: string;
};

type GatewayDiagnostic = {
  code: string;
  title: string;
  detail: string;
  retrying: boolean;
  occurredAt: number;
};

type ServerRequest = {
  id: JsonRpcId;
  method: string;
  params?: any;
};

type Reply = {
  type: "reply";
  requestId: string;
  ok: boolean;
  result?: any;
  error?: string;
};

type ProjectInfo = {
  cwd: string;
  realpath: string;
  readable: boolean;
  writable: boolean;
  git?: {
    insideWorkTree: boolean;
    branch: string | null;
    root: string | null;
  };
};

type ProjectDirectoryEntry = {
  name: string;
  path: string;
};

type ProjectDirectoryListing = {
  cwd: string;
  realpath: string;
  parent: string | null;
  entries: ProjectDirectoryEntry[];
};

type ProjectSuggestion = {
  label: string;
  path: string;
};

type DiffSnapshot = {
  root: string;
  tree: string;
};

type TurnDiffBaseline = {
  cwd: string;
  tree: string;
};

type FilePreview = {
  root: string;
  path: string;
  source: "workingTree" | "tree";
  tree: string | null;
  exists: boolean;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
};

type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  image: boolean;
  url: string;
};

type ShortcutHint = {
  keys: string[];
  label: string;
  separator?: string;
};

type Bootstrap = {
  authenticated: boolean;
  authEnabled: boolean;
  codexVersion: string;
  uploads?: { maxBytes: number; maxFiles: number };
  providers?: Partial<Record<ProviderId, ProviderStatus>>;
  defaultCwd?: string;
  codex?: {
    initializeInfo?: unknown;
    collaborationModes?: any[];
    pendingServerRequests?: ServerRequest[];
    diagnostic?: GatewayDiagnostic | null;
  };
  codexError?: string | null;
};

type ProviderCapability =
  | "chat"
  | "queue"
  | "stop"
  | "models"
  | "modes"
  | "rename"
  | "archive"
  | "diff"
  | "approvals"
  | "steer"
  | "fork"
  | "compact"
  | "plugins"
  | "skills"
  | "mcp"
  | "memory"
  | "serviceTier"
  | "reasoning"
  | "images";

type ProviderStatus = {
  id?: ProviderId;
  label?: string;
  version?: string | null;
  available?: boolean;
  availability?: "available" | "unavailable" | "unknown";
  authenticated?: boolean;
  authStatus?: "authenticated" | "missing" | "unknown" | string;
  status?: string | null;
  diagnostic?: string | null;
  capabilities?: Partial<Record<ProviderCapability, boolean>>;
  rateLimit?: unknown;
};

const providerOrder: ProviderId[] = ["codex", "cursor", "claude"];
const providerLabels = AGENT_PROVIDER_LABELS;
const cursorExecutionModeLabel = "Allowlist · no sandbox";
const cursorExecutionModeDescription = "Runs as the server user and may access paths outside the selected workspace.";
const providerCapabilityDefaults: Record<ProviderId, Record<ProviderCapability, boolean>> = {
  codex: {
    chat: true,
    queue: true,
    stop: true,
    models: true,
    modes: true,
    rename: true,
    archive: true,
    diff: true,
    approvals: true,
    steer: true,
    fork: true,
    compact: true,
    plugins: true,
    skills: true,
    mcp: true,
    memory: true,
    serviceTier: true,
    reasoning: true,
    images: true
  },
  cursor: {
    chat: true,
    queue: true,
    stop: true,
    models: true,
    modes: true,
    rename: true,
    archive: true,
    diff: true,
    approvals: false,
    steer: false,
    fork: false,
    compact: false,
    plugins: false,
    skills: false,
    mcp: false,
    memory: false,
    serviceTier: false,
    reasoning: false,
    images: true
  },
  claude: {
    chat: true,
    queue: true,
    stop: true,
    models: true,
    modes: true,
    rename: true,
    archive: true,
    diff: true,
    approvals: false,
    steer: false,
    fork: false,
    compact: false,
    plugins: false,
    skills: false,
    mcp: false,
    memory: false,
    serviceTier: false,
    reasoning: true,
    images: true
  }
};

const defaultCwd = "";
const storageNamespace = "coding-agent-console";
const storageKey = (name: string) => `${storageNamespace}.${name}`;
const promptQueueStorageKey = storageKey("promptQueue.v1");
const threadLayoutStorageKey = storageKey("threadLayout");
const sidebarWidthStorageKey = storageKey("sidebarWidth");
const pinnedThreadsStorageKey = storageKey("pinnedThreads.v1");
const contextWidthStorageKey = storageKey("contextWidth.v1");
const defaultSidebarWidth = 320;
const minSidebarWidth = 240;
const maxSidebarWidth = 520;
const defaultContextWidth = 640;
const minContextWidth = 300;
const maxContextWidth = 1400;
const reservedWorkbenchWidth = 600;
const ProjectFileWorkspace = dynamic(() => import("./ProjectFileWorkspace"), {
  loading: () => <div className="workspaceLoading">Loading project reader…</div>
});

function fetchBootstrap(): Promise<Bootstrap> {
  return fetch(appPath("/api/bootstrap")).then(async (response) => {
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        !response.ok
          ? `Bootstrap failed (${response.status}). If this app is behind a URL prefix (for example /codex_web_cursor/), set NEXT_PUBLIC_BASE_PATH to that exact prefix when building and when starting the server, then run a fresh build.`
          : "Bootstrap response was not valid JSON."
      );
    }
    if (!response.ok) {
      const msg =
        typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `HTTP ${response.status}`;
      throw new Error(msg);
    }
    return data as Bootstrap;
  });
}

const bootstrapPromise: Promise<Bootstrap> | null =
  typeof window === "undefined" ? null : fetchBootstrap();

const skippedTreeDirs = new Set([".git", ".next", "__pycache__", "build", "dist", "node_modules", ".venv", "vendor"]);

async function searchProjectFiles(root: string, query: string, limit = 20): Promise<FileMentionHit[]> {
  const needle = query.trim().toLowerCase();
  const hits: FileMentionHit[] = [];
  const queue: string[] = [""];
  const visited = new Set<string>();
  let scanned = 0;
  while (queue.length && hits.length < limit && scanned < 36) {
    const batch = queue.splice(0, 4).filter((dir) => {
      if (visited.has(dir)) return false;
      visited.add(dir);
      return true;
    });
    if (!batch.length) continue;
    scanned += batch.length;
    const listings = await Promise.all(batch.map((dir) => getJson<ProjectTreeListing>(`/api/projects/tree?${new URLSearchParams({ cwd: root, path: dir })}`)));
    for (const listing of listings) {
    const files = [];
    for (const entry of listing.entries) {
      if (!entry.accessible) continue;
      if (entry.kind === "directory") {
        if (!skippedTreeDirs.has(entry.name) && !entry.name.startsWith(".")) queue.push(entry.path);
        continue;
      }
      files.push(entry);
    }
    const ranked = needle
      ? files.filter((entry) => entry.path.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle))
      : files;
    for (const entry of ranked) {
      if (!isMentionablePath(entry.path)) continue;
      hits.push({ path: entry.path, name: entry.name });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
    }
  }
  return hits;
}

function sameIds(current: string[], next: string[]) {
  return current.length === next.length && current.every((id, index) => id === next[index]);
}

/**
 * Rebuild a record while keeping the previous object for entries whose content
 * is unchanged, so memoized rows survive a full history refresh.
 */
function reuseUnchanged<T>(current: Record<string, T>, incoming: Record<string, T>) {
  const keys = Object.keys(incoming);
  let changed = keys.length !== Object.keys(current).length;
  const next: Record<string, T> = {};

  for (const key of keys) {
    const previous = current[key];
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(incoming[key])) {
      next[key] = previous;
    } else {
      next[key] = incoming[key];
      changed = true;
    }
  }

  return changed ? next : current;
}

function clampSidebarWidth(width: number) {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)));
}

function clampContextWidth(width: number) {
  const viewport = typeof window === "undefined" ? 1600 : window.innerWidth;
  const max = Math.min(maxContextWidth, Math.max(minContextWidth, viewport - reservedWorkbenchWidth));
  return Math.min(max, Math.max(minContextWidth, Math.round(width)));
}

function connectionLabel(state: string) {
  if (state === "online") return "Online";
  if (state === "offline") return "Offline";
  if (state === "error") return "Error";
  return state;
}

function readStoredJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function inferredNoticeTone(message: string): NoticeTone {
  if (!message) return "info";
  if (/failed|\berror\b|exception|timed? out|timeout|refused|disconnected/i.test(message)) return "error";
  if (/stop .* before|unavailable|does not support|cannot|unknown|no active|no idle|not mapped|not selected|not reported/i.test(message)) return "warning";
  if (/created|selected|updated|copied|renamed|archived|restored|started|enabled|disabled|refreshed|closed/i.test(message)) return "success";
  return "info";
}

function waitingThreadIdsFromRequests(requests: ServerRequest[]) {
  const ids = new Set<string>();
  for (const request of requests) {
    const tid = (request.params as { threadId?: string } | undefined)?.threadId;
    const provider = (request.params as { provider?: ProviderId } | undefined)?.provider || "codex";
    if (typeof tid === "string" && tid) ids.add(threadKey(tid, provider));
  }
  return ids;
}

function providerName(provider: ProviderId) {
  return providerLabels[provider];
}

function providerStatus(bootstrap: Bootstrap | null, provider: ProviderId): ProviderStatus {
  const fromBootstrap = bootstrap?.providers?.[provider] || {};
  const availability = fromBootstrap.availability
    || (fromBootstrap.available === true ? "available" : fromBootstrap.available === false ? "unavailable" : undefined)
    || (provider === "codex" ? "available" : "unavailable");
  const authStatus = fromBootstrap.authStatus
    || (fromBootstrap.authenticated === true ? "authenticated" : fromBootstrap.authenticated === false ? "missing" : undefined)
    || (provider === "codex" ? "authenticated" : "unknown");
  return {
    id: provider,
    label: providerName(provider),
    version: provider === "codex" ? bootstrap?.codexVersion : null,
    ...fromBootstrap,
    availability,
    authStatus,
    status: fromBootstrap.status || fromBootstrap.diagnostic || (provider === "codex" ? bootstrap?.codexError || null : null),
    capabilities: {
      ...providerCapabilityDefaults[provider],
      ...(fromBootstrap.capabilities || {})
    }
  };
}

function providerAvailable(status: ProviderStatus) {
  return status.availability === "available";
}

function providerCapability(status: ProviderStatus, capability: ProviderCapability) {
  return status.capabilities?.[capability] !== false;
}

function normalizeDirectoryPath(path: string) {
  const trimmed = path.trim();
  if (trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

function directoryLabel(path: string) {
  const cleanPath = normalizeDirectoryPath(path);
  return cleanPath.split("/").filter(Boolean).at(-1) || path || "Unknown directory";
}

function isUntitledThread(thread: Thread) {
  if (!thread.name?.trim()) return true;
  return providerOf(thread) === "cursor" && Boolean(thread.cwd) && thread.name === directoryLabel(thread.cwd);
}

function isUnusedCursorThread(thread: Thread) {
  return providerOf(thread) === "cursor" && (thread.empty || (isUntitledThread(thread) && !(thread.turns || []).length));
}

function cursorThreadMode(thread: Thread): ModeKind {
  if (thread.mode === "plan" || thread.runtime?.mode === "plan") return "plan";
  if (thread.mode === "ask" || thread.runtime?.mode === "ask") return "ask";
  return "default";
}

function fallbackTitleFromUserText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const segment = normalized.split(/[.?!\n。？！]/)[0] || normalized;
  return segment.slice(0, 28).trim();
}

function withImmediateTitle(thread: Thread, text: string) {
  if (!isUntitledThread(thread)) return thread;
  const title = fallbackTitleFromUserText(text);
  if (!title) return thread;
  return { ...thread, name: title, preview: thread.preview || text };
}

function directoryErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file or directory/i.test(message)) {
    return "That directory does not exist. Check the path and try again.";
  }
  if (/EACCES|permission denied/i.test(message)) {
    return "The server does not have permission to open that directory.";
  }
  return message;
}

function buildThreadGroups(threads: Thread[], pinnedDirs: string[] = []) {
  const groups = new Map<string, ThreadGroup>();
  const pinnedIndex = new Map(pinnedDirs.map((path, index) => [normalizeDirectoryPath(path), index]));
  for (const thread of threads) {
    const groupCwd = normalizeDirectoryPath(thread.cwd || "Unknown directory");
    const group = groups.get(groupCwd) || {
      cwd: groupCwd,
      label: directoryLabel(groupCwd),
      pinned: pinnedIndex.has(groupCwd),
      updatedAt: 0,
      threads: []
    };
    group.updatedAt = Math.max(group.updatedAt, thread.updatedAt || 0);
    group.threads.push(thread);
    groups.set(groupCwd, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftPinned = pinnedIndex.get(left.cwd);
    const rightPinned = pinnedIndex.get(right.cwd);
    if (leftPinned !== undefined || rightPinned !== undefined) {
      if (leftPinned === undefined) return 1;
      if (rightPinned === undefined) return -1;
      return leftPinned - rightPinned;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function compactText(text: string, limit = 120) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function itemText(item: ThreadItem) {
  if (isUserMessageItem(item)) {
    return userMessageParts(item).text;
  }

  if (item.type === "agentMessage" || item.type === "plan") return item.text || "";
  if (item.type === "reasoning") {
    const content = (item.content || []).filter((part): part is string => typeof part === "string");
    return [...(item.summary || []), ...content].join("\n");
  }
  if (item.type === "commandExecution") return outputText(item);
  if (item.type === "toolCall") return String(item.output || item.summary || "");
  if (item.type === "fileChange") return item.output || JSON.stringify(item.changes || [], null, 2);
  if (item.type === "diff") return item.text || "";
  return JSON.stringify(item, null, 2);
}

function itemVersion(item: ThreadItem) {
  if (item.type === "agentMessage" || item.type === "plan" || item.type === "diff") {
    return `${item.id}:${item.type}:${item.text?.length || 0}`;
  }
  if (item.type === "reasoning") {
    return `${item.id}:reasoning:${(item.summary || []).join("").length}:${(item.content || []).join("").length}`;
  }
  if (item.type === "commandExecution") {
    return `${item.id}:command:${item.aggregatedOutput?.length || 0}:${item.exitCode ?? ""}`;
  }
  if (item.type === "fileChange") {
    return `${item.id}:file:${item.output?.length || 0}:${item.changes?.length || 0}`;
  }
  return `${item.id}:${item.type}`;
}

/** Newest agent/plan replies first, then tool/command cards (also newest-first). */
function orderTurnResponseItems(items: ThreadItem[]) {
  const replies = items.filter((item) => item.type === "agentMessage" || item.type === "plan").reverse();
  const tools = items.filter((item) => item.type !== "agentMessage" && item.type !== "plan").reverse();
  return [...replies, ...tools];
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "submit", "reset"].includes(target.type);
}

function inputItems(text: string, attachments: Attachment[] = [], nativeImages = true) {
  return [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...attachments.map((attachment) => ({
      type: "uploadedFile",
      uploadId: attachment.id,
      asImage: nativeImages && attachment.image
    }))
  ];
}

function queueId() {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function requestInputParams(request: ServerRequest) {
  return request.params as {
    threadId: string;
    turnId: string;
    itemId: string;
    questions: Array<{
      id: string;
      header: string;
      question: string;
      isOther: boolean;
      isSecret: boolean;
      options: Array<{ label: string; description: string }> | null;
    }>;
  };
}

function outputText(item: ThreadItem) {
  return item.aggregatedOutput || item.output || "";
}

function changedFiles(item: ThreadItem) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes
    .map((change) => {
      if (!change || typeof change !== "object") return null;
      const record = change as Record<string, unknown>;
      const path = String(record.path || record.file || record.filename || record.absolutePath || "");
      if (!path) return null;
      return {
        path,
        kind: String(record.kind || record.type || record.status || "changed")
      };
    })
    .filter((change): change is { path: string; kind: string } => Boolean(change));
}

function diffFiles(diff: string) {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2] || match[1]);
}

type DiffLine = {
  kind: "add" | "delete" | "hunk" | "meta" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

type DiffSection = {
  file: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
};

function parseUnifiedDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = {
        file: fileMatch[2] || fileMatch[1],
        lines: [{ kind: "meta", text: line, oldLine: null, newLine: null }],
        additions: 0,
        deletions: 0
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = { file: "Diff", lines: [], additions: 0, deletions: 0 };
      sections.push(current);
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      current.lines.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }

    const kind: DiffLine["kind"] =
      line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "delete"
            : line.startsWith("index ") ||
                line.startsWith("new file") ||
                line.startsWith("deleted file") ||
                line.startsWith("rename ") ||
                line.startsWith("similarity ") ||
                line.startsWith("---") ||
                line.startsWith("+++")
              ? "meta"
              : "context";

    if (kind === "add") {
      current.additions += 1;
      current.lines.push({ kind, text: line, oldLine: null, newLine });
      newLine += 1;
    } else if (kind === "delete") {
      current.deletions += 1;
      current.lines.push({ kind, text: line, oldLine, newLine: null });
      oldLine += 1;
    } else if (kind === "context" && (line.startsWith(" ") || line === "")) {
      current.lines.push({ kind, text: line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      current.lines.push({ kind, text: line, oldLine: null, newLine: null });
    }
  }

  return sections;
}

function projectDiffFromItem(item: ThreadItem) {
  return item.projectDiff && typeof item.projectDiff === "object" ? (item.projectDiff as ProjectDiff) : null;
}

function diffStats(item: ThreadItem) {
  const projectDiff = projectDiffFromItem(item);
  if (projectDiff) {
    return {
      files: projectDiff.files.length,
      additions: projectDiff.additions,
      deletions: projectDiff.deletions,
      statuses: [...new Set(projectDiff.files.map((file) => file.status))]
    };
  }

  const text = itemText(item);
  return {
    files: diffFiles(text).length,
    additions: text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: text.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    statuses: []
  };
}

function languageForPath(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "typescript";
  if (["py"].includes(ext)) return "python";
  if (["json", "jsonl"].includes(ext)) return "json";
  if (["md", "mdx"].includes(ext)) return "markdown";
  if (["sh", "bash", "zsh"].includes(ext)) return "shell";
  if (["css", "scss"].includes(ext)) return "css";
  return "text";
}

function codeTokens(line: string, language: string) {
  const patterns =
    language === "json"
      ? /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g
      : language === "markdown"
        ? /(`[^`]+`|^#{1,6}\s.*|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
        : /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|def|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|null|return|true|try|type|while|yield)\b|-?\b\d+(?:\.\d+)?\b)/g;
  const tokens: Array<{ text: string; kind: string }> = [];
  let lastIndex = 0;

  for (const match of line.matchAll(patterns)) {
    const text = match[0];
    const index = match.index || 0;
    if (index > lastIndex) tokens.push({ text: line.slice(lastIndex, index), kind: "plain" });
    const kind = /^["'`]/.test(text)
      ? language === "json" && /"\s*$/.test(text)
        ? "key"
        : "string"
      : /^(\/\/|#|\/\*)/.test(text)
        ? "comment"
        : /^-?\d/.test(text) || ["true", "false", "null"].includes(text)
          ? "number"
          : language === "markdown"
            ? "markup"
            : "keyword";
    tokens.push({ text, kind });
    lastIndex = index + text.length;
  }

  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), kind: "plain" });
  return tokens.length ? tokens : [{ text: line || " ", kind: "plain" }];
}

function compactTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toString();
}

function formatTokenUsage(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const params = value as Record<string, any>;
  const wrapper = params.tokenUsage ?? params.usage ?? params;
  const breakdown = wrapper?.total ?? wrapper?.last ?? wrapper;
  if (!breakdown || typeof breakdown !== "object") return "";
  const input = breakdown.inputTokens ?? breakdown.input_tokens ?? breakdown.promptTokens ?? breakdown.prompt_tokens;
  const output = breakdown.outputTokens ?? breakdown.output_tokens ?? breakdown.completionTokens ?? breakdown.completion_tokens;
  const total = breakdown.totalTokens ?? breakdown.total_tokens ?? breakdown.total;
  const cached = breakdown.cachedInputTokens ?? breakdown.cached_input_tokens;
  const reasoning = breakdown.reasoningOutputTokens ?? breakdown.reasoning_output_tokens;
  const window = wrapper?.modelContextWindow ?? params.modelContextWindow;
  const parts = [
    typeof input === "number" ? `in ${compactTokens(input)}${typeof cached === "number" && cached > 0 ? ` (${compactTokens(cached)} cached)` : ""}` : "",
    typeof output === "number" ? `out ${compactTokens(output)}${typeof reasoning === "number" && reasoning > 0 ? ` (${compactTokens(reasoning)} think)` : ""}` : "",
    typeof total === "number"
      ? `total ${compactTokens(total)}${typeof window === "number" && window > 0 ? ` / ${compactTokens(window)} (${Math.round((total / window) * 100)}%)` : ""}`
      : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function sameStatusType(left: unknown, right: unknown) {
  return statusLabel(left) === statusLabel(right);
}

function SessionModelPill({ model, onClick }: { model: string; onClick: () => void }) {
  const label = model.trim() || "auto";
  return (
    <button
      aria-label={`Model ${label}`}
      className="sessionModelPill"
      title={label}
      type="button"
      onClick={onClick}
    >
      <span>{label}</span>
      <ChevronDown aria-hidden="true" size={14} />
    </button>
  );
}

function UsagePill({
  label,
  rateLimit,
  windowTitle
}: {
  label: string;
  rateLimit: { usedPercent: number; resetsAt: number } | null;
  windowTitle: string;
}) {
  if (!rateLimit) return null;
  const remainingPercent = remainingCodexPercent(rateLimit.usedPercent);
  const percent = formatCodexPercent(remainingPercent);
  const resetShort = formatCodexResetShort(rateLimit.resetsAt);
  const resetFull = formatCodexResetFull(rateLimit.resetsAt);

  return (
    <div
      className="codexUsagePill"
      role="status"
      aria-live="polite"
      title={`${windowTitle} · ${percent}% remaining · resets ${resetFull}`}
    >
      <BarChart3 aria-hidden="true" size={15} />
      <span className="codexUsageCopy">
        <strong><span className="codexUsageProvider">{label}</span> {percent}%</strong>
        <small className="codexUsageRemaining">remaining</small>
        <small className="codexUsageReset">Reset {resetShort}</small>
      </span>
      <span className="codexUsageMeter" aria-hidden="true">
        <span style={{ width: `${remainingPercent}%` }} />
      </span>
    </div>
  );
}

function ClaudeUsagePill({ rateLimit }: { rateLimit: StandardClaudeRateLimit | null }) {
  if (!rateLimit) return null;
  const weekly = rateLimit.weekly;
  const title = [
    formatClaudeUsageLabel(rateLimit),
    `5h ${formatClaudeResetRelative(rateLimit.session.resetsAt)}`,
    weekly ? `Week ${formatClaudeWeekReset(weekly.resetsAt)}` : ""
  ].filter(Boolean).join(" · ");

  return (
    <div className="claudeUsagePill" role="status" aria-live="polite" title={title}>
      <span className="splitUsageCopy">
        <strong>5h {formatCodexPercent(rateLimit.session.usedPercent)}%</strong>
        <small className="codexUsageReset">{formatClaudeResetRelative(rateLimit.session.resetsAt)}</small>
        <strong>Week {formatCodexPercent(weekly?.usedPercent ?? 0)}%</strong>
        {weekly ? <small className="codexUsageReset">{formatClaudeWeekReset(weekly.resetsAt)}</small> : null}
      </span>
    </div>
  );
}

function CursorUsagePill({ usage }: { usage: CursorUsageSnapshot | null }) {
  if (!usage) return null;
  return (
    <div className="cursorUsagePill" role="status" aria-live="polite" title={formatCursorUsageTitle(usage)}>
      <span className="splitUsageCopy">
        <strong>Models {formatCursorUsedPercent(usage.cursorModels.usedPercent)}%</strong>
        <strong>API {formatCursorUsedPercent(usage.otherModels.usedPercent)}%</strong>
        <small className="codexUsageReset">Reset {formatCodexResetShort(usage.resetsAt)}</small>
      </span>
    </div>
  );
}

function shortJson(value: unknown, limit = 180) {
  const text =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? "default"
        : JSON.stringify(value);
  return compactText(text || "default", limit);
}

function looksUnsupportedMethod(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /method|not found|unknown|unsupported|review\/start/i.test(message);
}

function responseData(value: any) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.files)) return value.files;
  return [];
}

function modelId(model: any) {
  return String(model?.model || model?.id || "");
}

function modelTitle(model: any) {
  const id = modelId(model);
  const displayName = typeof model?.displayName === "string" ? model.displayName.trim() : "";
  if (displayName) return displayName;
  return id || String(model?.name || "Unknown model");
}

function modelDescription(model: any) {
  const id = modelId(model);
  const description = typeof model?.description === "string" ? model.description.trim() : "";
  if (description && description !== id) return description;
  return "";
}

function modelReasoningOptions(model: any): ReasoningEffort[] {
  const options = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  return options
    .map((option: any) => option?.reasoningEffort)
    .filter((value: unknown): value is ReasoningEffort => typeof value === "string");
}

function approvalPolicyValue(value: ApprovalPolicy) {
  return typeof value === "string" ? value : value ? "granular" : "";
}

function sandboxModeValue(value: SandboxMode) {
  return value || "";
}

function selectedRoot(thread: Thread | null, project: ProjectInfo | null, cwd: string) {
  return thread?.cwd || project?.realpath || cwd;
}

function panelTitle(panel: Exclude<CommandPanel, null>) {
  const titles: Record<Exclude<CommandPanel, null>, string> = {
    provider: "Provider",
    collab: "Collaboration Mode",
    model: "Model",
    permissions: "Permissions",
    rename: "Rename Session",
    mention: "Mention File",
    status: "Status",
    mcp: "MCP Servers",
    plugins: "Plugins",
    skills: "Skills",
    experimental: "Experimental Features",
    memories: "Memories",
    diff: "Diff"
  };
  return titles[panel];
}

function commandTextFromRequest(request: ServerRequest) {
  const params = request.params && typeof request.params === "object" ? (request.params as any) : {};
  const command = params.command;
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.every((item) => typeof item === "string")) return "";

  const [program, flag, script] = command;
  const executable = program?.split("/").filter(Boolean).at(-1);
  if ((executable === "bash" || executable === "sh" || executable === "zsh") && flag === "-lc" && script) {
    return script;
  }

  return command.join(" ");
}

function shellWords(command: string) {
  return command.match(/"([^"\\]|\\.)*"|'[^']*'|[^\s;&|()]+/g) || [];
}

function executableIndex(tokens: string[]) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const command = token.split("/").filter(Boolean).at(-1) || token;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || ["command", "builtin", "time"].includes(command)) {
      index++;
      continue;
    }
    if (command === "sudo") {
      index++;
      while (tokens[index]?.startsWith("-")) index++;
      continue;
    }
    if (command === "env") {
      index++;
      while (tokens[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || "")) index++;
      continue;
    }
    return index;
  }
  return -1;
}

function needsPerRequestApproval(request: ServerRequest) {
  const command = commandTextFromRequest(request);
  if (!command) return false;

  return command.split(/\s*(?:&&|\|\||[;|])\s*/g).some((segment) => {
    const tokens = shellWords(segment);
    const index = executableIndex(tokens);
    if (index === -1) return false;

    const executable = tokens[index].split("/").filter(Boolean).at(-1) || tokens[index];
    if (executable === "rm") return true;
    if (executable !== "git") return false;

    for (let next = index + 1; next < tokens.length; next++) {
      const token = tokens[next];
      if (token === "-C") {
        next++;
        continue;
      }
      if (token.startsWith("-")) continue;
      return ["checkout", "clean", "reset", "restore", "switch"].includes(token);
    }

    return false;
  });
}

function requestRecord(request: ServerRequest) {
  return request.params && typeof request.params === "object" ? (request.params as Record<string, any>) : {};
}

function approvalKind(request: ServerRequest) {
  if (request.method.includes("commandExecution") || request.method === "execCommandApproval") return "command";
  if (request.method.includes("fileChange") || request.method === "applyPatchApproval") return "file";
  if (request.method === "mcpServer/elicitation/request") return "mcp";
  if (request.method === "item/permissions/requestApproval") return "permission";
  return "approval";
}

function approvalTitle(request: ServerRequest) {
  const kind = approvalKind(request);
  if (kind === "command") return "Command approval";
  if (kind === "file") return "File change approval";
  if (kind === "mcp") return "MCP approval";
  if (kind === "permission") return "Permission approval";
  return "Codex approval";
}

function approvalSummary(request: ServerRequest) {
  const params = requestRecord(request);
  const kind = approvalKind(request);
  if (kind === "command") return commandTextFromRequest(request) || "Codex wants to run a shell command.";
  if (kind === "file") {
    const files = approvalFiles(request);
    return files.length ? `${files.length} file${files.length === 1 ? "" : "s"} require review.` : "Codex wants to apply file changes.";
  }
  if (kind === "mcp") return String(params.message || params.prompt || params.serverName || "Codex wants to continue an MCP tool flow.");
  if (kind === "permission") return String(params.reason || params.message || "Codex wants additional permissions.");
  return "Codex needs approval to continue.";
}

function approvalFiles(request: ServerRequest) {
  const params = requestRecord(request);
  const direct = [params.path, params.file, params.filename].filter((item): item is string => typeof item === "string");
  const changes = Array.isArray(params.changes)
    ? params.changes
        .map((change: any) => String(change?.path || change?.file || change?.filename || ""))
        .filter(Boolean)
    : [];
  const diff = typeof params.diff === "string" ? diffFiles(params.diff) : [];
  return [...direct, ...changes, ...diff].filter((item, index, all) => all.indexOf(item) === index);
}

function riskLabel(request: ServerRequest) {
  if (needsPerRequestApproval(request)) return "per-request review";
  const command = commandTextFromRequest(request);
  if (command) return "command";
  if (approvalKind(request) === "file") return "writes files";
  if (approvalKind(request) === "mcp") return "tool continuation";
  return "approval";
}

function ShortcutHints({ items }: { items: ShortcutHint[] }) {
  return (
    <div className="shortcutHints">
      {items.map((item) => (
        <span key={`${item.keys.join(item.separator || "+")}-${item.label}`}>
          {item.keys.map((key, index) => (
            <Fragment key={`${key}-${index}`}>
              {index > 0 ? item.separator || " + " : null}
              <kbd>{key}</kbd>
            </Fragment>
          ))}{" "}
          {item.label}
        </span>
      ))}
    </div>
  );
}

export default function Home() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [wsState, setWsState] = useState("offline");
  const [cwd, setCwd] = useState(defaultCwd);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectError, setProjectError] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("codex");
  const [runtimeSettingsByProvider, setRuntimeSettingsByProvider] = useState<Record<ProviderId, SessionRuntimeSettings>>({
    codex: providerRuntimeDefaults("codex"),
    cursor: providerRuntimeDefaults("cursor"),
    claude: providerRuntimeDefaults("claude")
  });
  const [modeOverrideByThread, setModeOverrideByThread] = useState<Record<string, ModeKind>>({});
  const [pendingRequests, setPendingRequests] = useState<ServerRequest[]>([]);
  const [activeTurnIdsByThread, setActiveTurnIdsByThread] = useState<Record<string, string>>({});
  const [pendingLiveThreadKeys, setPendingLiveThreadKeys] = useState<string[]>([]);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>({ items: [], threads: [] });
  const [queueAction, setQueueAction] = useState<string | null>(null);
  const [composerSubmitting, setComposerSubmitting] = useState(false);
  const [planSubmitting, setPlanSubmitting] = useState(false);
  const [sessionCreating, setSessionCreating] = useState(false);
  const [tokenUsageByThread, setTokenUsageByThread] = useState<Record<string, unknown>>({});
  const [codexRateLimit, setCodexRateLimit] = useState<StandardCodexRateLimit | null>(null);
  const [claudeRateLimit, setClaudeRateLimit] = useState<StandardClaudeRateLimit | null>(null);
  const [cursorUsage, setCursorUsage] = useState<CursorUsageSnapshot | null>(null);
  const [attachmentsByThread, setAttachmentsByThread] = useState<Record<string, Attachment[]>>({});
  const [uploadsInProgress, setUploadsInProgress] = useState(0);
  const [notice, setNoticeMessage] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  const [gatewayDiagnostic, setGatewayDiagnostic] = useState<GatewayDiagnostic | null>(null);
  const [historyLoadingThreadId, setHistoryLoadingThreadId] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [completionPopup, setCompletionPopup] = useState<CompletionPopup | null>(null);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [pinnedDirs, setPinnedDirs] = useState<string[]>([]);
  const [pinnedThreadKeys, setPinnedThreadKeys] = useState<string[]>([]);
  const [collapsedThreadGroups, setCollapsedThreadGroups] = useState<string[]>([]);
  const [threadLayout, setThreadLayout] = useState<ThreadLayout>("directories");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [contextWidth, setContextWidth] = useState(defaultContextWidth);
  const [contextResizing, setContextResizing] = useState(false);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [sessionManagerThreads, setSessionManagerThreads] = useState<Thread[]>([]);
  const [sessionManagerCursor, setSessionManagerCursor] = useState<string | null>(null);
  const [sessionManagerSearch, setSessionManagerSearch] = useState("");
  const [sessionManagerArchived, setSessionManagerArchived] = useState(false);
  const [sessionManagerProviderFilter, setSessionManagerProviderFilter] = useState<ProviderFilter>("all");
  const [sessionManagerLoading, setSessionManagerLoading] = useState(false);
  const [sessionManagerError, setSessionManagerError] = useState("");
  const [sessionManagerBusy, setSessionManagerBusy] = useState<string | null>(null);
  const [collapsedSessionManagerGroups, setCollapsedSessionManagerGroups] = useState<string[]>([]);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [workspaceFileRequest, setWorkspaceFileRequest] = useState<string | null>(null);
  const [fileContexts, setFileContexts] = useState<FileContextChip[]>([]);
  const [fileContextHighlight, setFileContextHighlight] = useState<{ path: string; start: number; end: number } | null>(null);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [fileMentions, setFileMentions] = useState<FileMentionHit[]>([]);
  const [workspaceDiff, setWorkspaceDiff] = useState<ProjectDiff | null>(null);
  const [workspaceDiffKind, setWorkspaceDiffKind] = useState<"working" | "turn">("working");
  const [workspaceDiffLoading, setWorkspaceDiffLoading] = useState(false);
  const [workspaceDiffError, setWorkspaceDiffError] = useState("");
  const [commandPanel, setCommandPanel] = useState<CommandPanel>(null);
  const [commandPanelData, setCommandPanelData] = useState<any>(null);
  const [commandPanelLoading, setCommandPanelLoading] = useState(false);
  const [commandPanelError, setCommandPanelError] = useState("");
  const [permissionDraft, setPermissionDraft] = useState<PermissionDraft>(runtimePermissionDraft(defaultRuntimeSettings));
  const [renameValue, setRenameValue] = useState("");
  const [mentionQuery, setMentionQuery] = useState("");
  const [expandedMcpServers, setExpandedMcpServers] = useState<Set<string>>(() => new Set());
  const [draggingPinnedDir, setDraggingPinnedDir] = useState<string | null>(null);
  const [dropTargetPinnedDir, setDropTargetPinnedDir] = useState<string | null>(null);
  const autoNamedThreadIds = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const bootstrapRef = useRef<Bootstrap | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const knownThreadIdsRef = useRef<Set<string>>(new Set());
  /** Thread keys currently resident in Codex app-server memory (warm / skip cold resume). */
  const warmThreadIdsRef = useRef<Set<string>>(new Set());
  const dismissedThreadIdsRef = useRef<Set<string>>(new Set());
  const composerRef = useRef<ComposerHandle | null>(null);
  const draftsRef = useRef<Record<string, string>>({});
  const mentionLoadGen = useRef(0);
  const startProviderActionRef = useRef<(provider: ProviderId) => void>(() => undefined);
  const providerDetailsActionRef = useRef<() => void>(() => undefined);
  const queueSnapshotRef = useRef(queueSnapshot);
  queueSnapshotRef.current = queueSnapshot;
  const restoredCwdResolved = useRef(false);
  const pendingReplies = useRef(new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: number;
  }>());
  const legacyQueueMigrationRunning = useRef(false);
  const runtimeInitialized = useRef(false);
  const reconnectAttempt = useRef(0);
  const requestSeq = useRef(1);
  const sessionCreatingRef = useRef(false);
  const sessionManagerRequestSeq = useRef(0);
  const sessionRefreshRequestSeq = useRef(0);
  const turnDiffBaselines = useRef(new Map<string, TurnDiffBaseline>());
  const completedTurnNotifications = useRef(new Set<string>());
  const completionPopupTimer = useRef<number | null>(null);
  const uploadSlotsInUse = useRef(0);
  const appShellRef = useRef<HTMLElement | null>(null);

  function setNotice(message: string, tone?: NoticeTone) {
    setNoticeMessage(message);
    setNoticeTone(message ? tone || inferredNoticeTone(message) : "info");
  }

  const currentProviderStatus = providerStatus(bootstrap, selectedProvider);
  bootstrapRef.current = bootstrap;
  const providerProtocolEnabled = Boolean(bootstrap?.providers);
  const selectedThreadProvider = providerOf(selectedThread);
  const selectedThreadProviderStatus = providerStatus(bootstrap, selectedThreadProvider);
  const runtimeSettings = runtimeSettingsByProvider[selectedProvider] || providerRuntimeDefaults(selectedProvider);
  const currentCapabilities = currentProviderStatus.capabilities || providerCapabilityDefaults[selectedProvider];
  const supportsApprovals = providerCapability(currentProviderStatus, "approvals");
  const supportsSteer = providerCapability(currentProviderStatus, "steer");
  const supportsReasoning = providerCapability(currentProviderStatus, "reasoning");
  const supportsServiceTier = providerCapability(currentProviderStatus, "serviceTier");
  const isCursorProvider = selectedProvider === "cursor";
  const currentThreadKey = threadKey(selectedThread);
  const tokenUsage = tokenUsageByThread[currentThreadKey] ?? null;
  const setPendingPrompt = useCallback((value: string) => {
    setPendingPromptForThread(selectedThreadIdRef.current || "", value);
  }, []);
  const markThreadLive = useCallback((threadId: string) => {
    if (!threadId) return;
    setPendingLiveThreadKeys((current) => (current.includes(threadId) ? current : [...current, threadId]));
  }, []);
  const clearThreadLive = useCallback((threadId: string) => {
    if (!threadId) return;
    setPendingLiveThreadKeys((current) => (current.includes(threadId) ? current.filter((key) => key !== threadId) : current));
  }, []);
  const discardThreadBucket = useCallback((threadId: string) => {
    if (!threadId) return;
    discardThreadView(threadId);
    setAttachmentsByThread((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (threadId in draftsRef.current) {
      const next = { ...draftsRef.current };
      delete next[threadId];
      draftsRef.current = next;
    }
    setTokenUsageByThread((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setModeOverrideByThread((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);

  const reconcileModeOverrides = useCallback((incoming: Thread[]) => {
    if (!incoming.length) return;
    setModeOverrideByThread((current) => {
      let next = current;
      for (const thread of incoming) {
        const key = threadKey(thread);
        if (!current[key] || current[key] !== sessionModeForThread(thread, "default")) continue;
        if (next === current) next = { ...current };
        delete next[key];
      }
      return next;
    });
  }, []);

  const commitSessionMode = useCallback((key: string, nextMode: ModeKind) => {
    const applyMode = (thread: Thread): Thread => ({
      ...thread,
      mode: nextMode,
      runtime: thread.runtime ? { ...thread.runtime, mode: nextMode } : thread.runtime
    });
    setSelectedThread((current) => current && threadKey(current) === key ? applyMode(current) : current);
    setThreads((current) => current.map((thread) => threadKey(thread) === key ? applyMode(thread) : thread));
    setModeOverrideByThread((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const sessionModel = runtimeSettings.model;
  const activeTurnId = selectedThread ? activeTurnIdsByThread[threadKey(selectedThread)] || null : null;
  const displayedThreadRuntime = selectedThread?.runtime || null;
  const displayedModel = displayedThreadRuntime?.model || sessionModel;
  const displayedReasoning = displayedThreadRuntime?.reasoningEffort ?? runtimeSettings.reasoningEffort;
  const displayedServiceTier = displayedThreadRuntime?.serviceTier || runtimeSettings.serviceTier || "default";
  const displayedFastMode = isFastServiceTier(displayedServiceTier);
  const latestPlanText = latestPlanTextFor(currentThreadKey);
  const queueSummaryByThread = useMemo(() => queueSummariesByThread(queueSnapshot), [queueSnapshot]);
  const currentQueueSummary = useMemo(
    () => queueThreadSummary(queueSnapshot, currentThreadKey),
    [currentThreadKey, queueSnapshot]
  );
  const waitingThreadIds = useMemo(() => waitingThreadIdsFromRequests(pendingRequests), [pendingRequests]);
  const serverSelectedMode = selectedThread ? sessionModeForThread(selectedThread, "default") : runtimeSettings.mode;
  const latestPlanPayload = useLatestPlanPayload(
    currentThreadKey,
    Boolean(selectedThread && serverSelectedMode === "plan" && !activeTurnId)
  );
  const sessionExecutionState = useMemo(
    () => deriveSessionExecutionState({
      thread: selectedThread,
      provider: selectedThread ? selectedThreadProvider : selectedProvider,
      providerDefaultMode: runtimeSettings.mode,
      modeOverride: currentThreadKey ? modeOverrideByThread[currentThreadKey] : null,
      activeTurnId,
      queueSummary: currentQueueSummary,
      waitingForInput: Boolean(
        currentThreadKey
        && (waitingThreadIds.has(currentThreadKey) || waitingThreadIds.has(selectedThread?.nativeId || ""))
      ),
      planPayload: latestPlanPayload
    }),
    [
      activeTurnId,
      currentQueueSummary,
      currentThreadKey,
      latestPlanPayload,
      modeOverrideByThread,
      runtimeSettings.mode,
      selectedProvider,
      selectedThread,
      selectedThreadProvider,
      waitingThreadIds
    ]
  );
  const mode = sessionExecutionState.mode;
  const currentQueuePaused = Boolean(currentQueueSummary.threadState?.paused);
  const attachmentBucket = currentThreadKey || `${selectedProvider}:new`;
  const attachments = attachmentsByThread[attachmentBucket] || [];
  const uploadMaxBytes = bootstrap?.uploads?.maxBytes || 50 * 1024 * 1024;
  const uploadMaxFiles = bootstrap?.uploads?.maxFiles || 8;

  const activeRequest = pendingRequests[0] || null;
  const activeRequestProvider = ((activeRequest?.params as { provider?: ProviderId } | undefined)?.provider || "codex") as ProviderId;
  const orderedThreads = useMemo(
    () => threads.filter((thread) => !thread.empty || threadKey(thread) === currentThreadKey),
    [currentThreadKey, threads]
  );
  const selectedThreadIndex = useMemo(
    () => currentThreadKey ? orderedThreads.findIndex((thread) => threadKey(thread) === currentThreadKey) : -1,
    [currentThreadKey, orderedThreads]
  );
  const newerThread = selectedThreadIndex > 0 ? orderedThreads[selectedThreadIndex - 1] : null;
  const olderThread = selectedThreadIndex >= 0 && selectedThreadIndex + 1 < orderedThreads.length
    ? orderedThreads[selectedThreadIndex + 1]
    : null;
  const orderedSessionManagerThreads = useMemo(
    () => [...sessionManagerThreads].sort(compareThreadsByRecency),
    [sessionManagerThreads]
  );
  const sessionManagerGroups = useMemo<ThreadGroup[]>(
    () => buildThreadGroups(orderedSessionManagerThreads),
    [orderedSessionManagerThreads]
  );
  const pinnedDirSet = useMemo(() => new Set(pinnedDirs.map(normalizeDirectoryPath)), [pinnedDirs]);
  const collapsedThreadGroupSet = useMemo(() => new Set(collapsedThreadGroups), [collapsedThreadGroups]);
  const collapsedSessionManagerGroupSet = useMemo(
    () => new Set(collapsedSessionManagerGroups),
    [collapsedSessionManagerGroups]
  );
  const pinTarget = normalizeDirectoryPath(project?.realpath || cwd);
  const workspaceRoot = selectedRoot(selectedThread, project, cwd);
  const pinTargetPinned = Boolean(pinTarget && pinnedDirSet.has(pinTarget));
  const fleetSources = useMemo<FleetThreadSource[]>(
    () => orderedThreads.map((thread) => {
      const key = threadKey(thread);
      const queue = queueSummaryByThread.get(key) || queueThreadSummary(queueSnapshot, key);
      const provider = providerOf(thread);
      const execution = deriveSessionExecutionState({
        thread,
        provider,
        providerDefaultMode: runtimeSettingsByProvider[provider]?.mode || providerRuntimeDefaults(provider).mode,
        modeOverride: modeOverrideByThread[key],
        activeTurnId: activeTurnIdsByThread[key] || null,
        queueSummary: queue,
        waitingForInput: waitingThreadIds.has(key) || waitingThreadIds.has(thread.nativeId || "")
      });
      return {
        key,
        provider,
        title: threadTitle(thread),
        cwd: thread.cwd,
        directory: directoryLabel(thread.cwd),
        updatedAt: thread.updatedAt || 0,
        statusLabel: statusLabel(thread.status),
        model: thread.runtime?.model,
        reasoningEffort: thread.runtime?.reasoningEffort,
        serviceTier: thread.runtime ? thread.runtime.serviceTier || "default" : null,
        mode: execution.mode,
        queueCount: queue?.items.length || 0,
        queuePaused: Boolean(queue?.threadState?.paused)
      };
    }),
    [activeTurnIdsByThread, modeOverrideByThread, orderedThreads, queueSnapshot, queueSummaryByThread, runtimeSettingsByProvider, waitingThreadIds]
  );
  const fleetRequests = useMemo<FleetRequestSource[]>(
    () => pendingRequests.map((request) => {
      const params = request.params as { threadId?: string; provider?: ProviderId } | undefined;
      return {
        threadKey: params?.threadId ? threadKey(params.threadId, params.provider || "codex") : "",
        label: request.method === "item/tool/requestUserInput" ? "Question" : approvalTitle(request)
      };
    }),
    [pendingRequests]
  );
  const fleetSections = useMemo(
    () => buildFleetSections({
      threads: fleetSources,
      requests: fleetRequests,
      activeThreadKeys: Object.entries(activeTurnIdsByThread).filter(([, turnId]) => Boolean(turnId)).map(([key]) => key),
      pendingLiveThreadKeys,
      pinnedThreadKeys
    }),
    [activeTurnIdsByThread, fleetRequests, fleetSources, pendingLiveThreadKeys, pinnedThreadKeys]
  );
  const fleetByKey = useMemo(() => new Map(fleetSections.all.map((thread) => [thread.key, thread])), [fleetSections.all]);
  const liveThreadKeys = useMemo(() => attentionThreadKeys(fleetSections), [fleetSections]);
  const listedThreads = useMemo(
    () => orderedThreads.filter((thread) => !liveThreadKeys.has(threadKey(thread))),
    [liveThreadKeys, orderedThreads]
  );
  const listedThreadGroups = useMemo<ThreadGroup[]>(
    () => buildThreadGroups(listedThreads, pinnedDirs),
    [listedThreads, pinnedDirs]
  );
  const threadByKey = useMemo(() => new Map(orderedThreads.map((thread) => [threadKey(thread), thread])), [orderedThreads]);
  const mcpRecentByServer = useMemo(() => {
    const result: Record<string, Array<{ id: string; tool: string; status: string }>> = {};
    if (!selectedThread) return result;
    const view = getThreadViewState();
    const itemsForThread = view.itemsByThread[threadKey(selectedThread)] || {};
    const orderForThread = view.itemOrderByThread[threadKey(selectedThread)] || [];
    for (const id of orderForThread) {
      const item = itemsForThread[id] as ThreadItem & { server?: string; tool?: string } | undefined;
      if (!item || item.type !== "mcpToolCall") continue;
      const server = String(item.server || "");
      if (!server) continue;
      const list = result[server] || (result[server] = []);
      list.push({
        id: String(item.id),
        tool: String(item.tool || "unknown"),
        status: String(item.status || "unknown")
      });
    }
    for (const key of Object.keys(result)) {
      result[key] = result[key].slice(-3).reverse();
    }
    return result;
  }, [selectedThread, commandPanel, workspaceView]);
  const currentProjectLabel = directoryLabel(project?.realpath || cwd);
  const usageLabel = formatTokenUsage(tokenUsage);
  const startProviderAvailability = providerOrder
    .map((provider) => providerAvailable(providerStatus(bootstrap, provider)))
    .join(":");
  const startProviders = useMemo(
    () =>
      providerOrder.map((id) => ({
        id,
        label: providerName(id),
        available: providerAvailable(providerStatus(bootstrap, id))
      })),
    [startProviderAvailability]
  );
  const onShowAllHistory = useCallback(() => setShowAllHistory(true), []);
  const onStartProvider = useCallback((provider: ProviderId) => {
    startProviderActionRef.current(provider);
  }, []);
  const onProviderDetails = useCallback(() => {
    providerDetailsActionRef.current();
  }, []);
  const slashContext = useMemo(
    () => ({ hasThread: Boolean(selectedThread), activeTurn: Boolean(activeTurnId), provider: selectedProvider }),
    [activeTurnId, selectedProvider, selectedThread]
  );

  const call = useCallback((message: Omit<any, "requestId">) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket is not connected."));

    const requestId = `web-${requestSeq.current++}`;
    return new Promise<any>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!pendingReplies.current.has(requestId)) return;
        pendingReplies.current.delete(requestId);
        reject(new Error("Request timed out."));
      }, 120_000);
      pendingReplies.current.set(requestId, { resolve, reject, timeout });
      try {
        ws.send(JSON.stringify({ ...message, requestId }));
      } catch (error) {
        window.clearTimeout(timeout);
        pendingReplies.current.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, []);

  const codex = useCallback(
    (method: string, params?: unknown) => call({ type: "codex:request", method, params }),
    [call]
  );

  const agent = useCallback(
    (provider: ProviderId, method: string, params?: unknown) => {
      const wireMethod = provider === "cursor" ? cursorMethod(method) : method;
      const baseParams = params && typeof params === "object" && !Array.isArray(params)
        ? { ...params, provider }
        : params;
      const nextParams = provider === "cursor" ? cursorParams(method, baseParams) : baseParams;
      if (provider === "codex" && !providerProtocolEnabled) {
        return call({ type: "codex:request", method, params: nextParams });
      }
      return call({ type: "agent:request", provider, method: wireMethod, params: nextParams }).then((response) =>
        normalizeAgentResponse(method, response, provider)
      );
    },
    [call, providerProtocolEnabled]
  );

  const sessionAgent = useCallback(
    (method: string, params?: unknown, provider: ProviderId = selectedProvider) => agent(provider, method, params),
    [agent, selectedProvider]
  );

  const updateActiveTurn = useCallback((threadId?: string, turnId?: string | null, expectedTurnId?: string) => {
    if (!threadId) return;
    setActiveTurnIdsByThread((current) => {
      if (expectedTurnId && current[threadId] !== expectedTurnId) return current;
      if (!turnId) {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      if (current[threadId] === turnId) return current;
      return { ...current, [threadId]: turnId };
    });
  }, []);

  async function enqueuePrompt(
    threadId: string,
    text: string,
    settings?: SessionRuntimeSettings,
    threadOverride?: Thread,
    identity: { id?: string; createdAt?: number } = {}
  ) {
    const provider = providerFromThreadKey(threadId);
    const thread = threadOverride || threadByKey.get(threadId) || (selectedThread && threadKey(selectedThread) === threadId ? selectedThread : null);
    if (!thread) throw new Error("Queue target thread is not loaded.");
    const runtime = settings || runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider);
    const item = {
      id: identity.id || queueId(),
      provider,
      threadKey: threadId,
      threadId: nativeThreadId(thread),
      text,
      cwd: thread.cwd || selectedRoot(thread, project, cwd),
      threadParams: runtimeThreadParams(runtime),
      turnParams: {
        ...runtimeTurnParams(runtime),
        ...(provider === "codex"
          ? { collaborationMode: buildCollaborationMode(runtime, bootstrap?.codex?.collaborationModes || [], runtime.model, runtime.mode) }
          : {})
      },
      createdAt: identity.createdAt || nowSeconds()
    };
    markThreadLive(threadId);
    try {
      const response = await call({ type: "queue:enqueue", item });
      if (response?.snapshot) setQueueSnapshot(response.snapshot);
      commitSessionMode(threadId, runtime.mode);
      return response?.item as QueuedPrompt | undefined;
    } catch (error) {
      clearThreadLive(threadId);
      throw error;
    }
  }

  async function clearQueuedPrompts(threadId: string) {
    await call({ type: "queue:clear", threadKey: threadId });
  }

  async function refreshQueueSnapshot() {
    const snapshot = await call({ type: "queue:list" });
    if (snapshot) applyQueueSnapshot(snapshot);
  }

  async function retryQueuedPrompt(item: QueuedPrompt) {
    setQueueAction(`retry:${item.id}`);
    try {
      await call({ type: "queue:retry", queueId: item.id });
      await refreshQueueSnapshot();
      setNotice("Task returned to the server queue.", "success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setQueueAction(null);
    }
  }

  async function removeQueuedPrompt(item: QueuedPrompt) {
    setQueueAction(`remove:${item.id}`);
    try {
      await call({ type: "queue:cancel", queueId: item.id });
      await refreshQueueSnapshot();
      setNotice("Queued task removed.", "success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setQueueAction(null);
    }
  }

  function clearSelectedThreadState(threadId?: string) {
    const selectedThreadId = selectedThreadIdRef.current;
    if (threadId && selectedThreadId !== threadId) return;
    if (selectedThreadId) updateActiveTurn(selectedThreadId, null);
    selectedThreadIdRef.current = null;
    setSelectedThread(null);
    if (threadId) discardThreadBucket(threadId);
  }

  function removeArchivedThread(threadId: string) {
    warmThreadIdsRef.current.delete(threadId);
    removePinnedThread(threadId);
    setThreads((current) => current.filter((thread) => threadKey(thread) !== threadId));
    setSessionManagerThreads((current) => current.filter((thread) => threadKey(thread) !== threadId));
    void clearQueuedPrompts(threadId).catch(() => undefined);
    clearSelectedThreadState(threadId);
  }

  function restoreUnarchivedThread(thread: Thread) {
    knownThreadIdsRef.current.add(threadKey(thread));
    dismissedThreadIdsRef.current.delete(threadKey(thread));
    setThreads((current) => mergeThreadsById(current, [thread]));
    setSessionManagerThreads((current) => current.filter((item) => threadKey(item) !== threadKey(thread)));
  }

  const refreshSelectedThread = useCallback(async (expectedThreadId?: string | null) => {
    const threadId = expectedThreadId || selectedThreadIdRef.current;
    if (!threadId) return;
    const provider = providerFromThreadKey(threadId);

    const response = await agent(provider, "thread/read", { threadId: nativeThreadId(threadId), includeTurns: true, provider });
    if (selectedThreadIdRef.current !== threadId) return;
    const refreshed = normalizeThread({ ...(response.thread as Thread), provider });
    if (!refreshed?.id) return;

    setSelectedThread(refreshed);
    const queueTurnId = activeQueueTurns(queueSnapshotRef.current).get(threadId) || null;
    updateActiveTurn(threadId, queueTurnId || activeTurnIdFromTurns(refreshed.turns || []));
    setThreads((current) => patchListedThread(current, refreshed, threadId));
    reconcileModeOverrides([refreshed]);
    applyItemsFromTurns(threadId, refreshed.turns || []);
  }, [agent, applyItemsFromTurns, reconcileModeOverrides, updateActiveTurn]);

  const loadThreads = useCallback(async () => {
    const availableProviders = providerOrder.filter((provider) => providerAvailable(providerStatus(bootstrapRef.current, provider)));
    const targets = availableProviders.length ? availableProviders : ["codex" as ProviderId];
    const results = await Promise.all(
      targets.map((provider) =>
        agent(provider, "thread/list", { limit: 50, sortDirection: "desc", provider })
          .then((response) => normalizeThreads(response.data || []))
          .catch((error) => {
            if (provider === "codex") throw error;
            return [] as Thread[];
          })
      )
    );
    const nextThreads = mergeThreadsById([], results.flat()).filter(
      (thread) => !dismissedThreadIdsRef.current.has(threadKey(thread))
    );
    const snapshots = nextThreads.map((thread) => ({
      key: threadKey(thread),
      statusLabel: statusLabel(thread.status)
    }));
    const liveQueue = queueSnapshotRef.current;
    const keepKeys = activeQueueTurns(liveQueue).keys();
    setActiveTurnIdsByThread((current) => {
      const reconciled = reconcileActiveTurns(current, snapshots, keepKeys);
      let next = reconciled;
      for (const [threadKeyValue, runId] of activeQueueTurns(liveQueue)) {
        if (next[threadKeyValue] === runId) continue;
        if (next === reconciled) next = { ...reconciled };
        next[threadKeyValue] = runId;
      }
      return next;
    });
    setSelectedThread((current) => {
      if (!current) return current;
      const latest = nextThreads.find((thread) => threadKey(thread) === threadKey(current));
      if (!latest) return current;
      return { ...current, ...latest, turns: current.turns?.length ? current.turns : latest.turns };
    });
    reconcileModeOverrides(nextThreads);
    setThreads(nextThreads);
  }, [agent, reconcileModeOverrides]);

  const loadSessionManagerPage = useCallback(
    async (cursor: string | null = null) => {
      if (wsState !== "online") {
        setSessionManagerError(`${providerName(selectedProvider)} is not connected.`);
        return;
      }

      const requestId = ++sessionManagerRequestSeq.current;
      const searchTerm = sessionManagerSearch.trim();
      setSessionManagerLoading(true);
      setSessionManagerError("");

      try {
        const targetProviders = sessionManagerProviderFilter === "all"
          ? providerOrder.filter((provider) => providerAvailable(providerStatus(bootstrap, provider)))
          : [sessionManagerProviderFilter];
        const providersToLoad = targetProviders.length ? targetProviders : ["codex" as ProviderId];
        const responses = await Promise.all(
          providersToLoad.map((provider) =>
            agent(provider, "thread/list", {
          limit: 75,
          cursor,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: sessionManagerArchived,
              searchTerm: searchTerm || null,
              provider
            })
              .then((response) => ({
                provider,
                data: normalizeThreads(response.data || []),
                nextCursor: response.nextCursor || null
              }))
              .catch((error) => {
                if (provider === "codex") throw error;
                setNotice(`${providerName(provider)} sessions unavailable: ${error instanceof Error ? error.message : String(error)}`);
                return { provider, data: [] as Thread[], nextCursor: null };
              })
          )
        );
        if (requestId !== sessionManagerRequestSeq.current) return;
        const nextThreads = mergeThreadsById([], responses.flatMap((response) => response.data));
        setSessionManagerThreads((current) => (cursor ? mergeThreadsById(current, nextThreads) : nextThreads));
        setSessionManagerCursor(responses.find((response) => response.nextCursor)?.nextCursor || null);
      } catch (error) {
        if (requestId === sessionManagerRequestSeq.current) {
          setSessionManagerError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (requestId === sessionManagerRequestSeq.current) setSessionManagerLoading(false);
      }
    },
    [agent, bootstrap, selectedProvider, sessionManagerArchived, sessionManagerProviderFilter, sessionManagerSearch, wsState]
  );

  function updateRuntimeSettings(
    next: Partial<SessionRuntimeSettings> | ((current: SessionRuntimeSettings) => Partial<SessionRuntimeSettings>),
    provider: ProviderId = selectedProvider
  ) {
    setRuntimeSettingsByProvider((current) => {
      const old = current[provider] || providerRuntimeDefaults(provider);
      const updated = { ...old, ...(typeof next === "function" ? next(old) : next), provider };
      window.localStorage.setItem(storageKey(runtimeStorageKey(provider)), JSON.stringify(updated));
      return { ...current, [provider]: updated };
    });
  }

  async function selectSessionMode(nextMode: ModeKind) {
    if (nextMode === mode) return;
    if (sessionExecutionState.phase === "running" || sessionExecutionState.phase === "waiting") {
      setNotice("Stop the active run before changing execution mode.");
      return;
    }

    const nextSettings = { ...runtimeSettings, mode: nextMode };
    if (!selectedThread) {
      updateRuntimeSettings(nextSettings);
      setNotice(`${modeLabel(nextMode)} mode selected for the next session.`);
      return;
    }

    if (selectedThreadProvider === "cursor") {
      if (isUnusedCursorThread(selectedThread)) {
        setModeOverrideByThread((current) => ({ ...current, [currentThreadKey]: nextMode }));
        setNotice(`${modeLabel(nextMode)} mode selected.`);
        return;
      }
      const reusable = threads.find((thread) => (
        threadKey(thread) !== currentThreadKey
        && isUnusedCursorThread(thread)
        && thread.cwd === selectedThread.cwd
        && cursorThreadMode(thread) === nextMode
      ));
      if (reusable) {
        await resumeThread(reusable);
        setNotice(`Reused an empty Cursor ${modeLabel(nextMode)} session.`);
        return;
      }
      await startThread(undefined, [], { cwd: selectedThread.cwd, runtime: nextSettings });
      setNotice(`New empty Cursor ${modeLabel(nextMode)} session created. Cursor CLI modes are fixed per native session.`);
      return;
    }
    setModeOverrideByThread((current) => ({ ...current, [currentThreadKey]: nextMode }));
    setNotice(`${modeLabel(nextMode)} mode selected.`);
  }

  function selectProviderPreference(provider: ProviderId) {
    setSelectedProvider(provider);
    window.localStorage.setItem(storageKey("provider"), provider);
  }

  const collaborationMode = useCallback((modelOverride?: string, turnMode: ModeKind = mode) => {
    const settings = { ...runtimeSettings, mode: turnMode, ...(modelOverride ? { model: modelOverride } : {}) };
    return buildCollaborationMode(settings, bootstrap?.codex?.collaborationModes || [], modelOverride, turnMode);
  }, [bootstrap?.codex?.collaborationModes, mode, runtimeSettings]);

  const loadCompletedTurnDiff = useCallback(
    async (threadId: string, turnId: string) => {
      const baseline = turnDiffBaselines.current.get(turnId);
      if (!baseline) return;
      turnDiffBaselines.current.delete(turnId);

      const diff = await getJson<ProjectDiff>(
        `/api/projects/diff?cwd=${encodeURIComponent(baseline.cwd)}&baseTree=${encodeURIComponent(baseline.tree)}`
      );
      if (!diff.hasChanges) return;

      const itemId = `${turnId}-diff`;
      const item: ThreadItem = {
        id: itemId,
        type: "diff",
        text: diff.diff,
        projectDiff: diff,
        title: "Code changes in this turn"
      };

      setItemsForThread(threadId, (current) => ({ ...current, [itemId]: item }));
      setItemOrderForThread(threadId, (current) => uniqueAppend(current, itemId));
      registerTurnItem(threadId, turnId, itemId);
    },
    [registerTurnItem, setItemOrderForThread, setItemsForThread]
  );

  const applyQueueSnapshot = useCallback(
    (snapshot: QueueSnapshot) => {
      if (!snapshot || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.threads)) return;
      queueSnapshotRef.current = snapshot;
      setQueueSnapshot(snapshot);

      const activeByThread = new Map<string, QueuedPrompt>();
      const queuedByThread = new Map<string, QueuedPrompt>();
      const queueThreadKeys = new Set<string>();
      for (const item of snapshot.items) {
        queueThreadKeys.add(item.threadKey);
        if (["dispatching", "running", "waiting_for_input"].includes(item.status)) {
          activeByThread.set(item.threadKey, item);
        } else if (item.status === "queued" && !queuedByThread.has(item.threadKey)) {
          queuedByThread.set(item.threadKey, item);
        }
        if (!item.diff?.hasChanges || !item.runId) continue;
        const itemId = `${item.runId}-diff`;
        const diffItem: ThreadItem = {
          id: itemId,
          type: "diff",
          text: item.diff.diff,
          projectDiff: item.diff,
          title: "Code changes in this turn"
        };
        setItemsForThread(item.threadKey, (current) => current[itemId] ? current : { ...current, [itemId]: diffItem });
        setItemOrderForThread(item.threadKey, (current) => uniqueAppend(current, itemId));
        registerTurnItem(item.threadKey, item.runId, itemId);
      }

      for (const threadKeyValue of queueThreadKeys) {
        const pending = activeByThread.get(threadKeyValue) || queuedByThread.get(threadKeyValue);
        reconcileQueuePendingPrompt(threadKeyValue, pending || null);
      }

      const queueTurns = activeQueueTurns(snapshot);
      setActiveTurnIdsByThread((current) => {
        let next = current;
        for (const [threadKeyValue, runId] of queueTurns) {
          if (current[threadKeyValue] === runId) continue;
          if (next === current) next = { ...current };
          next[threadKeyValue] = runId;
        }
        return next;
      });
    },
    [registerTurnItem, setItemOrderForThread, setItemsForThread]
  );

  const refreshSessionState = useCallback(async (_reason: "connect" | "reconnect" | "manual" | "recover" = "manual") => {
    const requestId = ++sessionRefreshRequestSeq.current;
    const selectedKey = selectedThreadIdRef.current;
    const [, snapshot] = await Promise.all([
      loadThreads(),
      call({ type: "queue:list" }) as Promise<QueueSnapshot>
    ]);
    if (requestId !== sessionRefreshRequestSeq.current) return;
    if (snapshot) applyQueueSnapshot(snapshot);
    if (selectedKey && selectedThreadIdRef.current === selectedKey) {
      await refreshSelectedThread(selectedKey);
    }
  }, [applyQueueSnapshot, call, loadThreads, refreshSelectedThread]);

  const showCompletionPopup = useCallback((threadId: string, turn?: Turn) => {
    const popupId = `${threadId}:${turn?.id || Date.now()}`;
    const userItem = turn?.items?.find(isUserMessageItem);
    const title = compactText(userItem ? itemText(userItem) : "", 96) || "Agent task completed";
    const detail = `Completed ${formatTime(turn?.completedAt || nowSeconds())}`;

    setCompletionPopup({ id: popupId, title, detail });
    if (completionPopupTimer.current) window.clearTimeout(completionPopupTimer.current);
    completionPopupTimer.current = window.setTimeout(() => {
      setCompletionPopup((current) => (current?.id === popupId ? null : current));
    }, 7000);
  }, []);

  const applyNotification = useCallback(
    (message: { method: string; params?: any }, eventProvider?: ProviderId) => {
      const params = message.params || {};
      const provider = (params.provider as ProviderId | undefined) || eventProvider || "codex";
      const tid = typeof params.threadId === "string" ? threadKey(params.threadId, provider) : null;

      if (message.method === "account/rateLimits/updated") {
        if (provider === "claude") {
          const nextRateLimit = standardClaudeRateLimit(params);
          if (nextRateLimit) setClaudeRateLimit(nextRateLimit);
          return;
        }
        const nextRateLimit = standardCodexRateLimit(params);
        if (nextRateLimit) setCodexRateLimit(nextRateLimit);
        return;
      }

      if (message.method === "thread/started" && params.thread) {
        const thread = normalizeThread({ ...params.thread, provider });
        knownThreadIdsRef.current.add(threadKey(thread));
        dismissedThreadIdsRef.current.delete(threadKey(thread));
        setThreads((current) => mergeThreadsById(current, [thread]));
      }

      if (message.method === "thread/archived" && params.threadId) {
        removeArchivedThread(threadKey(params.threadId, provider));
      }

      if (
        (message.method === "thread/closed" || message.method === "thread/deleted") &&
        params.threadId
      ) {
        warmThreadIdsRef.current.delete(threadKey(params.threadId, provider));
      }

      if (message.method === "thread/unarchived" && params.thread) {
        restoreUnarchivedThread(normalizeThread({ ...params.thread, provider }));
      } else if (message.method === "thread/unarchived" && params.threadId) {
        setSessionManagerThreads((current) => current.filter((thread) => threadKey(thread) !== threadKey(params.threadId, provider)));
      }

      if (message.method === "thread/status/changed") {
        const statusKey = threadKey(params.threadId, provider);
        setThreads((current) => {
          let changed = false;
          const next = current.map((thread) => {
            if (threadKey(thread) !== statusKey) return thread;
            if (sameStatusType(thread.status, params.status)) return thread;
            changed = true;
            return { ...thread, status: params.status };
          });
          return changed ? next : current;
        });
        setSelectedThread((current) => {
          if (!current || threadKey(current) !== statusKey) return current;
          if (sameStatusType(current.status, params.status)) return current;
          return { ...current, status: params.status };
        });
      }

      if (!tid) return;
      if (dismissedThreadIdsRef.current.has(tid)) return;
      if (!knownThreadIdsRef.current.has(tid)) return;

      if (message.method === "thread/tokenUsage/updated") {
        if (selectedThreadIdRef.current === tid) {
          const nextLabel = formatTokenUsage(params);
          setTokenUsageByThread((current) => (
            formatTokenUsage(current[tid]) === nextLabel ? current : { ...current, [tid]: params }
          ));
        }
      }

      if (message.method === "turn/started") {
        updateActiveTurn(tid, (params.turn as Turn | undefined)?.id || null);
      }
      if (message.method === "turn/completed") {
        if (provider === "cursor") refreshCursorUsageRef.current();
        const turn = params.turn as Turn | undefined;
        updateActiveTurn(tid, null, turn?.id);
        const terminalKind = terminalKindForTurn(turn);
        const terminalStatus = { type: terminalKind };
        setThreads((current) => current.map((thread) => (
          threadKey(thread) === tid ? { ...thread, status: terminalStatus } : thread
        )));
        setSelectedThread((current) => (
          current && threadKey(current) === tid ? { ...current, status: terminalStatus } : current
        ));
        if (turn?.id) {
          const completionKey = `${tid}:${turn.id}`;
          if (!completedTurnNotifications.current.has(completionKey)) {
            completedTurnNotifications.current.add(completionKey);
            if (terminalKind !== "failed" && selectedThreadIdRef.current !== tid) showCompletionPopup(tid, turn);
          }
          loadCompletedTurnDiff(tid, turn.id).catch((error) =>
            setNotice(error instanceof Error ? error.message : String(error))
          );
        }
      }
      applyTranscriptNotification(tid, message);
    },
    [loadCompletedTurnDiff, showCompletionPopup, updateActiveTurn]
  );

  useEffect(() => {
    selectedThreadIdRef.current = threadKey(selectedThread) || null;
    if (selectedThread) selectProviderPreference(providerOf(selectedThread));
  }, [selectedThread]);

  useEffect(() => {
    if (!pendingLiveThreadKeys.length) return;
    const covered = new Set<string>();
    for (const key of queueSummaryByThread.keys()) covered.add(key);
    for (const [key, turnId] of Object.entries(activeTurnIdsByThread)) {
      if (turnId) covered.add(key);
    }
    const next = pendingLiveThreadKeys.filter((key) => !covered.has(key));
    if (next.length === pendingLiveThreadKeys.length) return;
    setPendingLiveThreadKeys(next);
  }, [activeTurnIdsByThread, pendingLiveThreadKeys, queueSummaryByThread]);

  useEffect(
    () => () => {
      if (completionPopupTimer.current) window.clearTimeout(completionPopupTimer.current);
    },
    []
  );

  useEffect(() => {
    const next = new Set<string>();
    for (const thread of threads) next.add(threadKey(thread));
    if (selectedThread) next.add(threadKey(selectedThread));
    for (const item of queueSnapshot.items) next.add(item.threadKey);
    knownThreadIdsRef.current = next;
  }, [queueSnapshot.items, selectedThread?.id, threads]);

    useEffect(() => {
      const savedProvider = window.localStorage.getItem(storageKey("provider"));
      if (isAgentProviderId(savedProvider)) setSelectedProvider(savedProvider);
      const saved = window.localStorage.getItem(storageKey("cwd"));
      if (saved) setCwd(saved);
    const recent = readStoredJson<string[]>(window.localStorage.getItem(storageKey("recentDirs")), []);
    if (Array.isArray(recent)) setRecentDirs(recent.filter((item): item is string => typeof item === "string"));
    const pinned = readStoredJson<string[]>(window.localStorage.getItem(storageKey("pinnedDirs")), []);
    if (Array.isArray(pinned)) setPinnedDirs(pinned.filter((item): item is string => typeof item === "string"));
    const pinnedThreads = window.localStorage.getItem(pinnedThreadsStorageKey);
    if (pinnedThreads) {
      try {
        const parsed = JSON.parse(pinnedThreads);
        if (Array.isArray(parsed)) setPinnedThreadKeys(parsed.filter((item): item is string => typeof item === "string"));
      } catch {
        // Ignore malformed local UI preferences.
      }
    }
    const collapsed = readStoredJson<string[]>(window.localStorage.getItem(storageKey("collapsedThreadGroups")), []);
    if (Array.isArray(collapsed)) setCollapsedThreadGroups(collapsed.filter((item): item is string => typeof item === "string"));
    const savedThreadLayout = window.localStorage.getItem(threadLayoutStorageKey);
    if (savedThreadLayout === "directories" || savedThreadLayout === "recent") setThreadLayout(savedThreadLayout);
    const savedSidebarCollapsed = window.localStorage.getItem(storageKey("sidebarCollapsed"));
    if (savedSidebarCollapsed === "true") setSidebarCollapsed(true);
    const savedSidebarWidth = Number(window.localStorage.getItem(sidebarWidthStorageKey));
    if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0) setSidebarWidth(clampSidebarWidth(savedSidebarWidth));
    const savedContextWidth = Number(window.localStorage.getItem(contextWidthStorageKey));
    if (Number.isFinite(savedContextWidth) && savedContextWidth > 0) {
      const migrated = savedContextWidth === 360 || savedContextWidth === 300 ? defaultContextWidth : savedContextWidth;
      setContextWidth(clampContextWidth(migrated));
    }
      for (const provider of providerOrder) {
        const savedRuntime = window.localStorage.getItem(storageKey(runtimeStorageKey(provider)));
        if (!savedRuntime) continue;
        try {
          const parsed = JSON.parse(savedRuntime) as Partial<SessionRuntimeSettings>;
          const restored = restoreProviderRuntimeSettings(provider, parsed);
          window.localStorage.setItem(storageKey(runtimeStorageKey(provider)), JSON.stringify(restored));
          setRuntimeSettingsByProvider((current) => ({
            ...current,
            [provider]: restored
          }));
        } catch {
          // Ignore malformed local UI preferences.
        }
      }
  
      bootstrapPromise
        ?.then((nextBootstrap: Bootstrap) => {
          setBootstrap(nextBootstrap);
          if (!saved && nextBootstrap.defaultCwd) setCwd(nextBootstrap.defaultCwd);
        })
        .catch((error) =>
          setBootstrapError(error instanceof Error ? error.message : String(error))
        );
    }, []);

    const wsAllowed = bootstrap?.authenticated === true;
    useEffect(() => {
      if (!wsAllowed) return;

      let stopped = false;
      let retry: number | null = null;

    function rejectPending(error: Error) {
      for (const pending of pendingReplies.current.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingReplies.current.clear();
    }

      function handleGatewayEvent(message: any) {
        if (message.type === "reply") {
          const reply = message as Reply;
          const pending = pendingReplies.current.get(reply.requestId);
          if (!pending) return;
          pendingReplies.current.delete(reply.requestId);
          window.clearTimeout(pending.timeout);
          if (reply.ok) pending.resolve(reply.result);
          else pending.reject(new Error(reply.error || "Request failed."));
          return;
        }

        if (message.type === "queue:snapshot") {
          applyQueueSnapshot(message.snapshot);
          return;
        }

        if (message.type === "gateway:snapshot") {
          setBootstrap((current) =>
            current ? { ...current, codex: message.snapshot, codexError: null } : current
          );
          setPendingRequests(message.snapshot?.pendingServerRequests || []);
          setGatewayDiagnostic(message.snapshot?.diagnostic || null);
          return;
        }

        if (message.type === "agent:snapshot" && message.providers) {
          setBootstrap((current) => current ? { ...current, providers: message.providers } : current);
          return;
        }

        if (message.type === "gateway:diagnostic") {
          setGatewayDiagnostic(message.diagnostic || null);
          if (message.diagnostic?.detail) setNotice(`${message.diagnostic.title}. ${message.diagnostic.detail}`);
          return;
        }

        if (message.type === "gateway:state") {
          setBootstrap((current) => {
            if (!current) return current;
            const codexStatus = current.providers?.codex || {};
            const available = message.status === "connected";
            return {
              ...current,
              providers: {
                ...(current.providers || {}),
                codex: {
                  ...codexStatus,
                  available,
                  availability: available ? "available" : "unavailable",
                  status: message.status,
                  diagnostic: message.detail || null
                }
              }
            };
          });
          if (message.detail) setNotice(message.detail);
          return;
        }

        if (message.type === "codex:notification") {
          applyNotification(message.message, "codex");
          return;
        }

        if (message.type === "agent:event") {
          const provider = isAgentProviderId(message.provider) ? message.provider : "codex";
          const notification = provider === "codex"
            ? message.message || message.event
            : cursorEventToNotification(message, provider);
          if (provider !== "codex" && message.event === "error" && message.message) {
            setNotice(`${providerName(provider)}: ${message.message}`);
          }
          if (notification) applyNotification(notification, provider);
          if (provider !== "codex" && message.event === "status" && message.sessionId && message.status) {
            applyNotification({
              method: "thread/status/changed",
              params: { provider, threadId: message.sessionId, status: message.status }
            }, provider);
          }
          return;
        }

        if (message.type === "codex:serverRequest" || message.type === "agent:serverRequest") {
          setPendingRequests((current) => [
            ...current.filter((request) => request.id !== message.request.id),
            { ...message.request, params: { ...(message.request.params || {}), provider: message.provider || "codex" } }
          ]);
          return;
        }

        if (message.type === "codex:serverRequestResolved" || message.type === "agent:serverRequestResolved") {
          setPendingRequests((current) => current.filter((request) => request.id !== message.requestId));
        }
      }

      function connect() {
        if (stopped) return;
        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
        retry = null;
        const ws = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${appPath("/ws")}`
        );
        wsRef.current = ws;
        setWsState("connecting");

        ws.onopen = () => {
          if (ws !== wsRef.current) return;
          const reconnecting = reconnectAttempt.current > 0;
          reconnectAttempt.current = 0;
          setWsState("online");
          refreshSessionState(reconnecting ? "reconnect" : "connect").catch((error) => setNotice(error.message));
        };
        ws.onerror = () => {
          if (ws === wsRef.current) setWsState("error");
        };
        ws.onclose = () => {
          if (ws !== wsRef.current) return;
          wsRef.current = null;
          rejectPending(new Error("WebSocket disconnected."));
          setWsState("offline");
          if (stopped) return;
          const attempt = reconnectAttempt.current++;
          const wait = Math.min(5_000, 400 * 2 ** Math.min(attempt, 4)) + Math.round(Math.random() * 200);
          retry = window.setTimeout(connect, wait);
        };
        ws.onmessage = (event) => {
          if (ws !== wsRef.current) return;
          try {
            handleGatewayEvent(JSON.parse(event.data));
          } catch {
            // Ignore malformed gateway frames.
          }
        };
      }

      function reconnectNow() {
        if (stopped) return;
        if (retry) {
          window.clearTimeout(retry);
          retry = null;
        }
        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
        reconnectAttempt.current = 0;
        connect();
      }

      function handleVisibilityChange() {
        if (document.visibilityState !== "visible") return;
        if (wsRef.current?.readyState === WebSocket.OPEN) return;
        reconnectNow();
      }

      function handleOnline() {
        reconnectNow();
      }
  
      connect();
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("online", handleOnline);
      window.addEventListener("focus", handleOnline);

      return () => {
        stopped = true;
        if (retry) window.clearTimeout(retry);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("focus", handleOnline);
        wsRef.current?.close();
      };
    }, [applyNotification, applyQueueSnapshot, refreshSessionState, wsAllowed]);

  useEffect(() => {
    if (wsState !== "online") return;
    codex("account/rateLimits/read")
      .then((response) => {
        const nextRateLimit = standardCodexRateLimit(response);
        if (nextRateLimit) setCodexRateLimit(nextRateLimit);
      })
      .catch(() => undefined);
    agent("codex", "thread/loaded/list", {})
      .then((response) => {
        const ids = Array.isArray(response?.data) ? response.data : [];
        warmThreadIdsRef.current = new Set(
          ids
            .filter((id: unknown): id is string => typeof id === "string")
            .map((id: string) => threadKey(id, "codex"))
        );
      })
      .catch(() => undefined);
  }, [agent, codex, loadThreads, wsState]);

  useEffect(() => {
    const nextRateLimit = standardClaudeRateLimit(bootstrap?.providers?.claude?.rateLimit);
    if (nextRateLimit) setClaudeRateLimit(nextRateLimit);
    const nextCursorUsage = parseCursorUsage(bootstrap?.providers?.cursor?.rateLimit);
    if (nextCursorUsage) setCursorUsage(nextCursorUsage);
  }, [bootstrap]);

  const refreshCursorUsage = useCallback(() => {
    agent("cursor", "account/usage/read", {})
      .then((response) => {
        const next = parseCursorUsage(response);
        if (next) setCursorUsage(next);
      })
      .catch(() => undefined);
  }, [agent]);
  const refreshCursorUsageRef = useRef(refreshCursorUsage);
  refreshCursorUsageRef.current = refreshCursorUsage;

  useEffect(() => {
    if (wsState !== "online") return;
    refreshCursorUsage();
    if (selectedProvider !== "cursor") return;
    const timer = window.setInterval(refreshCursorUsage, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshCursorUsage, selectedProvider, wsState]);

  useEffect(() => {
    if (wsState !== "online" || legacyQueueMigrationRunning.current) return;
    const raw = window.localStorage.getItem(promptQueueStorageKey);
    if (!raw) return;

    let legacy: Record<string, Array<{ id?: string; threadId?: string; text?: string; createdAt?: number }>>;
    try {
      legacy = JSON.parse(raw);
    } catch {
      setNotice("The legacy browser queue could not be parsed; it was left unchanged.", "warning");
      return;
    }

    legacyQueueMigrationRunning.current = true;
    void (async () => {
      const remaining = { ...legacy };
      for (const [legacyThreadKey, entries] of Object.entries(legacy)) {
        const thread = threadByKey.get(legacyThreadKey);
        if (!thread || !Array.isArray(entries)) continue;
        const provider = providerOf(thread);
        const runtime = runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider);
        const unimported = [...entries];
        for (const entry of entries) {
          if (!entry.text?.trim()) {
            unimported.shift();
            continue;
          }
          const item = {
            id: entry.id || queueId(),
            provider,
            threadKey: legacyThreadKey,
            threadId: nativeThreadId(thread),
            text: entry.text,
            cwd: thread.cwd,
            threadParams: runtimeThreadParams(runtime),
            turnParams: {
              ...runtimeTurnParams(runtime),
              ...(provider === "codex"
                ? { collaborationMode: buildCollaborationMode(runtime, bootstrap?.codex?.collaborationModes || [], runtime.model, runtime.mode) }
                : {})
            },
            createdAt: entry.createdAt || nowSeconds()
          };
          try {
            const response = await call({ type: "queue:enqueue", item });
            if (response?.snapshot) applyQueueSnapshot(response.snapshot);
            unimported.shift();
          } catch {
            break;
          }
        }
        if (unimported.length) remaining[legacyThreadKey] = unimported;
        else delete remaining[legacyThreadKey];
      }

      if (Object.keys(remaining).length) {
        window.localStorage.setItem(promptQueueStorageKey, JSON.stringify(remaining));
      } else {
        window.localStorage.removeItem(promptQueueStorageKey);
      }
    })().finally(() => {
      legacyQueueMigrationRunning.current = false;
    });
  }, [applyQueueSnapshot, bootstrap?.codex?.collaborationModes, call, runtimeSettingsByProvider, threadByKey, wsState]);

  useEffect(() => {
    if (!sessionManagerOpen) return;
    const timer = window.setTimeout(() => loadSessionManagerPage(null), 160);
    return () => window.clearTimeout(timer);
  }, [loadSessionManagerPage, sessionManagerOpen]);

  useEffect(() => {
    if (wsState !== "online" || runtimeInitialized.current) return;
    runtimeInitialized.current = true;
    codex("config/read", { includeLayers: false, cwd: selectedRoot(selectedThread, project, cwd) || null })
      .then((response) => {
        const config = response?.config || {};
        setRuntimeSettingsByProvider((current) => {
          const old = current.codex || providerRuntimeDefaults("codex");
          return {
            ...current,
            codex: {
              ...old,
              model: old.model || config.model || "",
              reasoningEffort: old.reasoningEffort ?? config.model_reasoning_effort ?? null,
              serviceTier: old.serviceTier ?? config.service_tier ?? null,
              approvalPolicy: old.approvalPolicy ?? config.approval_policy ?? null,
              sandboxMode: old.sandboxMode ?? config.sandbox_mode ?? null
            }
          };
        });
      })
      .catch(() => undefined);
  }, [codex, cwd, project, selectedThread, wsState]);

  useEffect(() => {
    if (commandPanel !== "mention") return;
    const query = mentionQuery.trim();
    if (!query) {
      setCommandPanelData({ files: [] });
      return;
    }

    const timer = window.setTimeout(() => {
      setCommandPanelLoading(true);
      setCommandPanelError("");
      codex("fuzzyFileSearch", {
        query,
        roots: [selectedRoot(selectedThread, project, cwd)].filter(Boolean),
        cancellationToken: null
      })
        .then((response) => setCommandPanelData(response))
        .catch((error) => setCommandPanelError(error instanceof Error ? error.message : String(error)))
        .finally(() => setCommandPanelLoading(false));
    }, 180);

    return () => window.clearTimeout(timer);
  }, [codex, commandPanel, cwd, mentionQuery, project, selectedThread]);

  useEffect(() => {
    setFileContexts([]);
    setFileContextHighlight(null);
    setFileMentions([]);
    setAtQuery(null);
  }, [workspaceRoot]);

  useEffect(() => {
    if (atQuery === null) {
      setFileMentions([]);
      return;
    }
    const root = workspaceRoot;
    if (!root) {
      setFileMentions([]);
      return;
    }
    const query = atQuery.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const applyHits = (hits: FileMentionHit[]) => {
        if (!cancelled) setFileMentions(hits);
      };
      if (selectedProvider === "codex" && query) {
        void codex("fuzzyFileSearch", {
          query,
          roots: [root],
          cancellationToken: null
        }).then((response) => {
          const files = Array.isArray(response?.files) ? response.files : [];
          applyHits(
            files.slice(0, 20).map((item: { path?: string; file_name?: string }) => ({
              path: String(item.path || item.file_name || ""),
              name: String(item.file_name || item.path || "").split("/").pop() || ""
            })).filter((item: FileMentionHit) => item.path && isMentionablePath(item.path))
          );
        }).catch(() => {
          void searchProjectFiles(root, query).then(applyHits);
        });
        return;
      }
      void searchProjectFiles(root, query).then(applyHits);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [atQuery, codex, selectedProvider, workspaceRoot]);

  useEffect(() => {
    if (wsState !== "online") return;
    for (const thread of threads) {
      if (!isUntitledThread(thread)) continue;
      const key = threadKey(thread);
      if (autoNamedThreadIds.current.has(key)) continue;
      if (activeTurnIdsByThread[key]) continue;
      const view = getThreadViewState();
      const orderForThread = view.itemOrderByThread[key];
      const itemsForThread = view.itemsByThread[key];
      if (!orderForThread || !itemsForThread || orderForThread.length < 2) continue;
      const firstUserItem = orderForThread.map((id) => itemsForThread[id]).find((item) => item && isUserMessageItem(item));
      if (!firstUserItem) continue;
      const text = userMessageParts(firstUserItem).text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const fallbackTitle = fallbackTitleFromUserText(text);
      if (!fallbackTitle) continue;
      const threadId = threadKey(thread);
      const provider = providerOf(thread);
      autoNamedThreadIds.current.add(threadId);

      const applyTitle = (title: string) =>
        agent(provider, "thread/name/set", { threadId: nativeThreadId(thread), name: title, provider }).then(() => {
          setThreads((current) =>
            current.map((candidate) => (threadKey(candidate) === threadId ? { ...candidate, name: title } : candidate))
          );
          setSelectedThread((current) =>
            current && threadKey(current) === threadId ? { ...current, name: title } : current
          );
        });

      const naming = applyTitle(fallbackTitle);

      naming.catch(() => {
        autoNamedThreadIds.current.delete(threadId);
      });
    }
  }, [activeTurnIdsByThread, agent, threads, wsState]);

  async function login(event: FormEvent) {
    event.preventDefault();
    const response = await fetch(appPath("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });

    if (!response.ok) {
      setNotice("Login failed.");
      return;
    }

    const nextBootstrap = await fetch(appPath("/api/bootstrap")).then((item) => item.json());
    setBootstrap(nextBootstrap);
  }

  async function logout() {
    await fetch(appPath("/api/auth/logout"), { method: "POST" });
    location.reload();
  }

  function rememberDirectory(path: string) {
    const next = [path, ...recentDirs.filter((item) => item !== path)].slice(0, 8);
    setRecentDirs(next);
    window.localStorage.setItem(storageKey("recentDirs"), JSON.stringify(next));
  }

  function togglePinnedDirectory(path: string) {
    const target = normalizeDirectoryPath(path);
    if (!target) return;
    setPinnedDirs((current) => {
      const next = current.some((item) => normalizeDirectoryPath(item) === target)
        ? current.filter((item) => normalizeDirectoryPath(item) !== target)
        : [target, ...current.filter((item) => normalizeDirectoryPath(item) !== target)].slice(0, 12);
      window.localStorage.setItem(storageKey("pinnedDirs"), JSON.stringify(next));
      return next;
    });
  }

  const togglePinnedThread = useCallback((key: string) => {
    setPinnedThreadKeys((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      try {
        window.localStorage.setItem(pinnedThreadsStorageKey, JSON.stringify(next));
      } catch {
        // The UI still works when browser storage is unavailable.
      }
      return next;
    });
  }, []);

  function removePinnedThread(key: string) {
    setPinnedThreadKeys((current) => {
      if (!current.includes(key)) return current;
      const next = current.filter((item) => item !== key);
      try {
        window.localStorage.setItem(pinnedThreadsStorageKey, JSON.stringify(next));
      } catch {
        // The UI still works when browser storage is unavailable.
      }
      return next;
    });
  }

  function reorderPinnedDirs(target: string) {
    const source = draggingPinnedDir;
    setDraggingPinnedDir(null);
    setDropTargetPinnedDir(null);
    if (!source || source === target) return;
    setPinnedDirs((current) => {
      const sourceNorm = normalizeDirectoryPath(source);
      const targetNorm = normalizeDirectoryPath(target);
      if (!current.some((item) => normalizeDirectoryPath(item) === sourceNorm)) return current;
      if (!current.some((item) => normalizeDirectoryPath(item) === targetNorm)) return current;
      const filtered = current.filter((item) => normalizeDirectoryPath(item) !== sourceNorm);
      const targetIndex = filtered.findIndex((item) => normalizeDirectoryPath(item) === targetNorm);
      const next = [...filtered.slice(0, targetIndex), sourceNorm, ...filtered.slice(targetIndex)];
      window.localStorage.setItem(storageKey("pinnedDirs"), JSON.stringify(next));
      return next;
    });
  }

  function toggleMcpServerExpanded(name: string) {
    setExpandedMcpServers((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleThreadGroup(cwd: string) {
    setCollapsedThreadGroups((current) => {
      const next = current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd];
      window.localStorage.setItem(storageKey("collapsedThreadGroups"), JSON.stringify(next));
      return next;
    });
  }

  function updateThreadLayout(next: ThreadLayout) {
    setThreadLayout(next);
    window.localStorage.setItem(threadLayoutStorageKey, next);
  }

  function setSidebarCollapsedValue(next: boolean) {
    setSidebarCollapsed(next);
    window.localStorage.setItem(storageKey("sidebarCollapsed"), String(next));
  }

  function setSidebarWidthValue(width: number) {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    window.localStorage.setItem(sidebarWidthStorageKey, String(next));
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setSidebarResizing(true);
    document.body.classList.add("sidebarResizing");

    const resize = (moveEvent: PointerEvent) => {
      setSidebarWidthValue(startWidth + moveEvent.clientX - startX);
    };
    const stopResize = () => {
      setSidebarResizing(false);
      document.body.classList.remove("sidebarResizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function startContextResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = contextWidth;
    let nextWidth = startWidth;
    setContextResizing(true);
    document.body.classList.add("contextResizing");

    const resize = (moveEvent: PointerEvent) => {
      nextWidth = clampContextWidth(startWidth + startX - moveEvent.clientX);
      appShellRef.current?.style.setProperty("--context-width", `${nextWidth}px`);
    };
    const stopResize = () => {
      setContextWidth(nextWidth);
      try {
        window.localStorage.setItem(contextWidthStorageKey, String(nextWidth));
      } catch {
        // The UI still works when browser storage is unavailable.
      }
      setContextResizing(false);
      document.body.classList.remove("contextResizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function openSessionManager() {
    setMobilePanel(null);
    setSessionManagerOpen(true);
  }

  function toggleSessionManagerGroup(cwd: string) {
    setCollapsedSessionManagerGroups((current) =>
      current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd]
    );
  }

  async function archiveManagedThread(thread: Thread) {
    if (threadIsActive(thread, activeTurnIdsByThread)) {
      setNotice("Stop the active session before archiving it.");
      return;
    }

    const key = threadKey(thread);
    setSessionManagerBusy(key);
    try {
      await agent(providerOf(thread), "thread/archive", { threadId: nativeThreadId(thread), provider: providerOf(thread) });
      removeArchivedThread(key);
      setNotice("Session archived.");
    } finally {
      setSessionManagerBusy(null);
    }
  }

  async function archiveSessionGroup(group: ThreadGroup) {
    const archivable = group.threads.filter((thread) => !threadIsActive(thread, activeTurnIdsByThread));
    const skipped = group.threads.length - archivable.length;
    if (!archivable.length) {
      setNotice("No idle sessions in this directory can be archived.");
      return;
    }

    setSessionManagerBusy(`group:${group.cwd}`);
    try {
      for (const thread of archivable) {
        await agent(providerOf(thread), "thread/archive", { threadId: nativeThreadId(thread), provider: providerOf(thread) });
        removeArchivedThread(threadKey(thread));
      }
      setNotice(`Archived ${archivable.length} sessions${skipped ? `, skipped ${skipped} active.` : "."}`);
    } finally {
      setSessionManagerBusy(null);
    }
  }

  async function restoreManagedThread(thread: Thread) {
    setSessionManagerBusy(threadKey(thread));
    try {
      const response = await agent(providerOf(thread), "thread/unarchive", { threadId: nativeThreadId(thread), provider: providerOf(thread) });
      const restored = normalizeThread({ ...((response.thread || thread) as Thread), provider: providerOf(thread) });
      restoreUnarchivedThread(restored);
      setNotice("Session restored.");
      return restored;
    } finally {
      setSessionManagerBusy(null);
    }
  }

  async function chooseManagedThread(thread: Thread) {
    const target = sessionManagerArchived ? await restoreManagedThread(thread) : thread;
    await resumeThread(target);
    setSessionManagerOpen(false);
  }

  function applyResolvedDirectory(result: ProjectInfo) {
    setProject(result);
    setCwd(result.realpath);
    window.localStorage.setItem(storageKey("cwd"), result.realpath);
    rememberDirectory(result.realpath);
  }

  async function resolveCwdValue(value: string) {
    setProjectError("");
    try {
      const result = await getJson<ProjectInfo>(`/api/projects/resolve?cwd=${encodeURIComponent(value)}`);
      applyResolvedDirectory(result);
      return result;
    } catch (error) {
      setProject(null);
      setProjectError(directoryErrorMessage(error));
      throw error;
    }
  }

  useEffect(() => {
    if (!bootstrap?.authenticated || !cwd.trim() || restoredCwdResolved.current) return;
    restoredCwdResolved.current = true;
    resolveCwdValue(cwd).catch(() => undefined);
  }, [bootstrap?.authenticated, cwd]);

  async function useDirectory(path: string) {
    const resolved = await resolveCwdValue(path).catch(() => null);
    if (!resolved) return;
    setDirectoryPickerOpen(false);
    setMobilePanel(null);
  }

  function useResolvedDirectory(result: ProjectInfo) {
    setProjectError("");
    applyResolvedDirectory(result);
    setDirectoryPickerOpen(false);
    setMobilePanel(null);
  }

  function beginDraftSession() {
    selectedThreadIdRef.current = null;
    setSelectedThread(null);
    setWorkspaceView("chat");
    setMobilePanel(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function startThread(
    initialPrompt?: string,
    initialAttachments: Attachment[] = [],
    options: { cwd?: string; runtime?: SessionRuntimeSettings; provider?: ProviderId } = {}
  ) {
    const provider = options.provider || selectedProvider;
    const status = provider === selectedProvider ? currentProviderStatus : providerStatus(bootstrap, provider);
    if (sessionCreatingRef.current) return;
    if (!providerAvailable(status)) {
      setNotice(`${providerName(provider)} is not available on this server.`);
      return;
    }
    if (provider !== selectedProvider) selectProviderPreference(provider);
    const threadRuntime = options.runtime || runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider);
    sessionCreatingRef.current = true;
    setSessionCreating(true);
    try {
      const resolved = await resolveCwdValue(options.cwd || cwd);
      const threadResponse = await agent(provider, "thread/start", {
        cwd: resolved.realpath,
        provider,
        ...runtimeThreadParams(threadRuntime)
      });
      const created = normalizeThread({ ...(threadResponse.thread as Thread), provider });
      const titled = initialPrompt ? withImmediateTitle(created, initialPrompt) : created;
      const key = threadKey(titled);
      setModeOverrideByThread((current) => ({ ...current, [key]: threadRuntime.mode }));
      knownThreadIdsRef.current.add(key);
      if (provider === "codex") warmThreadIdsRef.current.add(key);
      dismissedThreadIdsRef.current.delete(key);
      selectedThreadIdRef.current = key;
      setSelectedThread(titled);
      updateActiveTurn(key, activeTurnIdFromTurns(titled.turns || []));
      clearPendingPrompt("");
      setPendingPromptForThread(key, initialPrompt || "");
      applyItemsFromTurns(key, titled.turns || []);
      setMobilePanel(null);
      setThreads((current) => mergeThreadsById(current, [titled]));

      updateRuntimeSettings(
        (current) => mergeThreadRuntimeSettings(current, threadResponse, { mode: current.mode }),
        provider
      );

      if (initialPrompt || initialAttachments.length) {
        markThreadLive(key);
        await sendToThread(key, initialPrompt || "", threadResponse.model || "", initialAttachments, threadRuntime.mode, titled);
      } else {
        window.setTimeout(() => composerRef.current?.focus(), 0);
      }
    } finally {
      sessionCreatingRef.current = false;
      setSessionCreating(false);
    }
  }

  async function switchProvider(provider: ProviderId) {
    if (provider === selectedProvider && (!selectedThread || providerOf(selectedThread) === provider)) return;

    const status = providerStatus(bootstrap, provider);
    if (!providerAvailable(status)) {
      setNotice(`${providerName(provider)} is not available on this server.`);
      return;
    }

    const leavingThread = Boolean(selectedThread && providerOf(selectedThread) !== provider);
    selectProviderPreference(provider);
    setRuntimeSettingsByProvider((current) => ({
      ...current,
      [provider]: current[provider] || providerRuntimeDefaults(provider)
    }));
    beginDraftSession();
    setNotice(
      leavingThread
        ? `${providerName(provider)} selected. Send a task to create the session.`
        : `${providerName(provider)} selected for new sessions.`
    );
  }

  startProviderActionRef.current = (provider) => {
    switchProvider(provider)
      .then(() => beginDraftSession())
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
  };

  async function resumeThread(thread: Thread) {
    // Switch immediately. Cached turns stay visible; Codex without cache
    // loads history from this single resume instead of a follow-up thread/read.
    const provider = providerOf(thread);
    const key = threadKey(thread);
    const listedThread = normalizeThread(thread);
    knownThreadIdsRef.current.add(key);
    dismissedThreadIdsRef.current.delete(key);
    selectedThreadIdRef.current = key;
    selectProviderPreference(provider);
    setSelectedThread(listedThread);
    setShowAllHistory(false);
    const hadCache = threadViewHasConversationHistory(key);
    if (!hadCache) setHistoryLoadingThreadId(key);
    setMobilePanel(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);

    const excludeTurns = provider === "codex" && hadCache;

    try {
      // Codex warm-pool short-circuits this to thread/read when already loaded.
      // Cursor maps resume to session/read and returns the local transcript.
      const response = await agent(provider, "thread/resume", {
        threadId: nativeThreadId(thread),
        provider,
        excludeTurns,
        ...runtimeThreadParams(runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider))
      });

      // Drop the response if the user has switched to a different session in
      // the meantime, otherwise the slow reply would clobber the newer one.
      if (selectedThreadIdRef.current !== key) return;

      const resumed = normalizeThread({ ...(response.thread as Thread), provider });
      if (provider === "codex") warmThreadIdsRef.current.add(key);
      selectedThreadIdRef.current = key;
      setSelectedThread((current) => current && threadKey(current) === key ? hydrateListedThread(current, resumed) : hydrateListedThread(thread, resumed));
      const queueTurnId = activeQueueTurns(queueSnapshotRef.current).get(key) || null;
      updateActiveTurn(key, queueTurnId || activeTurnIdFromTurns(resumed.turns || []));
      setThreads((current) => patchListedThread(current, resumed, key));
      setRuntimeSettingsByProvider((current) => ({
        ...current,
        [provider]: mergeThreadRuntimeSettings(
          current[provider] || providerRuntimeDefaults(provider),
          response,
          { mode: (current[provider] || providerRuntimeDefaults(provider)).mode }
        )
      }));
      reconcileModeOverrides([resumed]);
      setPendingPromptForThread(key, "");
      if (turnsHaveItems(resumed.turns)) applyItemsFromTurns(key, resumed.turns);
      setHistoryLoadingThreadId((current) => (current === key ? null : current));
    } catch (error) {
      setHistoryLoadingThreadId((current) => (current === key ? null : current));
      throw error;
    }
  }

  async function startTurn(
    threadId: string,
    text: string,
    modelOverride?: string,
    inputAttachments: Attachment[] = [],
    turnMode: ModeKind = mode
  ) {
    setGatewayDiagnostic(null);
    const provider = providerFromThreadKey(threadId);
    if (!providerAvailable(providerStatus(bootstrap, provider))) {
      throw new Error(`${providerName(provider)} is not available on this server.`);
    }
    const input = inputItems(
      text,
      inputAttachments,
      providerCapability(providerStatus(bootstrap, provider), "images")
    );
    const root = selectedRoot(selectedThread, project, cwd);
    const providerRuntime = runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider);
    const turnRuntimeSettings = {
      ...providerRuntime,
      mode: turnMode,
      ...(modelOverride ? { model: modelOverride } : {})
    };

    // Don't block turn/start on git snapshot — snapshot can be slow on large trees.
    const turnPromise = agent(provider, "turn/start", {
      threadId: nativeThreadId(threadId),
      provider,
      input,
      ...runtimeTurnParams(turnRuntimeSettings),
      ...(provider === "codex" ? { collaborationMode: collaborationMode(modelOverride, turnMode) } : {})
    });
    const baselinePromise = root
      ? postJson<DiffSnapshot>("/api/projects/diff-snapshot", { cwd: root }).catch(() => null)
      : Promise.resolve(null);

    markThreadLive(threadId);
    try {
      const [response, diffBaseline] = await Promise.all([turnPromise, baselinePromise]);
      const turn = response?.turn as Turn | undefined;
      updateActiveTurn(threadId, turn?.id || null);
      if (turn?.id && diffBaseline) {
        turnDiffBaselines.current.set(turn.id, { cwd: diffBaseline.root, tree: diffBaseline.tree });
      }
      commitSessionMode(threadId, turnMode);
      return response;
    } catch (error) {
      clearThreadLive(threadId);
      throw error;
    }
  }

  async function sendToThread(
    threadId: string,
    text: string,
    modelOverride?: string,
    inputAttachments: Attachment[] = [],
    turnMode: ModeKind = mode,
    threadOverride?: Thread
  ) {
    if (inputAttachments.length) {
      return startTurn(threadId, text, modelOverride, inputAttachments, turnMode);
    }
    const provider = providerFromThreadKey(threadId);
    const baseRuntime = runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider);
    const queueRuntime = {
      ...baseRuntime,
      mode: turnMode,
      ...(modelOverride ? { model: modelOverride } : {})
    };
    return enqueuePrompt(threadId, text, queueRuntime, threadOverride);
  }

  async function executeCurrentPlan() {
    if (!selectedThread || wsState !== "online" || planSubmitting) return;
    if (!sessionExecutionState.planPayloadReady) {
      setNotice("Wait for the Plan result before executing it.", "warning");
      return;
    }

    const threadId = threadKey(selectedThread);
    const provider = providerOf(selectedThread);
    const text = `Implement this plan now. Start making the required code changes, then run appropriate verification.\n\n${sessionExecutionState.planPayload}`;
    const agentRuntime = {
      ...(runtimeSettingsByProvider[provider] || providerRuntimeDefaults(provider)),
      mode: "default" as const
    };
    setPlanSubmitting(true);
    try {
      if (activeTurnId) {
        await agent(providerFromThreadKey(threadId), "turn/interrupt", { threadId: nativeThreadId(threadId), turnId: activeTurnId });
        updateActiveTurn(threadId, null, activeTurnId);
      }
      if (provider === "cursor") {
        await startThread(text, [], {
          cwd: selectedThread.cwd,
          provider,
          runtime: agentRuntime
        });
        setNotice("Plan sent to a new Cursor Agent session.", "success");
      } else {
        await sendToThread(threadId, text, undefined, [], "default");
      }
    } catch (error) {
      await refreshSelectedThread(threadId).catch(() => undefined);
      setNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setPlanSubmitting(false);
    }
  }

  async function steerCurrentTurn(text: string) {
    if (!selectedThread || !activeTurnId) return;
    if (!supportsSteer) {
      await enqueuePrompt(threadKey(selectedThread), text);
      setNotice(`${providerName(selectedProvider)} does not support live steering. Added to queue.`);
      return;
    }
    await agent(providerOf(selectedThread), "turn/steer", {
      threadId: nativeThreadId(selectedThread),
      input: inputItems(text),
      expectedTurnId: activeTurnId
    });
  }

  function clearComposerDraft() {
    const key = selectedThreadIdRef.current || "";
    draftsRef.current[key] = "";
    composerRef.current?.setDraft("");
  }

  function restoreComposerDraft(text: string) {
    const key = selectedThreadIdRef.current || "";
    draftsRef.current[key] = text;
    composerRef.current?.setDraft(text);
  }

  async function submitPrompt(text: string) {
    if (composerSubmitting) return;
    const inputAttachments = attachments;
    const chips = fileContexts;
    if (!text && inputAttachments.length === 0 && chips.length === 0) return;

    if (text.startsWith("/")) {
      if (inputAttachments.length) {
        setNotice("Slash commands cannot include file attachments.");
        return;
      }
      const command = findSlashCommand(text);
      if (!command) {
        setNotice(`Unknown slash command: ${text}`);
        return;
      }
      clearComposerDraft();
      await executeSlashCommand(command);
      return;
    }

    if (selectedThread && activeTurnId && inputAttachments.length > 0) {
      setNotice(`${providerName(selectedProvider)} file attachments can be sent after the active turn finishes.`);
      return;
    }

    const expanded = expandFileContext(text, chips);
    const existingThread = selectedThread;
    clearComposerDraft();
    setFileContexts([]);
    setFileContextHighlight(null);
    const directAttachmentSend = inputAttachments.length > 0;
    if (existingThread) {
      const titled = withImmediateTitle(existingThread, expanded);
      if (titled !== existingThread) {
        const key = threadKey(existingThread);
        setSelectedThread((current) => (current && threadKey(current) === key ? { ...current, name: titled.name, preview: titled.preview } : current));
        setThreads((current) => current.map((thread) => (threadKey(thread) === key ? { ...thread, name: titled.name, preview: titled.preview } : thread)));
      }
      setPendingPrompt(expanded);
      markThreadLive(threadKey(existingThread));
    }
    const lockComposer = !existingThread || directAttachmentSend;
    if (lockComposer) setComposerSubmitting(true);
    try {
      if (!existingThread) await startThread(expanded, inputAttachments);
      else await sendToThread(threadKey(existingThread), expanded, undefined, inputAttachments);
      setAttachmentsByThread((current) => {
        if (!(attachmentBucket in current)) return current;
        const next = { ...current };
        delete next[attachmentBucket];
        return next;
      });
      if (existingThread && !directAttachmentSend && currentQueuePaused) {
        setNotice("Saved to the server, but this queue needs review. Retry a saved task below.", "warning");
      }
    } catch (error) {
      if (existingThread) clearThreadLive(threadKey(existingThread));
      setPendingPrompt("");
      setNotice(error instanceof Error ? error.message : String(error));
      restoreComposerDraft(text);
      setFileContexts(chips);
    } finally {
      if (lockComposer) setComposerSubmitting(false);
    }
  }

  async function submitSteerPrompt(text: string) {
    if (!text || !selectedThread || !activeTurnId) return;
    try {
      await steerCurrentTurn(text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      restoreComposerDraft(text);
    }
  }

  async function interrupt() {
    if (!selectedThread) return;
    if (!activeTurnId && sessionExecutionState.phase !== "running") return;
    const key = threadKey(selectedThread);
    try {
      await agent(providerOf(selectedThread), "turn/interrupt", { threadId: nativeThreadId(selectedThread), turnId: activeTurnId || undefined });
      updateActiveTurn(key, null);
      setSelectedThread((current) => current && threadKey(current) === key ? { ...current, status: { type: "cancelled" } } : current);
      setThreads((current) => current.map((thread) => threadKey(thread) === key ? { ...thread, status: { type: "cancelled" } } : thread));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }

  const refreshWorkspaceDiff = useCallback(async () => {
    if (!workspaceRoot) {
      setWorkspaceDiff(null);
      setWorkspaceDiffError("Choose a server directory before requesting a diff.");
      return;
    }
    setWorkspaceDiffKind("working");
    setWorkspaceDiffLoading(true);
    setWorkspaceDiffError("");
    try {
      setWorkspaceDiff(await getJson<ProjectDiff>(`/api/projects/diff?cwd=${encodeURIComponent(workspaceRoot)}`));
    } catch (error) {
      setWorkspaceDiff(null);
      setWorkspaceDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceDiffLoading(false);
    }
  }, [workspaceRoot]);

  const openWorkspaceFile = useCallback((filePath: string) => {
    setWorkspaceFileRequest(filePath);
    setWorkspaceView("files");
  }, []);

  const clearWorkspaceFileRequest = useCallback(() => setWorkspaceFileRequest(null), []);

  const handleLineSelect = useCallback((selection: { path: string; start: number; end: number; text: string }) => {
    setFileContexts((current) => upsertChip(current, {
      path: selection.path,
      startLine: selection.start,
      endLine: selection.end,
      text: selection.text
    }));
    setFileContextHighlight({ path: selection.path, start: selection.start, end: selection.end });
  }, []);

  const openFileContext = useCallback((chip: FileContextChip) => {
    if (chip.startLine && chip.endLine) {
      setFileContextHighlight({ path: chip.path, start: chip.startLine, end: chip.endLine });
    } else {
      setFileContextHighlight(null);
    }
    openWorkspaceFile(chip.path);
  }, [openWorkspaceFile]);

  const applyParsedMentions = useCallback((mentions: Array<{ path: string; startLine: number | null; endLine: number | null }>) => {
    const gen = ++mentionLoadGen.current;
    if (!mentions.length) return;
    setFileContexts((current) => {
      let next = current;
      for (const mention of mentions) {
        const existing = next.find((chip) => chip.path === mention.path);
        if (existing && mention.startLine == null) continue;
        if (existing && existing.startLine === mention.startLine && existing.endLine === mention.endLine) continue;
        next = upsertChip(next, {
          path: mention.path,
          startLine: mention.startLine,
          endLine: mention.endLine,
          text: ""
        });
      }
      return next;
    });
    if (!workspaceRoot) return;
    for (const mention of mentions) {
      if (!mention.startLine || !mention.endLine) continue;
      void getJson<ProjectFilePreview>(`/api/projects/read?${new URLSearchParams({ cwd: workspaceRoot, path: mention.path })}`)
        .then((file) => {
          if (gen !== mentionLoadGen.current || !file.content) return;
          const text = sliceFileLines(file.content, mention.startLine, mention.endLine);
          setFileContexts((current) => {
            const existing = current.find((chip) => chip.path === mention.path);
            if (!existing || existing.startLine !== mention.startLine || existing.endLine !== mention.endLine) return current;
            if (existing.text === text) return current;
            return upsertChip(current, { ...existing, text });
          });
        })
        .catch(() => undefined);
    }
  }, [workspaceRoot]);

  const openTurnDiff = useCallback((diff: ProjectDiff) => {
    setWorkspaceDiff(diff);
    setWorkspaceDiffKind("turn");
    setWorkspaceDiffError("");
    setWorkspaceView("diff");
  }, []);

  useEffect(() => {
    if (workspaceView === "diff" && workspaceDiffKind === "working") refreshWorkspaceDiff();
  }, [refreshWorkspaceDiff, workspaceDiffKind, workspaceView]);

  async function loadCommandPanel(panel: Exclude<CommandPanel, null>) {
    setCommandPanelLoading(true);
    setCommandPanelError("");
    try {
      const root = selectedRoot(selectedThread, project, cwd);
      if (panel === "provider") {
        setCommandPanelData(providerOrder.map((provider) => providerStatus(bootstrap, provider)));
      } else if (panel === "collab") {
        const response = await codex("collaborationMode/list", {});
        setCommandPanelData(response?.data || bootstrap?.codex?.collaborationModes || []);
      } else if (panel === "model") {
        setCommandPanelData(await agent(selectedProvider, "model/list", { limit: 100, includeHidden: false, provider: selectedProvider }));
      } else if (panel === "mcp") {
        setCommandPanelData(await codex("mcpServerStatus/list", { detail: "full", limit: 100 }));
      } else if (panel === "plugins") {
        setCommandPanelData(await codex("plugin/list", { cwds: root ? [root] : [] }));
      } else if (panel === "skills") {
        setCommandPanelData(await codex("skills/list", { cwds: root ? [root] : [], forceReload: false }));
      } else if (panel === "experimental") {
        setCommandPanelData(await codex("experimentalFeature/list", { limit: 100 }));
      } else if (panel === "diff") {
        if (!root) throw new Error("Choose a server directory before requesting a diff.");
        setCommandPanelData(await getJson<ProjectDiff>(`/api/projects/diff?cwd=${encodeURIComponent(root)}`));
      }
    } catch (error) {
      if (panel === "collab" && bootstrap?.codex?.collaborationModes?.length) {
        setCommandPanelData(bootstrap.codex.collaborationModes);
      }
      setCommandPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommandPanelLoading(false);
    }
  }

  async function openCommandPanel(panel: Exclude<CommandPanel, null>) {
    setCommandPanel(panel);
    setCommandPanelData(null);
    setCommandPanelError("");
    if (panel === "permissions") setPermissionDraft(runtimePermissionDraft(runtimeSettings));
    if (panel === "rename") setRenameValue(selectedThread ? threadTitle(selectedThread) : "");
    if (panel === "mention") {
      setMentionQuery("");
      setCommandPanelData({ files: [] });
    }
    if (["status", "permissions", "rename", "mention", "memories"].includes(panel)) return;
    await loadCommandPanel(panel);
  }

  providerDetailsActionRef.current = () => {
    openCommandPanel("provider").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
  };

  async function applyCollabPreset(preset: any) {
    if (preset?.mode !== "default" && preset?.mode !== "plan") {
      setNotice("This collaboration mode is not mapped in Coding Agent Console yet.");
      return;
    }
    updateRuntimeSettings({
      ...(preset.model ? { model: preset.model } : {}),
      reasoningEffort: runtimeSettings.reasoningEffort ?? preset.reasoning_effort ?? null
    });
    await selectSessionMode(preset.mode);
    setCommandPanel(null);
  }

  function selectModel(model: any, effort?: ReasoningEffort) {
    const nextModel = modelId(model);
    if (!nextModel) return;
    const supportedEfforts = modelReasoningOptions(model);
    const currentEffortSupported = supportedEfforts.includes(runtimeSettings.reasoningEffort);
    updateRuntimeSettings({
      model: nextModel,
      reasoningEffort:
        effort ?? (supportedEfforts.length
          ? (currentEffortSupported ? runtimeSettings.reasoningEffort : model?.defaultReasoningEffort ?? supportedEfforts[0])
          : null)
    });
    setCommandPanel(null);
    setNotice(`Model set to ${modelTitle(model)}. Future turns will use this session setting.`);
  }

  async function applyPermissionDraft() {
    const nextSettings = {
      ...runtimeSettings,
      approvalPolicy: permissionDraft.approvalPolicy,
      sandboxMode: permissionDraft.sandboxMode
    };
    updateRuntimeSettings(nextSettings);
    setCommandPanel(null);

    if (!selectedThread) {
      setNotice("Permissions updated for future sessions and turns.");
      return;
    }

    if (activeTurnId) {
      setNotice("Permissions updated locally and will apply after the active turn finishes.");
      return;
    }

    const provider = providerOf(selectedThread);
    const response = await agent(provider, "thread/resume", {
      threadId: nativeThreadId(selectedThread),
      provider,
      excludeTurns: provider === "codex",
      ...(provider === "codex" ? { forceResume: true } : {}),
      ...runtimeThreadParams(nextSettings)
    });
    const listedKey = threadKey(selectedThread);
    const resumed = normalizeThread({ ...(response.thread as Thread), provider });
    if (provider === "codex") warmThreadIdsRef.current.add(listedKey);
    selectedThreadIdRef.current = listedKey;
    setSelectedThread((current) => current && threadKey(current) === listedKey ? hydrateListedThread(current, resumed) : current);
    const queueTurnId = activeQueueTurns(queueSnapshotRef.current).get(listedKey) || null;
    updateActiveTurn(listedKey, queueTurnId || activeTurnIdFromTurns(resumed.turns || []));
    setThreads((current) => patchListedThread(current, resumed, listedKey));
    if (provider !== "codex" && turnsHaveItems(resumed.turns)) applyItemsFromTurns(listedKey, resumed.turns);
    updateRuntimeSettings((current) =>
      mergeThreadRuntimeSettings(current, response, { sandboxMode: nextSettings.sandboxMode, mode: current.mode })
    );
    setNotice("Permissions refreshed for the idle session.");
  }

  async function saveRename() {
    if (!selectedThread) return;
    const name = renameValue.trim();
    if (!name) {
      setNotice("Enter a session title first.");
      return;
    }
    const key = threadKey(selectedThread);
    await agent(providerOf(selectedThread), "thread/name/set", { threadId: nativeThreadId(selectedThread), name, provider: providerOf(selectedThread) });
    setSelectedThread((current) => (current && threadKey(current) === key ? { ...current, name } : current));
    setThreads((current) => current.map((thread) => (threadKey(thread) === key ? { ...thread, name } : thread)));
    setCommandPanel(null);
    setNotice("Session renamed.");
  }

  async function forkCurrentThread(ephemeral: boolean) {
    if (!selectedThread) return;
    const response = await codex("thread/fork", {
      threadId: nativeThreadId(selectedThread),
      ephemeral,
      excludeTurns: false,
      persistExtendedHistory: true,
      ...runtimeThreadParams(runtimeSettings)
    });
    const thread = normalizeThread({ ...(response.thread as Thread), provider: "codex" });
    const key = threadKey(thread);
    knownThreadIdsRef.current.add(key);
    warmThreadIdsRef.current.add(key);
    dismissedThreadIdsRef.current.delete(key);
    selectedThreadIdRef.current = key;
    setSelectedThread(thread);
    updateActiveTurn(key, activeTurnIdFromTurns(thread.turns || []));
    setThreads((current) => mergeThreadsById(current, [thread]));
    applyItemsFromTurns(key, thread.turns || []);
    updateRuntimeSettings((current) => mergeThreadRuntimeSettings(current, response, { mode: current.mode }));
    setNotice(ephemeral ? "Side session created." : "Session forked.");
  }

  async function copyLatestOutput() {
    if (!latestPlanText) {
      setNotice("There is no assistant or plan output to copy yet.");
      return;
    }
    await navigator.clipboard?.writeText(latestPlanText);
    setNotice("Latest assistant output copied.");
  }

  function insertMention(result: any) {
    const path = String(result?.path || result?.file_name || "");
    if (!path) return;
    composerRef.current?.appendText(`@${path}`);
    setFileContexts((current) => upsertChip(current, { path, startLine: null, endLine: null, text: "" }));
    setCommandPanel(null);
  }

  async function toggleExperimentalFeature(feature: any) {
    const name = String(feature?.name || "");
    if (!name) return;
    await codex("experimentalFeature/enablement/set", { enablement: { [name]: !feature.enabled } });
    await loadCommandPanel("experimental");
  }

  async function setMemoryMode(mode: "enabled" | "disabled") {
    if (!selectedThread) return;
    await codex("thread/memoryMode/set", { threadId: nativeThreadId(selectedThread), mode });
    setCommandPanel(null);
    setNotice(`Memory mode ${mode}.`);
  }

  async function executeSlashCommand(command: SlashCommand) {
    const disabledReason = slashCommandDisabledReason(command, slashContext);
    if (disabledReason) {
      setNotice(disabledReason);
      return;
    }

    setNotice("");
    try {
      if (command.action === "set-mode") {
        const nextMode: ModeKind = command.id === "plan" ? "plan" : command.id === "ask" ? "ask" : "default";
        await selectSessionMode(nextMode);
        return;
      }

      if (command.action === "open-panel") {
        await openCommandPanel(command.id as Exclude<CommandPanel, null>);
        return;
      }

      if (command.action === "toggle-fast") {
        const serviceTier: ServiceTier = isFastServiceTier(runtimeSettings.serviceTier) ? "default" : "priority";
        updateRuntimeSettings({ serviceTier });
        setNotice(`Fast mode ${isFastServiceTier(serviceTier) ? "enabled" : "disabled"} for future turns. Service tier: ${serviceTier}.`);
        return;
      }

      if (command.action === "run-review" && selectedThread) {
        try {
          if (providerOf(selectedThread) !== "codex") throw new Error("review/start unsupported for this provider");
          const response = await codex("review/start", {
            threadId: nativeThreadId(selectedThread),
            target: { type: "uncommittedChanges" },
            delivery: "inline"
          });
          updateActiveTurn(threadKey(selectedThread), response?.turn?.id || null);
          setNotice("Review started in the current session.");
        } catch (error) {
          if (!looksUnsupportedMethod(error)) throw error;
          await startTurn(
            threadKey(selectedThread),
            [
              "Review my current uncommitted working-tree changes.",
              "Focus on bugs, regressions, security issues, and missing tests.",
              "Use git diff/status as needed, cite file:line references, and lead with findings ordered by severity.",
              "If there are no issues, say that clearly and mention any remaining test gaps."
            ].join("\n"),
            undefined,
            [],
            "default"
          );
          setNotice("Review started with the standard Codex review prompt.");
        }
        return;
      }

      if (command.action === "new-thread") {
        beginDraftSession();
        return;
      }

      if (command.action === "resume-thread") {
        openSessionManager();
        setNotice("Choose a saved session from the session list.");
        return;
      }

      if (command.action === "fork-thread") {
        await forkCurrentThread(false);
        return;
      }

      if (command.action === "side-thread") {
        await forkCurrentThread(true);
        return;
      }

      if (command.action === "compact-thread" && selectedThread) {
        await codex("thread/compact/start", { threadId: nativeThreadId(selectedThread) });
        setNotice("Conversation compaction started.");
        return;
      }

      if (command.action === "copy-last") {
        await copyLatestOutput();
        return;
      }

      if (command.action === "show-diff") {
        setWorkspaceDiffKind("working");
        setWorkspaceView("diff");
        return;
      }

      if (command.action === "logout") {
        await logout();
        return;
      }

      if (command.action === "exit-thread") {
        if (!selectedThread) {
          setNotice("No session is selected. The browser app cannot be exited from inside the page.");
          return;
        }
        await closeThread();
        return;
      }

      if (command.action === "stop-work") {
        if (selectedThread && activeTurnId) {
          await interrupt();
          return;
        }
        if (selectedThread) {
          await codex("thread/backgroundTerminals/clean", { threadId: nativeThreadId(selectedThread) });
          setNotice("Background terminals cleaned for this session.");
          return;
        }
        setNotice("No active turn or selected session to stop.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function closeThreadTarget(thread: Thread) {
    const closingId = threadKey(thread);
    if (activeTurnIdsByThread[closingId]) {
      setNotice("Stop the active turn before closing this session.", "warning");
      return;
    }
    const provider = providerOf(thread);
    await agent(provider, "thread/archive", { threadId: nativeThreadId(thread), provider });
    if (provider === "codex") {
      await codex("thread/unsubscribe", { threadId: nativeThreadId(thread) }).catch(() => undefined);
    }
    dismissedThreadIdsRef.current.add(closingId);
    knownThreadIdsRef.current.delete(closingId);
    removeArchivedThread(closingId);
    setNotice("Session closed.", "success");
  }

  async function closeThread() {
    if (!selectedThread) return;
    await closeThreadTarget(selectedThread);
  }

  const selectFleetThread = useCallback((key: string) => {
    const thread = threadByKey.get(key);
    if (!thread) return;
    setWorkspaceView("chat");
    setMobilePanel(null);
    resumeThread(thread).catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
  }, [threadByKey]);

  function selectAdjacentThread(thread: Thread | null) {
    if (!thread) return;
    setWorkspaceView("chat");
    resumeThread(thread).catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
  }

  const renameFleetThread = useCallback((key: string) => {
    const thread = threadByKey.get(key);
    if (!thread) return;
    selectedThreadIdRef.current = key;
    setSelectedThread(thread);
    selectProviderPreference(providerOf(thread));
    setRenameValue(threadTitle(thread));
    setCommandPanelData(null);
    setCommandPanelError("");
    setCommandPanel("rename");
    setMobilePanel(null);
  }, [threadByKey]);

  const manageFleetThread = useCallback((key: string) => {
    const thread = threadByKey.get(key);
    if (!thread) return;
    setSessionManagerSearch(threadTitle(thread));
    setSessionManagerProviderFilter(providerOf(thread));
    openSessionManager();
  }, [threadByKey]);

  const closeFleetThread = useCallback((key: string) => {
    const thread = threadByKey.get(key);
    if (!thread) return;
    closeThreadTarget(thread).catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"));
  }, [threadByKey]);

  async function answerServerRequest(request: ServerRequest, result: unknown) {
    setPendingRequests((current) => current.filter((item) => item.id !== request.id));
    const provider = ((request.params as { provider?: ProviderId } | undefined)?.provider || "codex") as ProviderId;
    if (provider !== "codex" && bootstrap?.providers) {
      await call({
        type: "agent:serverResponse",
        provider,
        serverRequestId: request.id,
        result
      });
      return;
    }
    await call({
      type: "codex:serverResponse",
      serverRequestId: request.id,
      result
    });
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const availableSlots = Math.max(0, uploadMaxFiles - attachments.length - uploadSlotsInUse.current);
    if (!availableSlots) {
      setNotice(`You can attach up to ${uploadMaxFiles} files at a time.`, "warning");
      return;
    }

    const selectedFiles = files.slice(0, availableSlots);
    const acceptedFiles = selectedFiles.filter((file) => file.size <= uploadMaxBytes);
    const rejectedFiles = selectedFiles.filter((file) => file.size > uploadMaxBytes);
    if (!acceptedFiles.length) {
      setNotice(`${rejectedFiles[0]?.name || "File"} exceeds the ${formatBytes(uploadMaxBytes)} server upload limit.`, "warning");
      return;
    }

    uploadSlotsInUse.current += acceptedFiles.length;
    setUploadsInProgress((current) => current + acceptedFiles.length);
    try {
      const results = await Promise.allSettled(acceptedFiles.map(uploadServerFile));
      const next = results.flatMap((result) => result.status === "fulfilled" ? [{
        id: result.value.id,
        name: result.value.name,
        type: result.value.contentType,
        size: result.value.size,
        image: result.value.image,
        url: uploadPreviewUrl(result.value.id)
      }] : []);
      if (next.length) {
        setAttachmentsByThread((current) => ({
          ...current,
          [attachmentBucket]: [...(current[attachmentBucket] || []), ...next].slice(0, uploadMaxFiles)
        }));
      }

      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length || rejectedFiles.length || files.length > selectedFiles.length) {
        const firstFailure = failures[0]?.reason;
        const detail = firstFailure instanceof Error
          ? firstFailure.message
          : rejectedFiles.length
            ? `${rejectedFiles[0].name} exceeds the ${formatBytes(uploadMaxBytes)} server upload limit.`
            : `Only ${uploadMaxFiles} files can be attached at a time.`;
        setNotice(`${next.length ? `${next.length} file${next.length === 1 ? "" : "s"} uploaded. ` : ""}${detail}`, "warning");
      } else {
        setNotice(`${next.length} file${next.length === 1 ? "" : "s"} uploaded to the server.`, "success");
      }
    } finally {
      uploadSlotsInUse.current = Math.max(0, uploadSlotsInUse.current - acceptedFiles.length);
      setUploadsInProgress((current) => Math.max(0, current - acceptedFiles.length));
    }
  }

  function removeAttachment(id: string) {
    const attachment = attachments.find((item) => item.id === id);
    setAttachmentsByThread((current) => {
      const items = (current[attachmentBucket] || []).filter((attachment) => attachment.id !== id);
      if (!items.length) {
        if (!(attachmentBucket in current)) return current;
        const next = { ...current };
        delete next[attachmentBucket];
        return next;
      }
      return { ...current, [attachmentBucket]: items };
    });
    if (attachment) {
      void deleteServerFile(attachment.id).catch((error) => {
        setNotice(`Removed ${attachment.name} here, but server cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    }
  }

  function renderSessionManager() {
    if (!sessionManagerOpen) return null;

    return (
      <div className="dialogBackdrop sessionManagerBackdrop">
        <section className="dialog sessionManagerDialog">
          <header className="sessionManagerHeader">
            <div>
              <h2>Session Manager</h2>
              <p>{sessionManagerArchived ? "Archived sessions are hidden from the default list." : "Browse and manage sessions across directories."}</p>
            </div>
            <button aria-label="Close session manager" title="Close session manager" type="button" onClick={() => setSessionManagerOpen(false)}>
              <X aria-hidden="true" size={17} />
            </button>
          </header>

          <div className="sessionManagerToolbar">
            <label className="sessionSearch">
              <Search size={16} />
              <input
                aria-label="Search sessions"
                autoComplete="off"
                name="session-search"
                value={sessionManagerSearch}
                onChange={(event) => setSessionManagerSearch(event.target.value)}
                placeholder="Search sessions…"
              />
            </label>
            <div className="segmentedMini sessionScopeToggle">
              <button
                className={sessionManagerProviderFilter === "all" ? "active" : ""}
                type="button"
                onClick={() => setSessionManagerProviderFilter("all")}
              >
                All
              </button>
              <button
                className={sessionManagerProviderFilter === "codex" ? "active" : ""}
                type="button"
                onClick={() => setSessionManagerProviderFilter("codex")}
              >
                Codex
              </button>
              <button
                className={sessionManagerProviderFilter === "cursor" ? "active" : ""}
                type="button"
                onClick={() => setSessionManagerProviderFilter("cursor")}
              >
                Cursor
              </button>
              <button
                className={sessionManagerProviderFilter === "claude" ? "active" : ""}
                type="button"
                onClick={() => setSessionManagerProviderFilter("claude")}
              >
                Claude
              </button>
            </div>
            <div className="segmentedMini sessionScopeToggle">
              <button
                className={!sessionManagerArchived ? "active" : ""}
                type="button"
                onClick={() => setSessionManagerArchived(false)}
              >
                Active
              </button>
              <button
                className={sessionManagerArchived ? "active" : ""}
                type="button"
                onClick={() => setSessionManagerArchived(true)}
              >
                Archived
              </button>
            </div>
            <div className="segmentedMini sessionLayoutToggle">
              <button
                className={threadLayout === "directories" ? "active" : ""}
                type="button"
                onClick={() => updateThreadLayout("directories")}
              >
                Directories
              </button>
              <button
                className={threadLayout === "recent" ? "active" : ""}
                type="button"
                onClick={() => updateThreadLayout("recent")}
              >
                Recent
              </button>
            </div>
            <button
              className="sessionManagerIconButton"
              title="Refresh sessions"
              type="button"
              onClick={() => loadSessionManagerPage(null)}
              disabled={sessionManagerLoading || wsState !== "online"}
            >
              <RefreshCcw size={16} />
            </button>
          </div>

          {sessionManagerError ? <p className="errorText">{sessionManagerError}</p> : null}

          <div className="sessionManagerList">
            {!sessionManagerLoading && sessionManagerThreads.length === 0 ? (
              <p className="muted">{sessionManagerArchived ? "No archived sessions found." : "No sessions found."}</p>
            ) : null}
            {threadLayout === "recent" ? (
              <div className="managerThreadRows">
                {orderedSessionManagerThreads.map((thread) => {
                  const active = threadIsActive(thread, activeTurnIdsByThread);
                  const key = threadKey(thread);
                  const busy = sessionManagerBusy === key;
                  return (
                    <div className={`managerThreadRow ${threadKey(selectedThread) === key ? "selected" : ""}`} key={key}>
                      <button
                        className="managerThreadMain managerThreadMainFlat"
                        type="button"
                        onClick={() => chooseManagedThread(thread).catch((error) => setNotice(error.message))}
                      >
                        <strong>{thread.name || thread.preview || "Untitled session"}</strong>
                        <small>{formatTime(thread.updatedAt)}</small>
                        <small className="providerBadge">{providerName(providerOf(thread))}</small>
                        <small title={thread.cwd}>{directoryLabel(thread.cwd)}</small>
                        <small>{statusLabel(thread.status)}</small>
                      </button>
                      <div className="managerThreadActions">
                        {sessionManagerArchived ? (
                          <button
                            title="Restore session"
                            type="button"
                            disabled={busy}
                            onClick={() => restoreManagedThread(thread).catch((error) => setNotice(error.message))}
                          >
                            <RotateCcw size={15} />
                          </button>
                        ) : (
                          <button
                            className="dangerIconButton"
                            title={active ? "Stop this active session before archiving" : "Archive session"}
                            type="button"
                            disabled={active || busy}
                            onClick={() => archiveManagedThread(thread).catch((error) => setNotice(error.message))}
                          >
                            <Archive size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : sessionManagerGroups.map((group) => {
              const collapsed = collapsedSessionManagerGroupSet.has(group.cwd);
              const idleCount = group.threads.filter((thread) => !threadIsActive(thread, activeTurnIdsByThread)).length;
              return (
                <section className="managerThreadGroup" key={group.cwd}>
                  <div className="managerThreadGroupHeader" title={group.cwd}>
                    <button
                      className="managerThreadGroupToggle"
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => toggleSessionManagerGroup(group.cwd)}
                    >
                      <ChevronRight className={collapsed ? "" : "expanded"} size={15} />
                      <Folder size={15} />
                      <span>{group.label}</span>
                      <small>{group.threads.length}</small>
                    </button>
                    {!sessionManagerArchived ? (
                      <button
                        className="managerArchiveDirectory"
                        title="Archive idle sessions in this directory"
                        type="button"
                        disabled={!idleCount || sessionManagerBusy === `group:${group.cwd}`}
                        onClick={() => archiveSessionGroup(group).catch((error) => setNotice(error.message))}
                      >
                        <Archive size={14} />
                        <span>{idleCount}</span>
                      </button>
                    ) : null}
                  </div>
                  {collapsed ? null : (
                    <div className="managerThreadGroupBody">
                      <div className="threadGroupPath" dir="ltr" title={group.cwd} translate="no">{group.cwd}</div>
                      <div className="managerThreadRows">
                        {group.threads.map((thread) => {
                          const active = threadIsActive(thread, activeTurnIdsByThread);
                          const key = threadKey(thread);
                          const busy = sessionManagerBusy === key;
                          return (
                            <div className={`managerThreadRow ${threadKey(selectedThread) === key ? "selected" : ""}`} key={key}>
                              <button
                                className="managerThreadMain"
                                type="button"
                                onClick={() => chooseManagedThread(thread).catch((error) => setNotice(error.message))}
                              >
                                <strong>{thread.name || thread.preview || "Untitled session"}</strong>
                                <small>{formatTime(thread.updatedAt)}</small>
                                <small className="providerBadge">{providerName(providerOf(thread))}</small>
                                <small>{statusLabel(thread.status)}</small>
                              </button>
                              <div className="managerThreadActions">
                                {sessionManagerArchived ? (
                                  <button
                                    title="Restore session"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => restoreManagedThread(thread).catch((error) => setNotice(error.message))}
                                  >
                                    <RotateCcw size={15} />
                                  </button>
                                ) : (
                                  <button
                                    className="dangerIconButton"
                                    title={active ? "Stop this active session before archiving" : "Archive session"}
                                    type="button"
                                    disabled={active || busy}
                                    onClick={() => archiveManagedThread(thread).catch((error) => setNotice(error.message))}
                                  >
                                    <Archive size={15} />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          <footer>
            <button type="button" onClick={() => setSessionManagerOpen(false)}>
              <X size={17} />
              Close
            </button>
            {sessionManagerCursor ? (
              <button type="button" onClick={() => loadSessionManagerPage(sessionManagerCursor)} disabled={sessionManagerLoading}>
                <ArrowUp className="loadMoreIcon" size={17} />
                Load more
              </button>
            ) : null}
          </footer>
        </section>
      </div>
    );
  }

  function renderCommandPanel() {
    if (!commandPanel) return null;

    const close = () => setCommandPanel(null);
    const rows: any[] = responseData(commandPanelData);
    const root = selectedRoot(selectedThread, project, cwd);

    return (
      <div className="dialogBackdrop">
        <section className={`dialog commandDialog commandDialog-${commandPanel}`}>
          <header>
            <h2>{panelTitle(commandPanel)}</h2>
          </header>

          {commandPanelLoading ? <p className="muted">Loading…</p> : null}
          {commandPanelError ? <p className="errorText">{commandPanelError}</p> : null}

          {commandPanel === "provider" ? (
            <div className="providerPanel">
              {providerOrder.map((provider) => {
                const status = providerStatus(bootstrap, provider);
                const active = selectedProvider === provider;
                const capabilities = Object.entries(status.capabilities || {})
                  .filter(([, enabled]) => enabled)
                  .map(([name]) => name);
                return (
                  <button
                    className={`providerCard ${active ? "selected" : ""}`}
                    key={provider}
                    type="button"
                    onClick={() => switchProvider(provider).catch((error) => setNotice(error.message))}
                  >
                    <span>
                      <strong>{providerName(provider)}</strong>
                      <small>{status.version || "version unknown"}</small>
                    </span>
                    <code className={providerAvailable(status) ? "providerAvailable" : "providerUnavailable"}>
                      {status.availability || "unknown"}
                    </code>
                    <small>{status.authStatus || "auth unknown"}</small>
                    <small>{active ? "Current for new sessions" : "Use for the next session"}</small>
                    <small>{capabilities.slice(0, 8).join(", ")}</small>
                    {provider === "cursor" ? <small className="providerModeWarning">{cursorExecutionModeDescription}</small> : null}
                  </button>
                );
              })}
              <p className="muted">This only chooses the next agent. Send a task to create the session.</p>
            </div>
          ) : null}

          {commandPanel === "collab" ? (
            <div className="commandList">
              {(rows.length ? rows : bootstrap?.codex?.collaborationModes || []).map((preset: any) => {
                const mapped = preset?.mode === "default" || preset?.mode === "plan";
                return (
                  <button
                    className={`commandRow ${preset?.mode === mode ? "selected" : ""}`}
                    disabled={!mapped}
                    key={`${preset?.name || preset?.mode}`}
                    type="button"
                    onClick={() => applyCollabPreset(preset)}
                  >
                    <span>
                      <strong>{String(preset?.name || modeLabel(preset?.mode || "default"))}</strong>
                      <small>
                        {mapped ? modeLabel(preset.mode) : "No web mapping"}
                        {preset?.model ? ` / ${preset.model}` : " / selected session model"}
                        {preset?.reasoning_effort ? ` / ${preset.reasoning_effort}` : ""}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {commandPanel === "model" ? (
            <div className="commandList">
              {rows.map((model) => {
                const reasoningOptions = modelReasoningOptions(model);
                const active = modelId(model) === runtimeSettings.model;
                const description = modelDescription(model);
                return (
                  <div className={`commandRow modelRow ${active ? "selected" : ""}`} key={modelId(model)}>
                    <button type="button" onClick={() => selectModel(model)}>
                      <span>
                        <strong>{modelTitle(model)}</strong>
                        {description ? <small>{description}</small> : null}
                      </span>
                      {model?.isDefault ? <code>default</code> : null}
                    </button>
                    {reasoningOptions.length ? (
                      <div className="segmentedMini">
                        {reasoningOptions.map((effort) => (
                          <button
                            className={active && runtimeSettings.reasoningEffort === effort ? "active" : ""}
                            key={`${modelId(model)}-${effort}`}
                            type="button"
                            onClick={() => selectModel(model, effort)}
                          >
                            {effort}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {commandPanel === "permissions" ? (
            <div className="settingsGrid">
              <label>
                <span>Approval policy</span>
                <select
                  value={approvalPolicyValue(permissionDraft.approvalPolicy)}
                  onChange={(event) =>
                    setPermissionDraft((current) => ({
                      ...current,
                      approvalPolicy: (event.target.value || null) as ApprovalPolicy
                    }))
                  }
                >
                  <option value="on-request">On request</option>
                  <option value="on-failure">On failure</option>
                  <option value="untrusted">Untrusted</option>
                  <option value="never">Never</option>
                  {approvalPolicyValue(permissionDraft.approvalPolicy) === "granular" ? (
                    <option value="granular" disabled>
                      Granular
                    </option>
                  ) : null}
                </select>
              </label>
              <label>
                <span>Sandbox mode</span>
                <select
                  value={sandboxModeValue(permissionDraft.sandboxMode)}
                  onChange={(event) =>
                    setPermissionDraft((current) => ({
                      ...current,
                      sandboxMode: (event.target.value || null) as SandboxMode
                    }))
                  }
                >
                  <option value="read-only">Read only</option>
                  <option value="workspace-write">Workspace write</option>
                  <option value="danger-full-access">Danger full access</option>
                </select>
              </label>
              <p className="muted">
                If the selected session is idle, applying refreshes it with thread/resume. During an active turn the
                setting is staged for the next turn.
              </p>
            </div>
          ) : null}

          {commandPanel === "rename" ? (
            <div className="settingsGrid">
              <label>
                <span>Session title</span>
                <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
              </label>
            </div>
          ) : null}

          {commandPanel === "mention" ? (
            <div className="settingsGrid">
              <label>
                <span>Find file</span>
                <input
                  value={mentionQuery}
                  onChange={(event) => setMentionQuery(event.target.value)}
                  placeholder="Type a filename or path"
                  autoFocus
                />
              </label>
              <div className="commandList">
                {rows.map((result) => (
                  <button className="commandRow" key={`${result.root}-${result.path}`} type="button" onClick={() => insertMention(result)}>
                    <span>
                      <strong>{String(result.file_name || result.path)}</strong>
                      <small>{String(result.path || result.root || "")}</small>
                    </span>
                    <code>{String(result.match_type || "file")}</code>
                  </button>
                ))}
                {mentionQuery && !rows.length && !commandPanelLoading ? <p className="muted">No files found under {root}.</p> : null}
              </div>
            </div>
          ) : null}

          {commandPanel === "status" ? (
            <dl className="statusGrid">
              <dt>Thread</dt>
              <dd>{selectedThread?.id || "none"}</dd>
              <dt>CWD</dt>
              <dd>{root || "none"}</dd>
              <dt>Model</dt>
              <dd>{displayedModel || "not reported"}</dd>
              <dt>Reasoning</dt>
              <dd>{displayedReasoning || "not reported"}</dd>
              <dt>Fast mode</dt>
              <dd>{displayedServiceTier ? (displayedFastMode ? "enabled" : "disabled") : "not reported"}</dd>
              <dt>Service tier</dt>
              <dd>{displayedServiceTier || "not reported"}</dd>
              <dt>Mode</dt>
              <dd>{modeLabel(mode)}</dd>
              <dt>Approval</dt>
              <dd>{shortJson(runtimeSettings.approvalPolicy)}</dd>
              <dt>Sandbox</dt>
              <dd>{runtimeSettings.sandboxMode || "server default"}</dd>
              <dt>Token usage</dt>
              <dd>{usageLabel || "not reported"}</dd>
              <dt>Connection</dt>
              <dd>{wsState}</dd>
            </dl>
          ) : null}

          {commandPanel === "mcp" ? (
            <div className="commandList">
              {rows.length === 0 ? <p className="muted">No MCP servers configured.</p> : null}
              {rows.map((server) => {
                const name = String(server.name);
                const tools = Object.entries(server.tools || {}) as Array<[string, any]>;
                const expanded = expandedMcpServers.has(name);
                const recent = mcpRecentByServer[name] || [];
                const auth = String(server.authStatus || "");
                return (
                  <section className={`commandSection mcpServer ${expanded ? "expanded" : ""}`} key={name}>
                    <button
                      className="mcpServerHeader"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleMcpServerExpanded(name)}
                    >
                      <ChevronRight className={expanded ? "expanded" : ""} size={14} />
                      <strong>{name}</strong>
                      <small>{tools.length} tools</small>
                      {recent.length > 0 ? <small>{recent.length} recent</small> : null}
                      <small className={`mcpAuthBadge auth-${auth || "unknown"}`}>{auth || "unknown"}</small>
                    </button>
                    {expanded ? (
                      <>
                        <div className="mcpToolList">
                          {tools.length === 0 ? (
                            <p className="muted">No tools exposed.</p>
                          ) : (
                            tools.map(([toolName, tool]) => (
                              <div className="mcpToolRow" key={toolName}>
                                <strong>{toolName}</strong>
                                <small>{String((tool as any)?.description || "")}</small>
                              </div>
                            ))
                          )}
                        </div>
                        {recent.length > 0 ? (
                          <div className="mcpRecentList">
                            <h4>Recent calls in this session</h4>
                            {recent.map((call) => (
                              <div className="mcpRecentRow" key={call.id}>
                                <code>{call.tool}</code>
                                <small className={`mcpCallStatus status-${call.status}`}>{call.status}</small>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}

          {commandPanel === "plugins" ? (
            <div className="commandList">
              {(commandPanelData?.marketplaces || []).map((marketplace: any) => (
                <section className="commandSection" key={String(marketplace.name)}>
                  <h3>{String(marketplace.name)}</h3>
                  {(marketplace.plugins || []).map((plugin: any) => (
                    <div className="commandRow staticRow" key={String(plugin.id)}>
                      <span>
                        <strong>{String(plugin.name || plugin.id)}</strong>
                        <small>{String(plugin.interface?.description || plugin.interface?.shortDescription || plugin.id)}</small>
                      </span>
                      <code>{plugin.enabled ? "enabled" : plugin.installed ? "installed" : "available"}</code>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : null}

          {commandPanel === "skills" ? (
            <div className="commandList">
              {rows.map((entry) => (
                <section className="commandSection" key={String(entry.cwd)}>
                  <h3>{String(entry.cwd)}</h3>
                  {(entry.skills || []).map((skill: any) => (
                    <div className="commandRow staticRow" key={`${entry.cwd}-${skill.name}`}>
                      <span>
                        <strong>{String(skill.interface?.displayName || skill.name)}</strong>
                        <small>{String(skill.description || skill.shortDescription || skill.path)}</small>
                      </span>
                      <code>{skill.enabled ? "enabled" : "disabled"}</code>
                    </div>
                  ))}
                  {(entry.errors || []).map((error: any, index: number) => (
                    <p className="errorText" key={`${entry.cwd}-error-${index}`}>
                      {shortJson(error)}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          ) : null}

          {commandPanel === "experimental" ? (
            <div className="commandList">
              {rows.map((feature) => (
                <div className="commandRow staticRow" key={String(feature.name)}>
                  <span>
                    <strong>{String(feature.displayName || feature.name)}</strong>
                    <small>{String(feature.description || feature.stage || "")}</small>
                  </span>
                  <button type="button" onClick={() => toggleExperimentalFeature(feature)}>
                    {feature.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {commandPanel === "memories" ? (
            <div className="settingsGrid">
              <p className="muted">Set memory mode for the selected thread.</p>
              <div className="buttonRow">
                <button type="button" onClick={() => setMemoryMode("enabled")} disabled={!selectedThread}>
                  Enable memory
                </button>
                <button type="button" onClick={() => setMemoryMode("disabled")} disabled={!selectedThread}>
                  Disable memory
                </button>
              </div>
            </div>
          ) : null}

          {commandPanel === "diff" ? (
            <ProjectDiffPanel data={(commandPanelData as ProjectDiff | null) || null} />
          ) : null}

          <footer>
            <button type="button" onClick={close}>
              <X size={17} />
              Close
            </button>
            {commandPanel === "permissions" ? (
              <button className="primaryButton" type="button" onClick={() => applyPermissionDraft().catch((error) => setNotice(error.message))}>
                <Check size={17} />
                Apply
              </button>
            ) : null}
            {commandPanel === "rename" ? (
              <button className="primaryButton" type="button" onClick={() => saveRename().catch((error) => setNotice(error.message))}>
                <Check size={17} />
                Rename
              </button>
            ) : null}
            {commandPanel === "diff" && commandPanelData?.diff ? (
              <button type="button" onClick={() => navigator.clipboard?.writeText(String(commandPanelData.diff))}>
                <Copy size={17} />
                Copy diff
              </button>
            ) : null}
          </footer>
        </section>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <main className="boot">
        <p className="errorText">{bootstrapError}</p>
        <button
          type="button"
          onClick={() => {
            setBootstrapError(null);
            fetchBootstrap()
              .then((nextBootstrap) => {
                setBootstrap(nextBootstrap);
                if (nextBootstrap.defaultCwd) {
                  const nextCwd = nextBootstrap.defaultCwd;
                  setCwd((current) => current || nextCwd);
                }
              })
              .catch((error) => setBootstrapError(error instanceof Error ? error.message : String(error)));
          }}
        >
          Retry
        </button>
      </main>
    );
  }

  if (!bootstrap) {
    return <main className="boot">Loading Coding Agent Console…</main>;
  }

  if (!bootstrap.authenticated) {
    return (
      <main className="loginShell">
        <form className="loginPanel" onSubmit={login}>
          <Code2 size={32} />
          <h1>Coding Agent Console</h1>
          <p>Private access to server-side coding agent sessions.</p>
          <input
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password or token"
            type="password"
          />
          <button type="submit">
            <ShieldCheck size={18} />
            Sign in
          </button>
          {notice ? <p className="errorText">{notice}</p> : null}
        </form>
      </main>
    );
  }

  return (
    <main
      className={`appShell ${sidebarCollapsed ? "sessionsCollapsed" : ""}`}
      ref={appShellRef}
      style={{ "--sidebar-width": `${sidebarWidth}px`, "--context-width": `${contextWidth}px` } as CSSProperties}
    >
      {mobilePanel ? (
        <button
          aria-label="Close mobile panel"
          className="mobileScrim"
          type="button"
          onClick={() => setMobilePanel(null)}
        />
      ) : null}

      <aside className={`sidebar ${sidebarCollapsed && !mobilePanel ? "collapsedSidebar" : ""} ${mobilePanel ? "mobileOpen" : ""} ${mobilePanel ? `mobilePanel-${mobilePanel}` : ""}`}>
        {!sidebarCollapsed && !mobilePanel ? (
          <button
            aria-label="Resize sessions sidebar"
            className={`sidebarResizeHandle ${sidebarResizing ? "active" : ""}`}
            type="button"
            onPointerDown={startSidebarResize}
          />
        ) : null}
        {sidebarCollapsed && !mobilePanel ? (
          <div className="sidebarRail">
            <button aria-label="Expand sessions" title="Expand sessions" type="button" onClick={() => setSidebarCollapsedValue(false)}>
              <PanelLeftOpen aria-hidden="true" size={18} />
            </button>
            <button aria-label={`New ${providerName(selectedProvider)} session`} title={`New ${providerName(selectedProvider)} session`} type="button" onClick={beginDraftSession} disabled={!cwd.trim()}>
              <SquarePen aria-hidden="true" size={18} />
            </button>
            <button aria-label={`Manage ${threads.length} sessions`} title="Manage sessions" type="button" onClick={openSessionManager}>
              <History aria-hidden="true" size={18} />
              <span>{threads.length}</span>
            </button>
          </div>
        ) : (
          <>
        <div className="brand">
          <Code2 size={24} />
          <div>
            <h1>Console</h1>
            <span>{providerName(selectedProvider)}</span>
          </div>
          <div className="brandActions">
            <button aria-label="Collapse sessions" className="desktopCollapseButton" title="Collapse sessions" type="button" onClick={() => setSidebarCollapsedValue(true)}>
              <PanelLeftClose aria-hidden="true" size={17} />
            </button>
          <button aria-label="Close sessions" className="mobileSheetClose" title="Close panel" type="button" onClick={() => setMobilePanel(null)}>
            <X aria-hidden="true" size={17} />
          </button>
          </div>
        </div>

        <section className="providerStrip" aria-label="New session">
          <div className="providerToggle" role="radiogroup" aria-label="Agent for new sessions">
            {providerOrder.map((provider) => {
              const status = providerStatus(bootstrap, provider);
              const available = providerAvailable(status);
              const selected = selectedProvider === provider;
              return (
                <button
                  aria-checked={selected}
                  aria-label={providerName(provider)}
                  className={`providerChip ${selected ? "active" : ""} ${available ? "" : "unavailable"}`}
                  disabled={sessionCreating || !available}
                  key={provider}
                  role="radio"
                  title={`${providerName(provider)} · ${status.availability || "unknown"} · ${status.authStatus || "auth unknown"}`}
                  type="button"
                  onClick={() => switchProvider(provider).catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"))}
                >
                  <span>{providerName(provider)}</span>
                  <small>{available ? "ready" : "unavailable"}</small>
                </button>
              );
            })}
          </div>
          <div className="providerStripActions">
            <button
              className="newSessionPrimary"
              disabled={!cwd.trim() || !providerAvailable(currentProviderStatus)}
              type="button"
              onClick={beginDraftSession}
            >
              <SquarePen aria-hidden="true" size={16} />
              New {providerName(selectedProvider)}
            </button>
            <button aria-label="Provider details" title="Provider details" type="button" onClick={() => openCommandPanel("provider").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"))}>
              <Info aria-hidden="true" size={14} />
            </button>
          </div>
        </section>

        <section className="panel projectPanel">
          <button
            aria-haspopup="dialog"
            className="directorySummaryButton"
            type="button"
            onClick={() => {
              setMobilePanel(null);
              setDirectoryPickerOpen(true);
            }}
          >
            <span className="directorySummaryIcon">
              <Folder aria-hidden="true" size={18} />
            </span>
            <span className="directorySummaryText">
              <strong title={project?.realpath || cwd}>{currentProjectLabel}</strong>
              <small title={project?.realpath || cwd}>{project?.realpath || cwd || "Choose a directory"}</small>
            </span>
            <ChevronRight aria-hidden="true" size={16} />
          </button>

          {project?.git?.insideWorkTree ? (
            <div className="directoryContextRow">
              <span className="directoryBranch" title={project.git.branch || "Detached HEAD"}>
                <GitBranch aria-hidden="true" size={12} />
                {project.git.branch || "detached"}
              </span>
            </div>
          ) : null}

          {projectError ? <p className="errorText" role="alert">{projectError}</p> : null}
        </section>

        <AgentFleet
          sections={fleetSections}
          selectedKey={threadKey(selectedThread)}
          loadingKey={historyLoadingThreadId}
          onSelect={selectFleetThread}
          onTogglePin={togglePinnedThread}
          onRename={renameFleetThread}
          onClose={closeFleetThread}
          onManage={manageFleetThread}
        />

	        <section className="threadHeader">
	          <span>
            <History aria-hidden="true" size={16} />
	            Sessions
	          </span>
	          <div className="threadHeaderActions">
            <button
              aria-label="New session"
              disabled={!cwd.trim()}
              title="New session"
              type="button"
              onClick={beginDraftSession}
            >
              <SquarePen aria-hidden="true" size={16} />
            </button>
            <button aria-label="Manage sessions" title="Manage sessions" type="button" onClick={openSessionManager}>
              <ListTree aria-hidden="true" size={16} />
            </button>
            <button
              aria-label="Refresh sessions"
              disabled={wsState !== "online"}
              title="Refresh sessions"
              type="button"
              onClick={() => refreshSessionState("manual").catch((error) => setNotice(error.message))}
            >
              <RefreshCcw aria-hidden="true" size={16} />
            </button>
	          </div>
	        </section>

	        <div className="segmentedMini threadLayoutToggle">
	          <button
	            className={threadLayout === "directories" ? "active" : ""}
	            type="button"
	            onClick={() => updateThreadLayout("directories")}
	          >
	            Directories
	          </button>
	          <button
	            className={threadLayout === "recent" ? "active" : ""}
	            type="button"
	            onClick={() => updateThreadLayout("recent")}
	          >
	            Recent
	          </button>
	        </div>
	
        <div className="threadList">
          {orderedThreads.length === 0 ? <p className="muted">No sessions yet.</p> : null}
          {orderedThreads.length > 0 && listedThreads.length === 0 ? <p className="muted">Live sessions stay in Now until they finish.</p> : null}
          {threadLayout === "recent" ? (
            <div className="threadGroupItems">
              {listedThreads.map((thread) => {
                const key = threadKey(thread);
                const fleetThread = fleetByKey.get(key);
                const loadingHistory = historyLoadingThreadId === key;
                if (!fleetThread) return null;
                return (
                  <FleetSessionRow
                    key={key}
                    thread={fleetThread}
                    selected={threadKey(selectedThread) === key}
                    loading={loadingHistory}
                    showDirectory
                    onSelect={selectFleetThread}
                    onTogglePin={togglePinnedThread}
                    onRename={renameFleetThread}
                    onClose={closeFleetThread}
                    onManage={manageFleetThread}
                  />
                );
              })}
            </div>
          ) : listedThreadGroups.map((group) => {
            const collapsed = collapsedThreadGroupSet.has(group.cwd);
            const runningCount = group.threads.reduce(
              (sum, thread) => sum + (deriveSessionPhase(thread, activeTurnIdsByThread, waitingThreadIds) === "running" ? 1 : 0),
              0
            );
            const waitingCount = group.threads.reduce(
              (sum, thread) => sum + (deriveSessionPhase(thread, activeTurnIdsByThread, waitingThreadIds) === "waiting" ? 1 : 0),
              0
            );
            const isDragging = group.pinned && draggingPinnedDir === group.cwd;
            const isDropTarget = group.pinned && draggingPinnedDir && draggingPinnedDir !== group.cwd && dropTargetPinnedDir === group.cwd;
            return (
              <section
                className={`threadGroup ${group.pinned ? "pinned" : ""} ${isDragging ? "dragging" : ""} ${isDropTarget ? "dropTarget" : ""}`}
                key={group.cwd}
                draggable={group.pinned}
                onDragStart={() => group.pinned && setDraggingPinnedDir(group.cwd)}
                onDragOver={(event) => {
                  if (!group.pinned || !draggingPinnedDir || draggingPinnedDir === group.cwd) return;
                  event.preventDefault();
                  if (dropTargetPinnedDir !== group.cwd) setDropTargetPinnedDir(group.cwd);
                }}
                onDragLeave={() => {
                  if (dropTargetPinnedDir === group.cwd) setDropTargetPinnedDir(null);
                }}
                onDrop={(event) => {
                  if (!group.pinned || !draggingPinnedDir) return;
                  event.preventDefault();
                  reorderPinnedDirs(group.cwd);
                }}
                onDragEnd={() => {
                  setDraggingPinnedDir(null);
                  setDropTargetPinnedDir(null);
                }}
              >
                <div className="threadGroupHeader" title={group.cwd}>
                  <button
                    className="threadGroupToggle"
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleThreadGroup(group.cwd)}
                  >
                    <ChevronRight className={collapsed ? "" : "expanded"} size={15} />
                    {group.pinned ? <Pin size={14} /> : <Folder size={15} />}
                    <span>{group.label}</span>
                    <small>{group.threads.length}</small>
                    {runningCount > 0 ? (
                      <small className="threadGroupRunning" title={`${runningCount} running`}>
                        <span className="threadDot running" />
                        {runningCount}
                      </small>
                    ) : null}
                    {waitingCount > 0 ? (
                      <small className="threadGroupRunning waiting" title={`${waitingCount} waiting approval`}>
                        <span className="threadDot waiting" />
                        {waitingCount}
                      </small>
                    ) : null}
                  </button>
                  <button
                    aria-label={group.pinned ? "Unpin directory" : "Pin directory"}
                    className="threadGroupPin"
                    title={group.pinned ? "Unpin directory" : "Pin directory"}
                    type="button"
                    onClick={() => togglePinnedDirectory(group.cwd)}
                  >
                    {group.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </div>
                {collapsed ? null : (
                  <>
                    <div className="threadGroupPath" dir="ltr" title={group.cwd} translate="no">{group.cwd}</div>
                    <div className="threadGroupItems">
                      {group.threads.map((thread) => {
                        const key = threadKey(thread);
                        const fleetThread = fleetByKey.get(key);
                        const loadingHistory = historyLoadingThreadId === key;
                        if (!fleetThread) return null;
                        return (
                          <FleetSessionRow
                            key={key}
                            thread={fleetThread}
                            selected={threadKey(selectedThread) === key}
                            loading={loadingHistory}
                            showDirectory={false}
                            onSelect={selectFleetThread}
                            onTogglePin={togglePinnedThread}
                            onRename={renameFleetThread}
                            onClose={closeFleetThread}
                            onManage={manageFleetThread}
                          />
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            );
          })}
        </div>
          </>
        )}
      </aside>

      <section className={`workspace workspace-${workspaceView}`}>
          <header className="topbar">
            <div className="topbarTitle">
              <div className="topbarTitleRow">
                <span className="topbarTitleText">
                  <strong>{threadTitle(selectedThread)}</strong>
                  {selectedThread ? (
                    <button
                      aria-label="Rename session"
                      className="topbarRename"
                      title="Rename session"
                      type="button"
                      onClick={() => openCommandPanel("rename").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"))}
                    >
                      <Pencil aria-hidden="true" size={15} />
                    </button>
                  ) : null}
                </span>
                {isCursorProvider || selectedProvider === "claude" ? (
                  <span className="sessionModelInline" title={`${providerName(selectedProvider)} model: ${displayedModel || "auto"}`}>
                    {displayedModel || "auto"}
                  </span>
                ) : null}
                <nav className="mobileSessionStepper" aria-label="Switch session">
                  <button
                    aria-label={newerThread ? `Newer session: ${threadTitle(newerThread)}` : "No newer session"}
                    disabled={!newerThread}
                    title={newerThread ? `Newer: ${threadTitle(newerThread)}` : "No newer session"}
                    type="button"
                    onClick={() => selectAdjacentThread(newerThread)}
                  >
                    <ChevronLeft aria-hidden="true" size={16} />
                  </button>
                  <span
                    aria-label={selectedThreadIndex >= 0 ? `Session ${selectedThreadIndex + 1} of ${orderedThreads.length}` : `${orderedThreads.length} sessions`}
                    className="mobileSessionPosition"
                  >
                    {selectedThreadIndex >= 0 ? selectedThreadIndex + 1 : "–"}/{orderedThreads.length}
                  </span>
                  <button
                    aria-label={olderThread ? `Older session: ${threadTitle(olderThread)}` : "No older session"}
                    disabled={!olderThread}
                    title={olderThread ? `Older: ${threadTitle(olderThread)}` : "No older session"}
                    type="button"
                    onClick={() => selectAdjacentThread(olderThread)}
                  >
                    <ChevronRight aria-hidden="true" size={16} />
                  </button>
                </nav>
              </div>
              <div className="topbarMeta">
                <span className="topbarPath" dir="ltr" title={selectedThread?.cwd || cwd || undefined} translate="no">
                  {selectedThread?.cwd || cwd || "No server directory selected"}
                </span>
                {selectedThread && sessionExecutionState.phase !== "idle" ? (
                  <span className={`sessionState state-${sessionExecutionState.phase}`}>
                    {threadStatusText(sessionExecutionState.phase)}
                  </span>
                ) : null}
                {isCursorProvider ? (
                  <span className="unsafeModeMeta" title={cursorExecutionModeDescription}>{cursorExecutionModeLabel}</span>
                ) : (
                  <>
                    <span className="sessionModelMeta" title={`Model: ${displayedModel || "server default"}`}>
                      {displayedModel || "server default"}
                    </span>
                    {supportsReasoning ? (
                      <span className="sessionThinkingMeta" title={`Thinking effort: ${displayedReasoning || "default"}`}>
                        Thinking {displayedReasoning || "default"}
                      </span>
                    ) : null}
                    {supportsServiceTier ? (
                      <span
                        className={`fastModeMeta ${displayedFastMode ? "enabled" : ""}`}
                        data-service-tier={displayedServiceTier}
                        title={`${displayedFastMode ? "Fast mode enabled" : "Fast mode disabled"} · Service tier: ${displayedServiceTier}`}
                      >
                        {fastModeLabel(displayedServiceTier)} mode
                      </span>
                    ) : null}
                  </>
                )}
              </div>
          </div>
          <div className="topActions">
            {isCursorProvider ? (
              <>
                <SessionModelPill
                  model={displayedModel || "auto"}
                  onClick={() => openCommandPanel("model").catch((error) => setNotice(error instanceof Error ? error.message : String(error), "error"))}
                />
                <CursorUsagePill usage={cursorUsage} />
              </>
            ) : selectedProvider === "claude" ? (
              <ClaudeUsagePill rateLimit={claudeRateLimit} />
            ) : (
              <UsagePill
                label="Codex"
                rateLimit={codexRateLimit}
                windowTitle={`Standard Codex bucket · ${formatCodexPercent((codexRateLimit?.windowDurationMins || 0) / 1_440)} day window`}
              />
            )}
            <span className={`statusPill ${wsState}`}>{connectionLabel(wsState)}</span>
            <button aria-label="Log out" title="Log out" type="button" onClick={logout}>
              <LogOut aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <nav className="workspaceTabs" aria-label="Workspace view">
          <button aria-pressed={workspaceView === "chat"} className={workspaceView === "chat" ? "active" : ""} type="button" onClick={() => setWorkspaceView("chat")}>
            <MessageSquare aria-hidden="true" size={15} />
            Chat
          </button>
          <button aria-pressed={workspaceView === "files"} className={workspaceView === "files" ? "active" : ""} type="button" onClick={() => setWorkspaceView("files")}>
            <FolderOpen aria-hidden="true" size={15} />
            Files
          </button>
          <button
            aria-pressed={workspaceView === "diff"}
            className={workspaceView === "diff" ? "active" : ""}
            type="button"
            onClick={() => {
              setWorkspaceDiffKind("working");
              setWorkspaceView("diff");
            }}
          >
            <FileDiff aria-hidden="true" size={15} />
            Changes
            {workspaceDiff?.hasChanges ? <span>{workspaceDiff.files.length}</span> : null}
          </button>
          <button aria-pressed={workspaceView === "runtime"} className={workspaceView === "runtime" ? "active" : ""} type="button" onClick={() => setWorkspaceView("runtime")}>
            <ShieldCheck aria-hidden="true" size={15} />
            Runtime
          </button>
        </nav>

        <div className={`workbench ${workspaceView === "chat" ? "contextClosed" : "contextOpen"}`}>
          <section className="chatColumn">
          <ConversationPane
            threadKey={currentThreadKey}
            provider={selectedThreadProvider}
            providerLabel={providerName(selectedProvider)}
            hasThread={Boolean(selectedThread)}
            activeTurnId={activeTurnId}
            historyLoading={Boolean(historyLoadingThreadId && currentThreadKey === historyLoadingThreadId)}
            showAllHistory={showAllHistory}
            onShowAllHistory={onShowAllHistory}
            diagnostic={gatewayDiagnostic}
            onOpenDiff={openTurnDiff}
            wsOnline={wsState === "online"}
            startProviders={startProviders}
            selectedProvider={selectedProvider}
            sessionCreating={sessionCreating}
            onStartProvider={onStartProvider}
            onProviderDetails={onProviderDetails}
          />

        {notice ? (
          <div className={`notice notice-${noticeTone}`} role={noticeTone === "error" ? "alert" : "status"} aria-live={noticeTone === "error" ? "assertive" : "polite"}>
            <span>{notice}</span>
            <button aria-label="Dismiss notification" type="button" onClick={() => setNotice("")}>
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        ) : null}

        {completionPopup ? (
          <div className="completionPopup" role="status" aria-live="polite">
            <Check size={18} />
            <span>
              <strong>Task completed</strong>
              <small>{completionPopup.title}</small>
              <small>{completionPopup.detail}</small>
            </span>
            <button type="button" aria-label="Dismiss completion message" onClick={() => setCompletionPopup(null)}>
              <X size={15} />
            </button>
          </div>
        ) : null}

        <Composer
          ref={composerRef}
          threadKey={currentThreadKey}
          initialDraft={draftsRef.current[currentThreadKey] || ""}
          providerLabel={providerName(selectedProvider)}
          wsState={wsState}
          submitting={composerSubmitting}
          executionTransitioning={planSubmitting}
          executionState={sessionExecutionState}
          sessionCreating={sessionCreating}
          supportsSteer={supportsSteer}
          uploadsInProgress={uploadsInProgress}
          currentQueuePaused={currentQueuePaused}
          attachments={attachments}
          fileContexts={fileContexts}
          fileMentions={fileMentions}
          queueSummary={currentQueueSummary}
          queueAction={queueAction}
          slashContext={slashContext}
          onDraftChange={(value) => {
            draftsRef.current[currentThreadKey] = value;
          }}
          onSubmit={submitPrompt}
          onSteer={submitSteerPrompt}
          onInterrupt={() => interrupt().catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}
          onRunPlan={() => executeCurrentPlan().catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}
          onModeChange={(nextMode) => selectSessionMode(nextMode).catch((error) => setNotice(error.message))}
          onSlash={(command) => executeSlashCommand(command).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}
          onPickFiles={addFiles}
          onRemoveAttachment={removeAttachment}
          onRemoveFileContext={(id) => setFileContexts((current) => removeChip(current, id))}
          onOpenFileContext={openFileContext}
          onAtQuery={setAtQuery}
          onPickMention={(hit) => setFileContexts((current) => upsertChip(current, { path: hit.path, startLine: null, endLine: null, text: "" }))}
          onMentionsParsed={applyParsedMentions}
          onRetryQueue={retryQueuedPrompt}
          onRemoveQueue={removeQueuedPrompt}
        />

          </section>

          {workspaceView !== "chat" ? (
            <aside className={`contextPane context-${workspaceView}`} aria-label={`${workspaceView} context`}>
              <button
                aria-label="Resize context panel"
                className={`contextResizeHandle ${contextResizing ? "active" : ""}`}
                type="button"
                onPointerDown={startContextResize}
              />
              <header className="contextHeader">
                <strong>{workspaceView === "files" ? "Files" : workspaceView === "diff" ? "Changes" : "Runtime"}</strong>
                <button aria-label="Close context" title="Close context" type="button" onClick={() => setWorkspaceView("chat")}>
                  <X aria-hidden="true" size={15} />
                </button>
              </header>
              {workspaceView === "files" ? (
                <ProjectFileWorkspace
                  root={workspaceRoot}
                  requestedPath={workspaceFileRequest}
                  highlight={fileContextHighlight}
                  maxUploadBytes={uploadMaxBytes}
                  onRequestedPathHandled={clearWorkspaceFileRequest}
                  onLineSelect={handleLineSelect}
                />
              ) : workspaceView === "diff" ? (
                <section className="workspaceDiffView">
                  <header className="workspaceDiffHeader">
                    <span>
                      <FileDiff aria-hidden="true" size={17} />
                      <span>
                        <strong>{workspaceDiffKind === "turn" ? "Turn changes" : "Working-tree changes"}</strong>
                        <small>{workspaceDiff?.root || workspaceRoot || "No project selected"}</small>
                      </span>
                    </span>
                    <span>
                      {workspaceDiffKind === "turn" ? <button type="button" onClick={refreshWorkspaceDiff}>Show working tree</button> : null}
                      {workspaceDiff?.diff ? <button type="button" onClick={() => navigator.clipboard?.writeText(workspaceDiff.diff)}><Copy aria-hidden="true" size={14} /> Copy diff</button> : null}
                      <button type="button" onClick={refreshWorkspaceDiff} disabled={workspaceDiffLoading}><RefreshCcw aria-hidden="true" size={14} /> Refresh</button>
                    </span>
                  </header>
                  {workspaceDiffLoading ? <p className="workspaceLoading">Loading diff…</p> : null}
                  {workspaceDiffError ? <div className="workspaceDiffEmpty"><FileDiff aria-hidden="true" size={30} /><h2>Diff is unavailable</h2><p>{workspaceDiffError}</p></div> : null}
                  {!workspaceDiffLoading && !workspaceDiffError ? <ProjectDiffPanel data={workspaceDiff} onOpenFile={openWorkspaceFile} /> : null}
                </section>
              ) : (
                <RuntimePanel
                  data={{
                    provider: providerName(selectedThread ? selectedThreadProvider : selectedProvider),
                    version: selectedThreadProviderStatus.version || "version unknown",
                    connection: connectionLabel(wsState),
                    cwd: workspaceRoot,
                    threadId: selectedThread ? nativeThreadId(selectedThread) : "",
                    mode: modeLabel(mode),
                    model: displayedModel || "server default",
                    reasoning: supportsReasoning ? displayedReasoning || "server default" : undefined,
                    serviceTier: supportsServiceTier ? displayedServiceTier : undefined,
                    usage: isCursorProvider
                      ? (cursorUsage ? formatCursorUsageLabel(cursorUsage) : undefined)
                      : (usageLabel || (selectedProvider === "claude"
                        ? (claudeRateLimit ? formatClaudeUsageLabel(claudeRateLimit) : undefined)
                        : (codexRateLimit ? `Codex ${formatCodexPercent(remainingCodexPercent(codexRateLimit.usedPercent))}% remaining` : undefined))),
                    approval: supportsApprovals ? shortJson(runtimeSettings.approvalPolicy) : undefined,
                    sandbox: supportsApprovals ? runtimeSettings.sandboxMode || "server default" : undefined,
                    warning: isCursorProvider ? cursorExecutionModeDescription : undefined,
                    supportsPermissions: supportsApprovals,
                    supportsMcp: selectedProvider === "codex"
                  }}
                  onOpenProvider={() => openCommandPanel("provider").catch((error) => setNotice(error.message, "error"))}
                  onOpenModel={() => openCommandPanel("model").catch((error) => setNotice(error.message, "error"))}
                  onOpenPermissions={() => openCommandPanel("permissions").catch((error) => setNotice(error.message, "error"))}
                  onOpenMcp={() => openCommandPanel("mcp").catch((error) => setNotice(error.message, "error"))}
                  onOpenStatus={() => openCommandPanel("status").catch((error) => setNotice(error.message, "error"))}
                />
              )}
            </aside>
          ) : null}
        </div>
      </section>

      {sessionManagerOpen ? renderSessionManager() : null}
      {commandPanel ? renderCommandPanel() : null}
      {activeRequest && providerCapability(providerStatus(bootstrap, activeRequestProvider), "approvals") ? (
        <ServerRequestDialog request={activeRequest} onAnswer={answerServerRequest} />
      ) : null}
      {directoryPickerOpen ? (
        <DirectoryPicker
          initialPath={cwd}
          pinnedDirs={pinnedDirs}
          recentDirs={recentDirs}
          onClose={() => setDirectoryPickerOpen(false)}
          onSelect={useResolvedDirectory}
          onTogglePinned={togglePinnedDirectory}
        />
      ) : null}
      <nav className="bottomTabBar" aria-label="Mobile navigation">
        <button
          aria-label="Sessions"
          className={mobilePanel === "sessions" ? "active" : ""}
          type="button"
          onClick={() => {
            setCommandPanel(null);
            setSessionManagerOpen(false);
            setMobilePanel((current) => (current === "sessions" ? null : "sessions"));
          }}
        >
          <History aria-hidden="true" size={18} />
          <span>Sessions</span>
          <small>{threads.length}</small>
        </button>
        <button
          aria-label="Chat"
          className={workspaceView === "chat" && !mobilePanel && !sessionManagerOpen && !commandPanel ? "active" : ""}
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setCommandPanel(null);
            setSessionManagerOpen(false);
            setWorkspaceView("chat");
          }}
        >
          <MessageSquare aria-hidden="true" size={18} />
          <span>Chat</span>
        </button>
        <button
          aria-label="Files"
          className={workspaceView === "files" && !mobilePanel ? "active" : ""}
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setCommandPanel(null);
            setSessionManagerOpen(false);
            setWorkspaceView("files");
          }}
        >
          <FolderOpen aria-hidden="true" size={18} />
          <span>Files</span>
        </button>
        <button
          aria-label="Changes"
          className={workspaceView === "diff" && !mobilePanel ? "active" : ""}
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setCommandPanel(null);
            setSessionManagerOpen(false);
            setWorkspaceDiffKind("working");
            setWorkspaceView("diff");
          }}
        >
          <FileDiff aria-hidden="true" size={18} />
          <span>Changes</span>
          {workspaceDiff?.hasChanges ? <small>{workspaceDiff.files.length}</small> : null}
        </button>
      </nav>
    </main>
  );
}

function DirectoryPicker({
  initialPath,
  pinnedDirs,
  recentDirs,
  onClose,
  onSelect,
  onTogglePinned
}: {
  initialPath: string;
  pinnedDirs: string[];
  recentDirs: string[];
  onClose: () => void;
  onSelect: (project: ProjectInfo) => void;
  onTogglePinned: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const loadRequestRef = useRef(0);
  const selectRequestRef = useRef(0);
  const pinnedDirSet = useMemo(() => new Set(pinnedDirs.map(normalizeDirectoryPath)), [pinnedDirs]);

  async function load(target: string) {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const next = await getJson<ProjectDirectoryListing>(`/api/projects/list?cwd=${encodeURIComponent(target)}`);
      if (requestId !== loadRequestRef.current) return null;
      setListing(next);
      setPath(next.realpath);
      return next;
    } catch (loadError) {
      if (requestId === loadRequestRef.current) {
        setError(directoryErrorMessage(loadError));
      }
      return null;
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    getJson<{ data: ProjectSuggestion[] }>("/api/projects/suggestions")
      .then((response) => setSuggestions(response.data))
      .catch(() => setSuggestions([]));
    if (initialPath.trim()) load(initialPath);
  }, [initialPath]);

  const quickPaths = [
    ...pinnedDirs.map((item) => ({ label: directoryLabel(item), path: item, kind: "Pinned" })),
    ...recentDirs.map((item) => ({ label: directoryLabel(item), path: item, kind: "Recent" })),
    ...suggestions.map((item) => ({ ...item, kind: "Suggested" }))
  ].filter(
    (item, index, all) =>
      all.findIndex((candidate) => normalizeDirectoryPath(candidate.path) === normalizeDirectoryPath(item.path)) === index
  );
  const activePath = listing?.realpath || path;
  const pathPinned = pinnedDirSet.has(normalizeDirectoryPath(activePath));
  const breadcrumbs = useMemo(() => {
    const target = listing?.realpath || path;
    if (!target.startsWith("/")) return [{ label: target, path: target }];
    const segments = target.split("/").filter(Boolean);
    return [
      { label: "/", path: "/" },
      ...segments.map((segment, index) => ({
        label: segment,
        path: `/${segments.slice(0, index + 1).join("/")}`
      }))
    ];
  }, [listing?.realpath, path]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function closePicker() {
    loadRequestRef.current += 1;
    selectRequestRef.current += 1;
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closePicker();
  }

  async function selectDirectory() {
    const requestId = ++selectRequestRef.current;
    setSelecting(true);
    setError("");
    try {
      const selected = await getJson<ProjectInfo>(`/api/projects/resolve?cwd=${encodeURIComponent(path)}`);
      if (requestId !== selectRequestRef.current) return;
      selectRequestRef.current += 1;
      onSelect(selected);
    } catch (selectError) {
      if (requestId === selectRequestRef.current) setError(directoryErrorMessage(selectError));
    } finally {
      if (requestId === selectRequestRef.current) setSelecting(false);
    }
  }

  return (
    <div className="dialogBackdrop">
      <section
        aria-labelledby="directory-dialog-title"
        aria-modal="true"
        className="dialog directoryDialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="directoryDialogHeader">
          <div>
            <h2 id="directory-dialog-title">Choose server directory</h2>
            <p>Open a project folder on this server, or paste its absolute path.</p>
          </div>
          <button aria-label="Close directory picker" title="Close" type="button" onClick={closePicker}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <form
          className="directoryPathBar"
          onSubmit={(event) => {
            event.preventDefault();
            load(path);
          }}
        >
          <label htmlFor="server-directory-path">Absolute path</label>
          <div className="directoryPathInput">
            <FolderOpen aria-hidden="true" size={16} />
            <input
              id="server-directory-path"
              name="server-directory-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/home/user/project…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button type="submit" disabled={loading || !path.trim()}>
            {loading ? "Opening…" : "Open path"}
          </button>
        </form>

        {quickPaths.length ? (
          <section className="quickPathSection" aria-labelledby="quick-paths-title">
            <div className="directorySectionHeading">
              <h3 id="quick-paths-title">Quick access</h3>
              <span>Pinned, recent & suggested</span>
            </div>
            <div className="quickPathList">
              {quickPaths.slice(0, 12).map((item) => (
                <button
                  type="button"
                  key={item.path}
                  title={item.path}
                  onClick={() => load(item.path)}
                  disabled={loading}
                >
                  {item.kind === "Pinned" ? (
                    <Pin aria-hidden="true" size={15} />
                  ) : item.kind === "Recent" ? (
                    <History aria-hidden="true" size={15} />
                  ) : (
                    <HomeIcon aria-hidden="true" size={15} />
                  )}
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.kind}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="directoryBrowser" aria-labelledby="directory-browser-title">
          <div className="directoryLocationHeader">
            <div>
              <span>Current directory</span>
              <strong id="directory-browser-title" title={activePath}>
                {directoryLabel(activePath)}
              </strong>
            </div>
            <button
              aria-pressed={pathPinned}
              type="button"
              onClick={() => onTogglePinned(activePath)}
              disabled={loading || !listing}
            >
              {pathPinned ? <PinOff aria-hidden="true" size={15} /> : <Pin aria-hidden="true" size={15} />}
              {pathPinned ? "Unpin" : "Pin"}
            </button>
          </div>
          <nav className="directoryBreadcrumbs" aria-label="Directory path">
            {breadcrumbs.map((item, index) => (
              <Fragment key={item.path}>
                {index ? <ChevronRight aria-hidden="true" size={13} /> : null}
                <button
                  aria-current={index === breadcrumbs.length - 1 ? "location" : undefined}
                  title={item.path}
                  type="button"
                  onClick={() => load(item.path)}
                  disabled={loading}
                >
                  {item.label}
                </button>
              </Fragment>
            ))}
          </nav>
          <div className="directoryList" aria-busy={loading}>
            {listing?.parent ? (
              <button
                type="button"
                className="directoryRow parent"
                onClick={() => load(listing.parent!)}
                disabled={loading}
              >
                <ArrowUp aria-hidden="true" size={17} />
                <span>
                  <strong>Parent directory</strong>
                  <small title={listing.parent}>{listing.parent}</small>
                </span>
                <ChevronRight aria-hidden="true" size={15} />
              </button>
            ) : null}
            {listing?.entries.map((entry) => (
              <button
                type="button"
                className="directoryRow"
                key={entry.path}
                title={entry.path}
                onClick={() => load(entry.path)}
                disabled={loading}
              >
                <Folder aria-hidden="true" size={17} />
                <span>
                  <strong>{entry.name}</strong>
                  <small>Folder</small>
                </span>
                <ChevronRight aria-hidden="true" size={15} />
              </button>
            ))}
            {!loading && listing?.entries.length === 0 ? (
              <p className="directoryEmpty">This directory has no child folders.</p>
            ) : null}
            {loading ? (
              <p className="directoryLoading" role="status" aria-live="polite">Loading directories…</p>
            ) : null}
          </div>
        </section>

        {error ? (
          <p className="errorText" role="alert">{error}</p>
        ) : null}

        <footer>
          <button type="button" onClick={closePicker}>
            <X aria-hidden="true" size={17} />
            Cancel
          </button>
          <button
            className="primaryButton"
            type="button"
            onClick={selectDirectory}
            disabled={loading || selecting || !path.trim()}
          >
            <Check aria-hidden="true" size={17} />
            {selecting ? "Selecting…" : "Use this directory"}
          </button>
        </footer>
      </section>
    </div>
  );
}

/**
 * `groupedRounds` rebuilds round objects on every recompute, so compare the
 * content instead. Item objects keep their identity across refreshes, which
 * makes the item comparison a reference check.
 */
function ServerRequestDialog({
  request,
  onAnswer
}: {
  request: ServerRequest;
  onAnswer: (request: ServerRequest, result: unknown) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);

  function approvalResult(decision: "approve" | "approveForSession" | "decline") {
    if (request.method === "item/permissions/requestApproval") {
      const params = requestRecord(request);
      return decision === "decline"
        ? { permissions: {}, scope: "turn", strictAutoReview: true }
        : { permissions: params.permissions || {}, scope: decision === "approveForSession" ? "session" : "turn" };
    }

    if (request.method === "mcpServer/elicitation/request") {
      return decision === "decline"
        ? { action: "decline", content: null, _meta: null }
        : { action: "accept", content: {}, _meta: null };
    }

    if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
      return {
        decision:
          decision === "approveForSession"
            ? "approved_for_session"
            : decision === "decline"
              ? "denied"
              : "approved"
      };
    }

    return {
      decision:
        decision === "approveForSession" ? "acceptForSession" : decision === "decline" ? "decline" : "accept"
    };
  }

  const approveResult = approvalResult("approve");
  const approveForSessionResult = approvalResult("approveForSession");
  const declineResult = approvalResult("decline");
  const command = commandTextFromRequest(request);
  const files = approvalFiles(request);
  const params = requestRecord(request);
  const kind = approvalKind(request);
  const canApproveForSession =
    !needsPerRequestApproval(request) &&
    (request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval" ||
      request.method === "execCommandApproval" ||
      request.method === "applyPatchApproval");

  useEffect(() => {
    dialogRef.current?.focus();
  }, [request.id]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onAnswer(request, declineResult);
    }
    if (event.key === "Enter" && !isTextEditingTarget(event.target)) {
      event.preventDefault();
      onAnswer(request, approveResult);
    }
  }

  if (request.method === "item/tool/requestUserInput") {
    return <UserInputDialog request={request} onAnswer={onAnswer} />;
  }

  return (
    <div className="dialogBackdrop">
      <section
        aria-labelledby={`approval-title-${request.id}`}
        aria-modal="true"
        className={`dialog approvalDialog ${kind}`}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id={`approval-title-${request.id}`}>{approvalTitle(request)}</h2>
          <p>{approvalSummary(request)}</p>
          <ShortcutHints
            items={[
              { keys: ["Enter"], label: "approve" },
              { keys: ["Esc"], label: "decline" }
            ]}
          />
        </header>
        <div className="approvalCard">
          <div className="approvalBadgeRow">
            <span>{riskLabel(request)}</span>
            <span>{request.method}</span>
          </div>
          {command ? (
            <section className="approvalPreview">
              <h3>
                <Terminal aria-hidden="true" size={15} />
                Command
              </h3>
              <pre>{command}</pre>
            </section>
          ) : null}
          {files.length ? (
            <section className="approvalPreview">
              <h3>
                <FileDiff aria-hidden="true" size={15} />
                Files
              </h3>
              <div className="fileList">
                {files.map((file) => (
                  <span key={file}>
                    <FileText aria-hidden="true" size={13} />
                    {file}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
          {kind === "mcp" ? (
            <section className="approvalPreview">
              <h3>Tool request</h3>
              <dl>
                <dt>Server</dt>
                <dd>{String(params.serverName || "unknown")}</dd>
                <dt>Mode</dt>
                <dd>{String(params.mode || "form")}</dd>
              </dl>
            </section>
          ) : null}
          <details>
            <summary>Raw request</summary>
            <pre className="requestJson">{JSON.stringify(request.params, null, 2)}</pre>
          </details>
        </div>
        <footer>
          <button type="button" onClick={() => onAnswer(request, declineResult)}>
            <X aria-hidden="true" size={17} />
            Decline
          </button>
          {canApproveForSession ? (
            <button type="button" onClick={() => onAnswer(request, approveForSessionResult)}>
              <Check aria-hidden="true" size={17} />
              Approve session
            </button>
          ) : null}
          <button className="primaryButton" type="button" onClick={() => onAnswer(request, approveResult)}>
            <Check aria-hidden="true" size={17} />
            Approve
          </button>
        </footer>
      </section>
    </div>
  );
}

function UserInputDialog({
  request,
  onAnswer
}: {
  request: ServerRequest;
  onAnswer: (request: ServerRequest, result: unknown) => Promise<void>;
}) {
  const params = requestInputParams(request);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const optionShortcuts = useMemo(() => {
    const shortcuts: Array<{ key: string; questionId: string; label: string }> = [];
    for (const question of params.questions) {
      for (const option of question.options || []) {
        if (shortcuts.length >= 9) return shortcuts;
        shortcuts.push({ key: String(shortcuts.length + 1), questionId: question.id, label: option.label });
      }
    }
    return shortcuts;
  }, [params.questions]);
  const inputShortcutHints = useMemo<ShortcutHint[]>(() => {
    const hints: ShortcutHint[] = [];
    const lastShortcut = optionShortcuts.at(-1)?.key;
    if (lastShortcut) hints.push({ keys: ["1", lastShortcut], label: "choose", separator: "-" });
    hints.push({ keys: ["Enter"], label: "confirm" }, { keys: ["Esc"], label: "cancel" });
    return hints;
  }, [optionShortcuts]);
  const canSubmit = params.questions.every((question) =>
    Boolean((answers[question.id] || []).length || freeText[question.id]?.trim())
  );

  useEffect(() => {
    dialogRef.current?.focus();
  }, [request.id]);

  function choose(questionId: string, label: string) {
    setAnswers((current) => ({ ...current, [questionId]: [label] }));
    setFreeText((current) => ({ ...current, [questionId]: "" }));
  }

  function optionShortcut(questionId: string, label: string) {
    return optionShortcuts.find((shortcut) => shortcut.questionId === questionId && shortcut.label === label)?.key;
  }

  async function submit() {
    if (submitting || !canSubmit) return;
    const result: Record<string, { answers: string[] }> = {};
    for (const question of params.questions) {
      const selected = [...(answers[question.id] || [])];
      const typed = freeText[question.id]?.trim();
      if (typed) selected.push(typed);
      result[question.id] = { answers: selected };
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      await onAnswer(request, { answers: result });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onAnswer(request, { answers: {} });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;

    if (event.key === "Escape") {
      event.preventDefault();
      void cancel();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }

    if (/^[1-9]$/.test(event.key) && !isTextEditingTarget(event.target)) {
      const shortcut = optionShortcuts.find((item) => item.key === event.key);
      if (!shortcut) return;
      event.preventDefault();
      choose(shortcut.questionId, shortcut.label);
    }
  }

  return (
    <div className="dialogBackdrop">
      <section
        aria-labelledby={`user-input-title-${request.id}`}
        aria-modal="true"
        className="dialog userInputDialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id={`user-input-title-${request.id}`}>Codex needs input</h2>
          <p>{params.questions.length} question{params.questions.length === 1 ? "" : "s"}</p>
          <ShortcutHints items={inputShortcutHints} />
        </header>

        <div className="questionList">
          {params.questions.map((question) => (
            <section className="question" key={question.id}>
              <h3>{question.header}</h3>
              <p>{question.question}</p>
              {question.options ? (
                <div className="optionList">
                  {question.options.map((option) => {
                    const shortcut = optionShortcut(question.id, option.label);
                    return (
                      <label className="option" key={option.label}>
                        <input
                          type="radio"
                          name={`answer-${question.id}`}
                          disabled={submitting}
                          checked={(answers[question.id] || []).includes(option.label)}
                          onChange={() => choose(question.id, option.label)}
                        />
                        <span>
                          <strong>
                            {shortcut ? <kbd className="optionKey">{shortcut}</kbd> : null}
                            {option.label}
                          </strong>
                          <small>{option.description}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {question.isOther || !question.options ? (
                <input
                  aria-label={question.question || question.header || "Answer"}
                  autoComplete="off"
                  className="freeInput"
                  name={`answer-${question.id}`}
                  type={question.isSecret ? "password" : "text"}
                  disabled={submitting}
                  value={freeText[question.id] || ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFreeText((current) => ({ ...current, [question.id]: value }));
                    if (value) setAnswers((current) => ({ ...current, [question.id]: [] }));
                  }}
                  placeholder={question.isOther ? "Other answer…" : "Answer…"}
                />
              ) : null}
            </section>
          ))}
        </div>

        {submitError ? <p className="errorText" role="alert">Could not continue: {submitError}</p> : null}

        <footer>
          <button type="button" disabled={submitting} onClick={() => void cancel()}>
            <X aria-hidden="true" size={17} />
            Cancel
          </button>
          <button className="primaryButton" type="button" disabled={submitting || !canSubmit} onClick={() => void submit()}>
            {submitting ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={17} /> : <Play aria-hidden="true" size={17} />}
            {submitting ? "Continuing…" : "Confirm"}
          </button>
        </footer>
      </section>
    </div>
  );
}
