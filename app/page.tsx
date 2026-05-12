"use client";

import {
  Archive,
  ArrowUp,
  BarChart3,
  Check,
  ChevronRight,
  CircleStop,
  Code2,
  Copy,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Home as HomeIcon,
  ListTree,
  LogOut,
  MessageSquare,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Terminal,
  X
} from "lucide-react";
import {
  Fragment,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  memo,
  PointerEvent as ReactPointerEvent,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  filterSlashCommands,
  findSlashCommand,
  slashCommandDisabledReason,
  type SlashCommand
} from "./slashCommands";
import {
  buildCollaborationMode,
  defaultRuntimeSettings,
  modeLabel,
  runtimePermissionDraft,
  runtimeThreadParams,
  runtimeTurnParams,
  type ApprovalPolicy,
  type ModeKind,
  type PermissionDraft,
  type ReasoningEffort,
  type SandboxMode,
  type ServiceTier,
  type SessionRuntimeSettings
} from "./sessionRuntime";

type JsonRpcId = string | number;

type ThreadItem = {
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

type Turn = {
  id: string;
  items: ThreadItem[];
  status: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
};

type TurnGroup = {
  id: string;
  itemIds: string[];
  status?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt?: number | null;
  pending?: boolean;
};

type DisplayTurn = TurnGroup & {
  items: ThreadItem[];
};

type Thread = {
  id: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  status: { type: string; activeFlags?: unknown[] };
  name: string | null;
  turns: Turn[];
};

type ThreadGroup = {
  cwd: string;
  label: string;
  pinned: boolean;
  updatedAt: number;
  threads: Thread[];
};

type MobilePanel = "project" | "sessions" | null;
type ThreadLayout = "directories" | "recent";
type CommandPanel =
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

type QueuedPrompt = {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
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

type ProjectDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  tooLarge?: boolean;
};

type ProjectDiff = {
  root: string;
  branch: string | null;
  status: string;
  diff: string;
  files: ProjectDiffFile[];
  additions: number;
  deletions: number;
  hasChanges: boolean;
};

type DiffSnapshot = {
  root: string;
  tree: string;
};

type TurnDiffBaseline = {
  cwd: string;
  tree: string;
};

type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
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
  defaultCwd?: string;
  codex?: {
    initializeInfo?: unknown;
    collaborationModes?: any[];
    pendingServerRequests?: ServerRequest[];
  };
  codexError?: string | null;
};

const defaultCwd = "";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const promptQueueStorageKey = "codex-remote-console.promptQueue.v1";
const threadLayoutStorageKey = "codex-remote-console.threadLayout";
const sidebarWidthStorageKey = "codex-remote-console.sidebarWidth";
const defaultSidebarWidth = 320;
const minSidebarWidth = 240;
const maxSidebarWidth = 520;

const EMPTY_ITEMS: Record<string, ThreadItem> = Object.freeze({}) as Record<string, ThreadItem>;
const EMPTY_TURNS: Record<string, TurnGroup> = Object.freeze({}) as Record<string, TurnGroup>;
const EMPTY_ORDER: string[] = Object.freeze([]) as unknown as string[];

function appPath(path: string) {
  return `${basePath}${path}`;
}

const bootstrapPromise: Promise<Bootstrap> | null =
  typeof window === "undefined"
    ? null
    : fetch(`${basePath}/api/bootstrap`).then((response) => response.json());

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(appPath(path));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(appPath(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === "string" ? result.error : `Request failed: ${response.status}`);
  }
  return result as T;
}

function uniqueAppend<T>(items: T[], item: T) {
  return items.includes(item) ? items : [...items, item];
}

function uniqueItems<T>(items: T[]) {
  return items.filter((item, index) => items.indexOf(item) === index);
}

function clampSidebarWidth(width: number) {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)));
}

function formatTime(timestamp: number) {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleString();
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function statusLabel(status: unknown) {
  if (typeof status === "string") return status;
  if (!status || typeof status !== "object" || !("type" in status)) return "unknown";
  return String(status.type);
}

function threadIsActive(thread: Thread, activeTurns: Record<string, string> = {}) {
  return statusLabel(thread.status) === "active" || Boolean(activeTurns[thread.id]);
}

type ThreadStatusKind = "running" | "waiting" | "failed" | "idle";

function threadStatusKind(
  thread: Thread,
  activeTurns: Record<string, string> = {},
  waitingThreadIds: Set<string> = new Set()
): ThreadStatusKind {
  if (waitingThreadIds.has(thread.id)) return "waiting";
  if (threadIsActive(thread, activeTurns)) return "running";
  const label = statusLabel(thread.status);
  if (label === "failed" || label === "error") return "failed";
  return "idle";
}

function waitingThreadIdsFromRequests(requests: ServerRequest[]) {
  const ids = new Set<string>();
  for (const request of requests) {
    const tid = (request.params as { threadId?: string } | undefined)?.threadId;
    if (typeof tid === "string" && tid) ids.add(tid);
  }
  return ids;
}

function activeTurnIdFromTurns(turns: Turn[] = []) {
  return [...turns].reverse().find((turn) => turn.status === "inProgress")?.id || null;
}

function threadTitle(thread: Thread | null) {
  if (!thread) return "No session selected";
  return thread.name || thread.preview || "New session";
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

function mergeThreadsById(current: Thread[], incoming: Thread[]) {
  const seen = new Set<string>();
  const merged: Thread[] = [];
  for (const thread of [...incoming, ...current]) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    merged.push(thread);
  }
  return merged.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
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
  return `${normalized.slice(0, limit - 3)}...`;
}

function itemText(item: ThreadItem) {
  if (item.type === "userMessage") {
    return userMessageParts(item).text;
  }

  if (item.type === "agentMessage" || item.type === "plan") return item.text || "";
  if (item.type === "reasoning") {
    const content = (item.content || []).filter((part): part is string => typeof part === "string");
    return [...(item.summary || []), ...content].join("\n");
  }
  if (item.type === "commandExecution") return outputText(item);
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

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "submit", "reset"].includes(target.type);
}

function inputItems(text: string, attachments: Attachment[] = []) {
  return [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...attachments.map((attachment) => ({ type: "image", url: attachment.url }))
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

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readImageAttachment(file: File) {
  return new Promise<Attachment>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(`${file.name} is not an image file.`));
      return;
    }

    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || "pasted-image",
        type: file.type,
        size: file.size,
        url: String(reader.result || "")
      });
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "image"}.`));
    reader.readAsDataURL(file);
  });
}

function userMessageParts(item: ThreadItem) {
  const content = Array.isArray(item.content) ? item.content : [];
  return {
    text: content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String(part.text || "")
          : part && typeof part === "object" && "path" in part
            ? String(part.path || "")
            : ""
      )
      .filter(Boolean)
      .join("\n"),
    images: content
      .map((part) => (part && typeof part === "object" && "url" in part ? String(part.url || "") : ""))
      .filter(Boolean)
  };
}

function outputText(item: ThreadItem) {
  return item.aggregatedOutput || item.output || "";
}

function plainTextWithBreaks(text: string, keyPrefix: string) {
  return text.split("\n").flatMap((part, index) =>
    index === 0 ? [part] : [<br key={`${keyPrefix}-br-${index}`} />, part]
  );
}

function safeMarkdownHref(href: string) {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return trimmed;
  return "#";
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const nodes = [];
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(...plainTextWithBreaks(text.slice(cursor, match.index), `${keyPrefix}-text-${cursor}`));
    }

    const key = `${keyPrefix}-${match.index}`;
    if (match[2] !== undefined) {
      nodes.push(<code key={key}>{match[2]}</code>);
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(match[3], `${key}-strong`)}</strong>);
    } else {
      const href = safeMarkdownHref(match[5] || "");
      const external = /^https?:/i.test(href);
      nodes.push(
        <a href={href} key={key} rel={external ? "noreferrer" : undefined} target={external ? "_blank" : undefined}>
          {renderInlineMarkdown(match[4] || href, `${key}-link`)}
        </a>
      );
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < text.length) {
    nodes.push(...plainTextWithBreaks(text.slice(cursor), `${keyPrefix}-text-${cursor}`));
  }

  return nodes;
}

function parseTableRow(line: string) {
  return line
    .replace(/^\s*\|?|\|?\s*$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string) {
  const cells = parseTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownFenceLanguage(line: string) {
  return line.replace(/^```+/, "").trim().split(/\s+/)[0] || "";
}

function MarkdownBody({ text, expanded, streaming }: { text: string; expanded?: boolean; streaming?: boolean }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const language = markdownFenceLanguage(line.trimStart());
      const code = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push(
        <figure className="markdownCodeBlock" key={`code-${index}`}>
          {language ? <figcaption>{language}</figcaption> : null}
          <pre>
            <code>{code.join("\n")}</code>
          </pre>
        </figure>
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2].trim(), `heading-${index}`);
      const key = `heading-${index}`;
      blocks.push(
        level === 1 ? (
          <h1 key={key}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={key}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={key}>{content}</h3>
        ) : level === 4 ? (
          <h4 key={key}>{content}</h4>
        ) : level === 5 ? (
          <h5 key={key}>{content}</h5>
        ) : (
          <h6 key={key}>{content}</h6>
        )
      );
      index++;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = parseTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(parseTableRow(lines[index]));
        index++;
      }
      blocks.push(
        <div className="markdownTableWrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {headers.map((header, cellIndex) => (
                  <th key={`${header}-${cellIndex}`}>{renderInlineMarkdown(header, `th-${index}-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${index}-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${rowIndex}-${cellIndex}`}>
                      {renderInlineMarkdown(row[cellIndex] || "", `td-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items = [];
      while (index < lines.length) {
        const match = orderedList ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]) : /^\s*[-*]\s+(.+)$/.exec(lines[index]);
        if (!match) break;
        items.push(match[1]);
        index++;
      }
      const ListTag = orderedList ? "ol" : "ul";
      blocks.push(
        <ListTag key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInlineMarkdown(item, `li-${index}-${itemIndex}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index++;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderInlineMarkdown(quote.join("\n"), `quote-${index}`)}</blockquote>);
      continue;
    }

    const paragraph = [line];
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trimStart().startsWith("```") &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !(lines[index].includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraph.join("\n"), `p-${index}`)}</p>);
  }

  return (
    <div className={`markdownBody ${expanded ? "expandedMarkdown" : ""}`}>
      {blocks.length ? blocks : <p>{streaming ? "Waiting for output" : "..."}</p>}
      {streaming ? <span className="streamCursor" /> : null}
    </div>
  );
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
};

type DiffSection = {
  file: string;
  lines: DiffLine[];
};

function parseUnifiedDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = { file: fileMatch[2] || fileMatch[1], lines: [{ kind: "meta", text: line }] };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = { file: "Diff", lines: [] };
      sections.push(current);
    }

    const kind: DiffLine["kind"] =
      line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+") && !line.startsWith("+++")
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
    current.lines.push({ kind, text: line });
  }

  return sections;
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
  return String(model?.displayName || model?.name || modelId(model) || "Unknown model");
}

function modelDescription(model: any) {
  return String(model?.description || model?.id || model?.model || "");
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
  const [password, setPassword] = useState("");
  const [wsState, setWsState] = useState("offline");
  const [cwd, setCwd] = useState(defaultCwd);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectError, setProjectError] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [itemsByThread, setItemsByThread] = useState<Record<string, Record<string, ThreadItem>>>({});
  const [itemOrderByThread, setItemOrderByThread] = useState<Record<string, string[]>>({});
  const [turnsByThread, setTurnsByThread] = useState<Record<string, Record<string, TurnGroup>>>({});
  const [turnOrderByThread, setTurnOrderByThread] = useState<Record<string, string[]>>({});
  const [pendingPromptByThread, setPendingPromptByThread] = useState<Record<string, string>>({});
  const [promptByThread, setPromptByThread] = useState<Record<string, string>>({});
  const [runtimeSettings, setRuntimeSettings] = useState<SessionRuntimeSettings>(defaultRuntimeSettings);
  const [pendingRequests, setPendingRequests] = useState<ServerRequest[]>([]);
  const [activeTurnIdsByThread, setActiveTurnIdsByThread] = useState<Record<string, string>>({});
  const [queuedPromptsByThread, setQueuedPromptsByThread] = useState<Record<string, QueuedPrompt[]>>({});
  const [tokenUsageByThread, setTokenUsageByThread] = useState<Record<string, unknown>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState("");
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [pinnedDirs, setPinnedDirs] = useState<string[]>([]);
  const [collapsedThreadGroups, setCollapsedThreadGroups] = useState<string[]>([]);
  const [threadLayout, setThreadLayout] = useState<ThreadLayout>("directories");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [sessionManagerThreads, setSessionManagerThreads] = useState<Thread[]>([]);
  const [sessionManagerCursor, setSessionManagerCursor] = useState<string | null>(null);
  const [sessionManagerSearch, setSessionManagerSearch] = useState("");
  const [sessionManagerArchived, setSessionManagerArchived] = useState(false);
  const [sessionManagerLoading, setSessionManagerLoading] = useState(false);
  const [sessionManagerError, setSessionManagerError] = useState("");
  const [sessionManagerBusy, setSessionManagerBusy] = useState<string | null>(null);
  const [collapsedSessionManagerGroups, setCollapsedSessionManagerGroups] = useState<string[]>([]);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [commandPanel, setCommandPanel] = useState<CommandPanel>(null);
  const [commandPanelData, setCommandPanelData] = useState<any>(null);
  const [commandPanelLoading, setCommandPanelLoading] = useState(false);
  const [commandPanelError, setCommandPanelError] = useState("");
  const [permissionDraft, setPermissionDraft] = useState<PermissionDraft>(runtimePermissionDraft(defaultRuntimeSettings));
  const [renameValue, setRenameValue] = useState("");
  const [mentionQuery, setMentionQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [expandedMcpServers, setExpandedMcpServers] = useState<Set<string>>(() => new Set());
  const [draggingPinnedDir, setDraggingPinnedDir] = useState<string | null>(null);
  const [dropTargetPinnedDir, setDropTargetPinnedDir] = useState<string | null>(null);
  const autoNamedThreadIds = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const knownThreadIdsRef = useRef<Set<string>>(new Set());
  const dismissedThreadIdsRef = useRef<Set<string>>(new Set());
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingReplies = useRef(new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>());
  const drainingQueuedPromptId = useRef<string | null>(null);
  const failedQueuedPromptId = useRef<string | null>(null);
  const runtimeInitialized = useRef(false);
  const reconnectAttempt = useRef(0);
  const requestSeq = useRef(1);
  const sessionManagerRequestSeq = useRef(0);
  const turnDiffBaselines = useRef(new Map<string, TurnDiffBaseline>());

  const currentThreadKey = selectedThread?.id || "";
  const items = itemsByThread[currentThreadKey] || EMPTY_ITEMS;
  const itemOrder = itemOrderByThread[currentThreadKey] || EMPTY_ORDER;
  const turnsById = turnsByThread[currentThreadKey] || EMPTY_TURNS;
  const turnOrder = turnOrderByThread[currentThreadKey] || EMPTY_ORDER;
  const pendingPrompt = pendingPromptByThread[currentThreadKey] || "";
  const prompt = promptByThread[currentThreadKey] || "";
  const tokenUsage = tokenUsageByThread[currentThreadKey] ?? null;

  const setItemsForThread = useCallback(
    (threadId: string | null | undefined, updater: Record<string, ThreadItem> | ((current: Record<string, ThreadItem>) => Record<string, ThreadItem>)) => {
      if (!threadId) return;
      setItemsByThread((current) => {
        const old = current[threadId] || EMPTY_ITEMS;
        const next = typeof updater === "function" ? updater(old) : updater;
        if (next === old) return current;
        return { ...current, [threadId]: next };
      });
    },
    []
  );
  const setItemOrderForThread = useCallback(
    (threadId: string | null | undefined, updater: string[] | ((current: string[]) => string[])) => {
      if (!threadId) return;
      setItemOrderByThread((current) => {
        const old = current[threadId] || EMPTY_ORDER;
        const next = typeof updater === "function" ? updater(old) : updater;
        if (next === old) return current;
        return { ...current, [threadId]: next };
      });
    },
    []
  );
  const setTurnsForThread = useCallback(
    (threadId: string | null | undefined, updater: Record<string, TurnGroup> | ((current: Record<string, TurnGroup>) => Record<string, TurnGroup>)) => {
      if (!threadId) return;
      setTurnsByThread((current) => {
        const old = current[threadId] || EMPTY_TURNS;
        const next = typeof updater === "function" ? updater(old) : updater;
        if (next === old) return current;
        return { ...current, [threadId]: next };
      });
    },
    []
  );
  const setTurnOrderForThread = useCallback(
    (threadId: string | null | undefined, updater: string[] | ((current: string[]) => string[])) => {
      if (!threadId) return;
      setTurnOrderByThread((current) => {
        const old = current[threadId] || EMPTY_ORDER;
        const next = typeof updater === "function" ? updater(old) : updater;
        if (next === old) return current;
        return { ...current, [threadId]: next };
      });
    },
    []
  );
  const setPendingPrompt = useCallback(
    (value: string) => {
      const tid = selectedThreadIdRef.current || "";
      setPendingPromptByThread((current) => {
        if ((current[tid] || "") === value) return current;
        return { ...current, [tid]: value };
      });
    },
    []
  );
  const setPrompt = useCallback(
    (value: string | ((current: string) => string)) => {
      const tid = selectedThreadIdRef.current || "";
      setPromptByThread((current) => {
        const old = current[tid] || "";
        const next = typeof value === "function" ? value(old) : value;
        if (next === old) return current;
        return { ...current, [tid]: next };
      });
    },
    []
  );
  const discardThreadBucket = useCallback((threadId: string) => {
    if (!threadId) return;
    const drop = (record: Record<string, unknown>) => {
      if (!(threadId in record)) return record;
      const next = { ...record };
      delete next[threadId];
      return next;
    };
    setItemsByThread((current) => drop(current) as Record<string, Record<string, ThreadItem>>);
    setItemOrderByThread((current) => drop(current) as Record<string, string[]>);
    setTurnsByThread((current) => drop(current) as Record<string, Record<string, TurnGroup>>);
    setTurnOrderByThread((current) => drop(current) as Record<string, string[]>);
    setPendingPromptByThread((current) => drop(current) as Record<string, string>);
    setPromptByThread((current) => drop(current) as Record<string, string>);
    setTokenUsageByThread((current) => drop(current) as Record<string, unknown>);
  }, []);

  const renderedItems = useDeferredValue(items);
  const mode = runtimeSettings.mode;
  const sessionModel = runtimeSettings.model;
  const activeTurnId = selectedThread ? activeTurnIdsByThread[selectedThread.id] || null : null;
  const selectedQueuedPrompts = selectedThread ? queuedPromptsByThread[selectedThread.id] || [] : [];
  const nextQueuedPrompt = selectedQueuedPrompts[0] || null;
  const latestPlanText = useMemo(() => {
    const latestPlanLikeItem = [...itemOrder]
      .reverse()
      .map((id) => items[id])
      .find((item) => item?.type === "plan" || item?.type === "agentMessage");
    return latestPlanLikeItem ? itemText(latestPlanLikeItem).trim().slice(0, 12000) : "";
  }, [itemOrder, items]);

  const groupedRounds = useMemo<DisplayTurn[]>(() => {
    const rounds: DisplayTurn[] = [];
    const chronologicalItems = itemOrder.map((id) => renderedItems[id]).filter((item): item is ThreadItem => Boolean(item));
    const turnIdByItemId = new Map<string, string>();
    const roundsByTurnId = new Map<string, DisplayTurn>();
    const seenItemIds = new Set<string>();

    for (const turnId of turnOrder) {
      const turn = turnsById[turnId];
      if (!turn) continue;
      for (const itemId of turn.itemIds || []) {
        if (!turnIdByItemId.has(itemId)) turnIdByItemId.set(itemId, turnId);
      }
    }

    let currentLooseRound: DisplayTurn | null = null;

    for (const item of chronologicalItems) {
      if (seenItemIds.has(item.id)) continue;
      seenItemIds.add(item.id);

      const turnId = turnIdByItemId.get(item.id);
      const turn = turnId ? turnsById[turnId] : null;
      if (turnId && turn) {
        let round = roundsByTurnId.get(turnId);
        if (!round) {
          round = { ...turn, itemIds: [], items: [] };
          roundsByTurnId.set(turnId, round);
          rounds.push(round);
        }
        round.itemIds.push(item.id);
        round.items.push(item);
        currentLooseRound = null;
        continue;
      }

      if (item.type === "userMessage" || !currentLooseRound) {
        currentLooseRound = {
          id: `round-${item.id}`,
          itemIds: [item.id],
          status: { type: "completed" },
          items: [item]
        };
        rounds.push(currentLooseRound);
        continue;
      }

      currentLooseRound.itemIds.push(item.id);
      currentLooseRound.items.push(item);
    }

    const displayRounds = rounds.reverse();
    if (pendingPrompt) {
      displayRounds.unshift({
        id: "pending-start",
        itemIds: ["pending-user-message"],
        status: { type: "sending" },
        startedAt: nowSeconds(),
        updatedAt: nowSeconds(),
        pending: true,
        items: [
          {
            id: "pending-user-message",
            type: "userMessage",
            content: inputItems(pendingPrompt)
          }
        ]
      });
    }

    return displayRounds;
  }, [itemOrder, pendingPrompt, renderedItems, turnOrder, turnsById]);
  const activeRequest = pendingRequests[0] || null;
  const activeTurnItemIds = activeTurnId ? new Set(turnsById[activeTurnId]?.itemIds || []) : null;
  const orderedThreads = useMemo(
    () => [...threads].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    [threads]
  );
  const threadGroups = useMemo<ThreadGroup[]>(() => buildThreadGroups(orderedThreads, pinnedDirs), [orderedThreads, pinnedDirs]);
  const orderedSessionManagerThreads = useMemo(
    () => [...sessionManagerThreads].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
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
  const pinTargetPinned = Boolean(pinTarget && pinnedDirSet.has(pinTarget));
  const waitingThreadIds = useMemo(() => waitingThreadIdsFromRequests(pendingRequests), [pendingRequests]);
  const mcpRecentByServer = useMemo(() => {
    const result: Record<string, Array<{ id: string; tool: string; status: string }>> = {};
    if (!selectedThread) return result;
    const itemsForThread = itemsByThread[selectedThread.id] || EMPTY_ITEMS;
    const orderForThread = itemOrderByThread[selectedThread.id] || EMPTY_ORDER;
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
  }, [selectedThread, itemsByThread, itemOrderByThread]);
  const currentProjectLabel = directoryLabel(project?.realpath || cwd);
  const usageLabel = formatTokenUsage(tokenUsage);
  const slashOpen = prompt.startsWith("/") && !prompt.trim().includes(" ");
  const slashContext = useMemo(
    () => ({ hasThread: Boolean(selectedThread), activeTurn: Boolean(activeTurnId) }),
    [activeTurnId, selectedThread]
  );
  const slashMatches = useMemo(() => (slashOpen ? filterSlashCommands(prompt) : []), [prompt, slashOpen]);
  const selectedSlashIndex = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const selectedSlashCommand = slashMatches[selectedSlashIndex] || null;

  const call = useCallback((message: Omit<any, "requestId">) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket is not connected."));

    const requestId = `web-${requestSeq.current++}`;
    ws.send(JSON.stringify({ ...message, requestId }));

    return new Promise<any>((resolve, reject) => {
      pendingReplies.current.set(requestId, { resolve, reject });
      window.setTimeout(() => {
        if (!pendingReplies.current.has(requestId)) return;
        pendingReplies.current.delete(requestId);
        reject(new Error("Request timed out."));
      }, 120_000);
    });
  }, []);

  const codex = useCallback(
    (method: string, params?: unknown) => call({ type: "codex:request", method, params }),
    [call]
  );

  const registerTurnItem = useCallback(
    (threadId: string | null | undefined, turnId?: string, itemId?: string) => {
      if (!threadId || !turnId || !itemId) return;
      setTurnsForThread(threadId, (current) => {
        const turn = current[turnId] || { id: turnId, itemIds: [] };
        if (turn.itemIds?.includes(itemId)) return current;
        return {
          ...current,
          [turnId]: { ...turn, itemIds: uniqueAppend(turn.itemIds || [], itemId), updatedAt: nowSeconds() }
        };
      });
      setTurnOrderForThread(threadId, (current) => uniqueAppend(current, turnId));
    },
    [setTurnOrderForThread, setTurnsForThread]
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

  function updatePromptQueue(updater: (current: Record<string, QueuedPrompt[]>) => Record<string, QueuedPrompt[]>) {
    setQueuedPromptsByThread((current) => {
      const next = updater(current);
      window.localStorage.setItem(promptQueueStorageKey, JSON.stringify(next));
      return next;
    });
  }

  function enqueuePrompt(threadId: string, text: string) {
    const queuedPrompt = { id: queueId(), threadId, text, createdAt: nowSeconds() };
    updatePromptQueue((current) => ({
      ...current,
      [threadId]: [...(current[threadId] || []), queuedPrompt]
    }));
  }

  function removeQueuedPrompt(threadId: string, promptId: string) {
    updatePromptQueue((current) => {
      const nextPrompts = (current[threadId] || []).filter((queuedPrompt) => queuedPrompt.id !== promptId);
      const next = { ...current };
      if (nextPrompts.length) next[threadId] = nextPrompts;
      else delete next[threadId];
      return next;
    });
  }

  function clearQueuedPrompts(threadId: string) {
    updatePromptQueue((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
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
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    setSessionManagerThreads((current) => current.filter((thread) => thread.id !== threadId));
    clearQueuedPrompts(threadId);
    clearSelectedThreadState(threadId);
  }

  function restoreUnarchivedThread(thread: Thread) {
    knownThreadIdsRef.current.add(thread.id);
    dismissedThreadIdsRef.current.delete(thread.id);
    setThreads((current) => mergeThreadsById(current, [thread]));
    setSessionManagerThreads((current) => current.filter((item) => item.id !== thread.id));
  }

  const applyItemsFromTurns = useCallback(
    (threadId: string | null | undefined, turns: Turn[]) => {
      if (!threadId) return;
      const nextItems: Record<string, ThreadItem> = {};
      const nextOrder: string[] = [];
      const nextTurns: Record<string, TurnGroup> = {};
      const nextTurnOrder: string[] = [];
      for (const turn of turns) {
        const itemIds: string[] = [];
        for (const item of turn.items || []) {
          nextItems[item.id] = item;
          if (!nextOrder.includes(item.id)) nextOrder.push(item.id);
          if (!itemIds.includes(item.id)) itemIds.push(item.id);
        }
        nextTurns[turn.id] = {
          id: turn.id,
          itemIds,
          status: turn.status,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          updatedAt: turn.completedAt || turn.startedAt
        };
        if (!nextTurnOrder.includes(turn.id)) nextTurnOrder.push(turn.id);
      }
      setItemsByThread((current) => ({ ...current, [threadId]: nextItems }));
      setItemOrderByThread((current) => ({ ...current, [threadId]: nextOrder }));
      setTurnsByThread((current) => ({ ...current, [threadId]: nextTurns }));
      setTurnOrderByThread((current) => ({ ...current, [threadId]: nextTurnOrder }));
    },
    []
  );

  const refreshSelectedThread = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) return;

    const response = await codex("thread/read", { threadId, includeTurns: true });
    if (selectedThreadIdRef.current !== threadId) return;
    const refreshed = response.thread as Thread;
    if (!refreshed?.id) return;

    setSelectedThread(refreshed);
    updateActiveTurn(refreshed.id, activeTurnIdFromTurns(refreshed.turns || []));
    setThreads((current) => [refreshed, ...current.filter((candidate) => candidate.id !== refreshed.id)]);
    applyItemsFromTurns(refreshed.id, refreshed.turns || []);
  }, [applyItemsFromTurns, codex, updateActiveTurn]);

  const loadThreads = useCallback(async () => {
    const response = await codex("thread/list", { limit: 50, sortDirection: "desc" });
    setThreads(response.data || []);
  }, [codex]);

  const loadSessionManagerPage = useCallback(
    async (cursor: string | null = null) => {
      if (wsState !== "online") {
        setSessionManagerError("Codex is not connected.");
        return;
      }

      const requestId = ++sessionManagerRequestSeq.current;
      const searchTerm = sessionManagerSearch.trim();
      setSessionManagerLoading(true);
      setSessionManagerError("");

      try {
        const response = await codex("thread/list", {
          limit: 75,
          cursor,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: sessionManagerArchived,
          searchTerm: searchTerm || null
        });
        if (requestId !== sessionManagerRequestSeq.current) return;
        const nextThreads = (response.data || []) as Thread[];
        setSessionManagerThreads((current) => (cursor ? mergeThreadsById(current, nextThreads) : nextThreads));
        setSessionManagerCursor(response.nextCursor || null);
      } catch (error) {
        if (requestId === sessionManagerRequestSeq.current) {
          setSessionManagerError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (requestId === sessionManagerRequestSeq.current) setSessionManagerLoading(false);
      }
    },
    [codex, sessionManagerArchived, sessionManagerSearch, wsState]
  );

  function updateRuntimeSettings(next: Partial<SessionRuntimeSettings>) {
    setRuntimeSettings((current) => ({ ...current, ...next }));
  }

  const collaborationMode = useCallback((modelOverride?: string, turnMode: ModeKind = runtimeSettings.mode) => {
    const settings = { ...runtimeSettings, mode: turnMode, ...(modelOverride ? { model: modelOverride } : {}) };
    return buildCollaborationMode(settings, bootstrap?.codex?.collaborationModes || [], modelOverride, turnMode);
  }, [bootstrap?.codex?.collaborationModes, runtimeSettings]);

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

  const applyNotification = useCallback(
    (message: { method: string; params?: any }) => {
      const params = message.params || {};
      const tid = typeof params.threadId === "string" ? params.threadId : null;
      const clearPending = (threadId: string) =>
        setPendingPromptByThread((current) => {
          if (!(threadId in current)) return current;
          const next = { ...current };
          delete next[threadId];
          return next;
        });

      if (message.method === "thread/started" && params.thread) {
        knownThreadIdsRef.current.add(params.thread.id);
        dismissedThreadIdsRef.current.delete(params.thread.id);
        setThreads((current) => [params.thread, ...current.filter((thread) => thread.id !== params.thread.id)]);
      }

      if (message.method === "thread/archived" && params.threadId) {
        removeArchivedThread(params.threadId);
      }

      if (message.method === "thread/unarchived" && params.thread) {
        restoreUnarchivedThread(params.thread);
      } else if (message.method === "thread/unarchived" && params.threadId) {
        setSessionManagerThreads((current) => current.filter((thread) => thread.id !== params.threadId));
      }

      if (message.method === "thread/status/changed") {
        setThreads((current) =>
          current.map((thread) => (thread.id === params.threadId ? { ...thread, status: params.status } : thread))
        );
        setSelectedThread((current) => {
          if (!current || current.id !== params.threadId) return current;
          return { ...current, status: params.status };
        });
      }

      if (!tid) return;
      if (dismissedThreadIdsRef.current.has(tid)) return;
      if (!knownThreadIdsRef.current.has(tid)) return;

      if (message.method === "thread/tokenUsage/updated") {
        setTokenUsageByThread((current) => ({ ...current, [tid]: params }));
      }

      if (message.method === "turn/started") {
        const turn = params.turn as Turn | undefined;
        updateActiveTurn(tid, turn?.id || null);
        if (turn?.id) {
          setTurnsForThread(tid, (current) => ({
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
          setTurnOrderForThread(tid, (current) => uniqueAppend(current, turn.id));
        }
      }

      if (message.method === "turn/completed") {
        const turn = params.turn as Turn | undefined;
        updateActiveTurn(tid, null, turn?.id);
        clearPending(tid);
        if (turn?.id) {
          const turnItems = turn.items || [];
          setItemsForThread(tid, (current) => {
            const next = { ...current };
            for (const item of turnItems) next[item.id] = item;
            return next;
          });
          setItemOrderForThread(tid, (current) => {
            let next = current;
            for (const item of turnItems) next = uniqueAppend(next, item.id);
            return next;
          });
          setTurnsForThread(tid, (current) => ({
            ...current,
            [turn.id]: {
              id: turn.id,
              itemIds: uniqueItems(turnItems.map((item) => item.id)),
              status: turn.status,
              startedAt: turn.startedAt,
              completedAt: turn.completedAt,
              updatedAt: turn.completedAt || nowSeconds()
            }
          }));
          setTurnOrderForThread(tid, (current) => uniqueAppend(current, turn.id));
          loadCompletedTurnDiff(tid, turn.id).catch((error) =>
            setNotice(error instanceof Error ? error.message : String(error))
          );
        }
      }

      if (message.method === "item/started" && params.item) {
        clearPending(tid);
        setItemsForThread(tid, (current) => ({ ...current, [params.item.id]: params.item }));
        setItemOrderForThread(tid, (current) => uniqueAppend(current, params.item.id));
        registerTurnItem(tid, params.turnId || params.item.turnId, params.item.id);
      }

      if (message.method === "item/completed" && params.item) {
        clearPending(tid);
        setItemsForThread(tid, (current) => ({ ...current, [params.item.id]: params.item }));
        setItemOrderForThread(tid, (current) => uniqueAppend(current, params.item.id));
        registerTurnItem(tid, params.turnId || params.item.turnId, params.item.id);
      }

      if (message.method === "item/agentMessage/delta" || message.method === "item/plan/delta") {
        startTransition(() => {
          setItemsForThread(tid, (current) => {
            const item = current[params.itemId] || { id: params.itemId, type: message.method.includes("plan") ? "plan" : "agentMessage", text: "" };
            return { ...current, [params.itemId]: { ...item, text: `${item.text || ""}${params.delta || ""}` } };
          });
          setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
          registerTurnItem(tid, params.turnId, params.itemId);
        });
      }

      if (message.method === "item/reasoning/summaryPartAdded") {
        startTransition(() => {
          setItemsForThread(tid, (current) => {
            const item = current[params.itemId] || { id: params.itemId, type: "reasoning", summary: [], content: [] };
            const summary = [...(item.summary || [])];
            summary[params.summaryIndex || 0] = summary[params.summaryIndex || 0] || "";
            return { ...current, [params.itemId]: { ...item, summary } };
          });
          setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
          registerTurnItem(tid, params.turnId, params.itemId);
        });
      }

      if (message.method === "item/reasoning/summaryTextDelta") {
        startTransition(() => {
          setItemsForThread(tid, (current) => {
            const item = current[params.itemId] || { id: params.itemId, type: "reasoning", summary: [], content: [] };
            const summary = [...(item.summary || [])];
            summary[params.summaryIndex || 0] = `${summary[params.summaryIndex || 0] || ""}${params.delta || ""}`;
            return { ...current, [params.itemId]: { ...item, summary } };
          });
          setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
          registerTurnItem(tid, params.turnId, params.itemId);
        });
      }

      if (message.method === "item/reasoning/textDelta") {
        startTransition(() => {
          setItemsForThread(tid, (current) => {
            const item = current[params.itemId] || { id: params.itemId, type: "reasoning", summary: [], content: [] };
            const content = [...((item.content || []).filter((part): part is string => typeof part === "string"))];
            content[params.contentIndex || 0] = `${content[params.contentIndex || 0] || ""}${params.delta || ""}`;
            return { ...current, [params.itemId]: { ...item, content } };
          });
          setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
          registerTurnItem(tid, params.turnId, params.itemId);
        });
      }

      if (message.method === "item/commandExecution/outputDelta") {
        startTransition(() => {
          setItemsForThread(tid, (current) => {
            const item = current[params.itemId] || { id: params.itemId, type: "commandExecution", aggregatedOutput: "" };
            return {
              ...current,
              [params.itemId]: {
                ...item,
                aggregatedOutput: `${item.aggregatedOutput || ""}${params.delta || ""}`
              }
            };
          });
          setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
          registerTurnItem(tid, params.turnId, params.itemId);
        });
      }

      if (message.method === "item/fileChange/outputDelta") {
        startTransition(() => {
          setItemsForThread(tid, (current) => {
            const item = current[params.itemId] || { id: params.itemId, type: "fileChange", output: "" };
            return { ...current, [params.itemId]: { ...item, output: `${item.output || ""}${params.delta || ""}` } };
          });
          setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
          registerTurnItem(tid, params.turnId, params.itemId);
        });
      }

      if (message.method === "item/fileChange/patchUpdated") {
        setItemsForThread(tid, (current) => {
          const item = current[params.itemId] || { id: params.itemId, type: "fileChange" };
          return { ...current, [params.itemId]: { ...item, changes: params.changes || [] } };
        });
        setItemOrderForThread(tid, (current) => uniqueAppend(current, params.itemId));
        registerTurnItem(tid, params.turnId, params.itemId);
      }

      if (message.method === "turn/diff/updated") {
        const itemId = `${params.turnId}-diff`;
        startTransition(() => {
          setItemsForThread(tid, (current) => ({
            ...current,
            [itemId]: { id: itemId, type: "diff", text: params.diff || "" }
          }));
          setItemOrderForThread(tid, (current) => uniqueAppend(current, itemId));
          registerTurnItem(tid, params.turnId, itemId);
        });
      }

      if (message.method === "turn/plan/updated") {
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
        startTransition(() => {
          setItemsForThread(tid, (current) => ({
            ...current,
            [itemId]: {
              id: itemId,
              type: "plan",
              text: `${explanation}${plan}`.trim(),
              explanation: String(params.explanation || ""),
              planEntries
            }
          }));
          setItemOrderForThread(tid, (current) => uniqueAppend(current, itemId));
          registerTurnItem(tid, params.turnId, itemId);
        });
      }
    },
    [loadCompletedTurnDiff, registerTurnItem, setItemOrderForThread, setItemsForThread, setTurnOrderForThread, setTurnsForThread, updateActiveTurn]
  );

  useEffect(() => {
    selectedThreadIdRef.current = selectedThread?.id || null;
  }, [selectedThread?.id]);

  useEffect(() => {
    const next = new Set<string>();
    for (const thread of threads) next.add(thread.id);
    if (selectedThread?.id) next.add(selectedThread.id);
    for (const id of Object.keys(queuedPromptsByThread)) next.add(id);
    knownThreadIdsRef.current = next;
  }, [queuedPromptsByThread, selectedThread?.id, threads]);

    useEffect(() => {
      const saved = window.localStorage.getItem("codex-remote-console.cwd");
      if (saved) setCwd(saved);
    const recent = window.localStorage.getItem("codex-remote-console.recentDirs");
    if (recent) setRecentDirs(JSON.parse(recent));
    const pinned = window.localStorage.getItem("codex-remote-console.pinnedDirs");
    if (pinned) setPinnedDirs(JSON.parse(pinned));
    const collapsed = window.localStorage.getItem("codex-remote-console.collapsedThreadGroups");
    if (collapsed) setCollapsedThreadGroups(JSON.parse(collapsed));
    const savedThreadLayout = window.localStorage.getItem(threadLayoutStorageKey);
    if (savedThreadLayout === "directories" || savedThreadLayout === "recent") setThreadLayout(savedThreadLayout);
    const savedSidebarCollapsed = window.localStorage.getItem("codex-remote-console.sidebarCollapsed");
    if (savedSidebarCollapsed === "true") setSidebarCollapsed(true);
    const savedSidebarWidth = Number(window.localStorage.getItem(sidebarWidthStorageKey));
    if (Number.isFinite(savedSidebarWidth)) setSidebarWidth(clampSidebarWidth(savedSidebarWidth));
    const promptQueue = window.localStorage.getItem(promptQueueStorageKey);
      if (promptQueue) setQueuedPromptsByThread(JSON.parse(promptQueue));
  
      bootstrapPromise
        ?.then((nextBootstrap: Bootstrap) => {
          setBootstrap(nextBootstrap);
          if (!saved && nextBootstrap.defaultCwd) setCwd(nextBootstrap.defaultCwd);
        })
        .catch((error) => setNotice(error.message));
    }, []);

    const wsAllowed = bootstrap === null || bootstrap.authenticated === true;
    useEffect(() => {
      if (!wsAllowed) return;

      let stopped = false;
      let retry: number | null = null;

    function rejectPending(error: Error) {
      for (const pending of pendingReplies.current.values()) pending.reject(error);
      pendingReplies.current.clear();
    }

      function refreshLiveState() {
        loadThreads().catch((error) => setNotice(error.message));
        refreshSelectedThread().catch((error) => setNotice(error.message));
      }

      function handleGatewayEvent(message: any) {
        if (message.type === "reply") {
          const reply = message as Reply;
          const pending = pendingReplies.current.get(reply.requestId);
          if (!pending) return;
          pendingReplies.current.delete(reply.requestId);
          if (reply.ok) pending.resolve(reply.result);
          else pending.reject(new Error(reply.error || "Request failed."));
          return;
        }

        if (message.type === "gateway:snapshot") {
          setBootstrap((current) =>
            current ? { ...current, codex: message.snapshot, codexError: null } : current
          );
          setPendingRequests(message.snapshot?.pendingServerRequests || []);
          return;
        }

        if (message.type === "gateway:state") {
          setWsState(message.status === "connected" ? "online" : message.status);
          if (message.detail) setNotice(message.detail);
          return;
        }

        if (message.type === "codex:notification") {
          applyNotification(message.message);
          return;
        }

        if (message.type === "codex:serverRequest") {
          setPendingRequests((current) => [
            ...current.filter((request) => request.id !== message.request.id),
            message.request
          ]);
          return;
        }

        if (message.type === "codex:serverRequestResolved") {
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
          reconnectAttempt.current = 0;
          setWsState("online");
          refreshLiveState();
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
          handleGatewayEvent(JSON.parse(event.data));
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
        if (wsRef.current?.readyState === WebSocket.OPEN) refreshLiveState();
        else reconnectNow();
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
    }, [applyNotification, wsAllowed, loadThreads, refreshSelectedThread]);

  useEffect(() => {
    if (wsState !== "online") return;
    loadThreads().catch((error) => setNotice(error.message));
  }, [loadThreads, wsState]);

  useEffect(() => {
    if (!sessionManagerOpen) return;
    const timer = window.setTimeout(() => loadSessionManagerPage(null), 160);
    return () => window.clearTimeout(timer);
  }, [loadSessionManagerPage, sessionManagerOpen]);

  useEffect(() => {
    if (!slashOpen) return;
    setSlashIndex(0);
  }, [prompt, slashOpen]);

  useEffect(() => {
    if (!slashMatches.length || slashIndex < slashMatches.length) return;
    setSlashIndex(slashMatches.length - 1);
  }, [slashIndex, slashMatches.length]);

  useEffect(() => {
    if (wsState !== "online" || runtimeInitialized.current) return;
    runtimeInitialized.current = true;
    codex("config/read", { includeLayers: false, cwd: selectedRoot(selectedThread, project, cwd) || null })
      .then((response) => {
        const config = response?.config || {};
        setRuntimeSettings((current) => ({
          ...current,
          model: current.model || config.model || "",
          reasoningEffort: current.reasoningEffort ?? config.model_reasoning_effort ?? null,
          serviceTier: current.serviceTier ?? config.service_tier ?? null,
          approvalPolicy: current.approvalPolicy ?? config.approval_policy ?? null,
          sandboxMode: current.sandboxMode ?? config.sandbox_mode ?? null
        }));
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
    if (failedQueuedPromptId.current && failedQueuedPromptId.current !== nextQueuedPrompt?.id) {
      failedQueuedPromptId.current = null;
    }
  }, [nextQueuedPrompt?.id]);

  useEffect(() => {
    if (!selectedThread || activeTurnId || wsState !== "online" || !nextQueuedPrompt) return;
    if (drainingQueuedPromptId.current || failedQueuedPromptId.current === nextQueuedPrompt.id) return;

    const threadId = selectedThread.id;
    const queuedPrompt = nextQueuedPrompt;
    drainingQueuedPromptId.current = queuedPrompt.id;
    setPendingPrompt(queuedPrompt.text);

    startTurn(threadId, queuedPrompt.text)
      .then(() => removeQueuedPrompt(threadId, queuedPrompt.id))
      .catch((error) => {
        setPendingPrompt("");
        failedQueuedPromptId.current = queuedPrompt.id;
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (drainingQueuedPromptId.current === queuedPrompt.id) drainingQueuedPromptId.current = null;
      });
  }, [activeTurnId, nextQueuedPrompt, selectedThread, wsState]);

  useEffect(() => {
    if (wsState !== "online") return;
    for (const thread of threads) {
      if (thread.name) continue;
      if (autoNamedThreadIds.current.has(thread.id)) continue;
      if (activeTurnIdsByThread[thread.id]) continue;
      const orderForThread = itemOrderByThread[thread.id];
      const itemsForThread = itemsByThread[thread.id];
      if (!orderForThread || !itemsForThread || orderForThread.length < 2) continue;
      const firstUserItem = orderForThread.map((id) => itemsForThread[id]).find((item) => item?.type === "userMessage");
      if (!firstUserItem) continue;
      const text = userMessageParts(firstUserItem).text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const segment = text.split(/[.?!\n。？！]/)[0] || text;
      const title = segment.slice(0, 28).trim();
      if (!title) continue;
      autoNamedThreadIds.current.add(thread.id);
      const threadId = thread.id;
      codex("thread/name/set", { threadId, name: title })
        .then(() => {
          setThreads((current) =>
            current.map((candidate) => (candidate.id === threadId ? { ...candidate, name: title } : candidate))
          );
          setSelectedThread((current) =>
            current && current.id === threadId ? { ...current, name: title } : current
          );
        })
        .catch(() => {
          autoNamedThreadIds.current.delete(threadId);
        });
    }
  }, [activeTurnIdsByThread, codex, itemOrderByThread, itemsByThread, threads, wsState]);

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
    window.localStorage.setItem("codex-remote-console.recentDirs", JSON.stringify(next));
  }

  function togglePinnedDirectory(path: string) {
    const target = normalizeDirectoryPath(path);
    if (!target) return;
    setPinnedDirs((current) => {
      const next = current.some((item) => normalizeDirectoryPath(item) === target)
        ? current.filter((item) => normalizeDirectoryPath(item) !== target)
        : [target, ...current.filter((item) => normalizeDirectoryPath(item) !== target)].slice(0, 12);
      window.localStorage.setItem("codex-remote-console.pinnedDirs", JSON.stringify(next));
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
      window.localStorage.setItem("codex-remote-console.pinnedDirs", JSON.stringify(next));
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
      window.localStorage.setItem("codex-remote-console.collapsedThreadGroups", JSON.stringify(next));
      return next;
    });
  }

  function updateThreadLayout(next: ThreadLayout) {
    setThreadLayout(next);
    window.localStorage.setItem(threadLayoutStorageKey, next);
  }

  function setSidebarCollapsedValue(next: boolean) {
    setSidebarCollapsed(next);
    window.localStorage.setItem("codex-remote-console.sidebarCollapsed", String(next));
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

    setSessionManagerBusy(thread.id);
    try {
      await codex("thread/archive", { threadId: thread.id });
      removeArchivedThread(thread.id);
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
        await codex("thread/archive", { threadId: thread.id });
        removeArchivedThread(thread.id);
      }
      setNotice(`Archived ${archivable.length} sessions${skipped ? `, skipped ${skipped} active.` : "."}`);
    } finally {
      setSessionManagerBusy(null);
    }
  }

  async function restoreManagedThread(thread: Thread) {
    setSessionManagerBusy(thread.id);
    try {
      const response = await codex("thread/unarchive", { threadId: thread.id });
      const restored = (response.thread || thread) as Thread;
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

  async function resolveCwdValue(value: string) {
    setProjectError("");
    try {
      const result = await getJson<ProjectInfo>(`/api/projects/resolve?cwd=${encodeURIComponent(value)}`);
      setProject(result);
      setCwd(result.realpath);
      window.localStorage.setItem("codex-remote-console.cwd", result.realpath);
      rememberDirectory(result.realpath);
      return result;
    } catch (error) {
      setProject(null);
      setProjectError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function resolveCwd() {
    await resolveCwdValue(cwd).catch(() => undefined);
  }

  async function useDirectory(path: string) {
    setDirectoryPickerOpen(false);
    setMobilePanel(null);
    await resolveCwdValue(path).catch(() => undefined);
  }

  async function startThread(initialPrompt?: string, initialAttachments: Attachment[] = []) {
    const resolved = await resolveCwdValue(cwd);
    const threadResponse = await codex("thread/start", {
      cwd: resolved.realpath,
      ...runtimeThreadParams(runtimeSettings)
    });
    const thread = threadResponse.thread as Thread;
    knownThreadIdsRef.current.add(thread.id);
    dismissedThreadIdsRef.current.delete(thread.id);
    selectedThreadIdRef.current = thread.id;
    setSelectedThread(thread);
    updateActiveTurn(thread.id, activeTurnIdFromTurns(thread.turns || []));
    if (!initialPrompt) setPendingPromptByThread((current) => ({ ...current, [thread.id]: "" }));
    applyItemsFromTurns(thread.id, thread.turns || []);
    setMobilePanel(null);
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);

    updateRuntimeSettings({
      model: threadResponse.model || runtimeSettings.model,
      reasoningEffort: threadResponse.reasoningEffort ?? runtimeSettings.reasoningEffort,
      serviceTier: threadResponse.serviceTier ?? runtimeSettings.serviceTier,
      approvalPolicy: threadResponse.approvalPolicy ?? runtimeSettings.approvalPolicy
    });

    if (initialPrompt || initialAttachments.length) {
      await sendToThread(thread.id, initialPrompt || "", threadResponse.model || "", initialAttachments);
    } else {
      window.setTimeout(() => promptRef.current?.focus(), 0);
    }
  }

  async function resumeThread(thread: Thread) {
    // Switch the UI to the new session immediately so the conversation panel
    // doesn't keep showing the previous session's content while the (often
    // slow) thread/resume call is in flight.
    knownThreadIdsRef.current.add(thread.id);
    dismissedThreadIdsRef.current.delete(thread.id);
    selectedThreadIdRef.current = thread.id;
    setSelectedThread(thread);
    setMobilePanel(null);
    window.setTimeout(() => promptRef.current?.focus(), 0);

    const response = await codex("thread/resume", {
      threadId: thread.id,
      excludeTurns: false,
      ...runtimeThreadParams(runtimeSettings)
    });

    // Drop the response if the user has switched to a different session in
    // the meantime, otherwise the slow reply would clobber the newer one.
    if (selectedThreadIdRef.current !== thread.id) return;

    const resumed = response.thread as Thread;
    selectedThreadIdRef.current = resumed.id;
    setSelectedThread(resumed);
    updateActiveTurn(resumed.id, activeTurnIdFromTurns(resumed.turns || []));
    setThreads((current) => [resumed, ...current.filter((candidate) => candidate.id !== resumed.id)]);
    updateRuntimeSettings({
      model: response.model || runtimeSettings.model,
      reasoningEffort: response.reasoningEffort ?? runtimeSettings.reasoningEffort,
      serviceTier: response.serviceTier ?? runtimeSettings.serviceTier,
      approvalPolicy: response.approvalPolicy ?? runtimeSettings.approvalPolicy
    });
    setPendingPromptByThread((current) => ({ ...current, [resumed.id]: "" }));
    applyItemsFromTurns(resumed.id, resumed.turns || []);
  }

  async function startTurn(
    threadId: string,
    text: string,
    modelOverride?: string,
    inputAttachments: Attachment[] = [],
    turnMode: ModeKind = mode
  ) {
    const input = inputItems(text, inputAttachments);
    const root = selectedRoot(selectedThread, project, cwd);
    const diffBaseline = root
      ? await postJson<DiffSnapshot>("/api/projects/diff-snapshot", { cwd: root }).catch(() => null)
      : null;
    const turnRuntimeSettings = {
      ...runtimeSettings,
      mode: turnMode,
      ...(modelOverride ? { model: modelOverride } : {})
    };

    const response = await codex("turn/start", {
      threadId,
      input,
      ...runtimeTurnParams(turnRuntimeSettings),
      collaborationMode: collaborationMode(modelOverride, turnMode)
    });
    const turn = response?.turn as Turn | undefined;
    updateActiveTurn(threadId, turn?.id || null);
    if (turn?.id && diffBaseline) {
      turnDiffBaselines.current.set(turn.id, { cwd: diffBaseline.root, tree: diffBaseline.tree });
    }
    return response;
  }

  async function sendToThread(
    threadId: string,
    text: string,
    modelOverride?: string,
    inputAttachments: Attachment[] = [],
    turnMode: ModeKind = mode
  ) {
    await startTurn(threadId, text, modelOverride, inputAttachments, turnMode);
  }

  async function runPlan() {
    if (!selectedThread || wsState !== "online") return;

    const threadId = selectedThread.id;
    const text = latestPlanText
      ? `Implement this plan now. Start making the required code changes, then run appropriate verification.\n\n${latestPlanText}`
      : "Implement the plan from the previous turn. Start making the required code changes now, then run appropriate verification.";
    updateRuntimeSettings({ mode: "default" });
    setPendingPrompt(text);
    try {
      if (activeTurnId) {
        await codex("turn/interrupt", { threadId, turnId: activeTurnId });
        updateActiveTurn(threadId, null, activeTurnId);
      }
      await sendToThread(threadId, text, undefined, [], "default");
    } catch (error) {
      setPendingPrompt("");
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function steerCurrentTurn(text: string) {
    if (!selectedThread || !activeTurnId) return;
    await codex("turn/steer", {
      threadId: selectedThread.id,
      input: inputItems(text),
      expectedTurnId: activeTurnId
    });
  }

  async function submitPrompt(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    const inputAttachments = attachments;
    if (!text && inputAttachments.length === 0) return;

    if (text.startsWith("/")) {
      setPrompt("");
      if (inputAttachments.length) {
        setNotice("Slash commands cannot include image attachments.");
        return;
      }
      const command = findSlashCommand(text);
      if (!command) {
        setNotice(`Unknown slash command: ${text}`);
        return;
      }
      await executeSlashCommand(command);
      return;
    }

    if (selectedThread && activeTurnId && inputAttachments.length > 0) {
      setNotice("Image attachments can be sent after the active turn finishes.");
      return;
    }

    setPrompt("");
    if (selectedThread && activeTurnId) {
      enqueuePrompt(selectedThread.id, text);
      return;
    }

    setPendingPrompt(text);
    try {
      if (!selectedThread) await startThread(text, inputAttachments);
      else await sendToThread(selectedThread.id, text, undefined, inputAttachments);
      setAttachments([]);
    } catch (error) {
      setPendingPrompt("");
      setNotice(error instanceof Error ? error.message : String(error));
      setPrompt(text);
    }
  }

  async function submitSteerPrompt() {
    const text = prompt.trim();
    if (!text || !selectedThread || !activeTurnId) return;

    setPrompt("");
    try {
      await steerCurrentTurn(text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      setPrompt(text);
    }
  }

  async function interrupt() {
    if (!selectedThread || !activeTurnId) return;
    await codex("turn/interrupt", { threadId: selectedThread.id, turnId: activeTurnId });
    updateActiveTurn(selectedThread.id, null, activeTurnId);
  }

  async function loadCommandPanel(panel: Exclude<CommandPanel, null>) {
    setCommandPanelLoading(true);
    setCommandPanelError("");
    try {
      const root = selectedRoot(selectedThread, project, cwd);
      if (panel === "collab") {
        const response = await codex("collaborationMode/list", {});
        setCommandPanelData(response?.data || bootstrap?.codex?.collaborationModes || []);
      } else if (panel === "model") {
        setCommandPanelData(await codex("model/list", { limit: 100, includeHidden: false }));
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

  function applyCollabPreset(preset: any) {
    if (preset?.mode !== "default" && preset?.mode !== "plan") {
      setNotice("This collaboration mode is not mapped in Codex Remote Console yet.");
      return;
    }
    updateRuntimeSettings({
      mode: preset.mode,
      ...(preset.model ? { model: preset.model } : {}),
      reasoningEffort: preset.reasoning_effort ?? runtimeSettings.reasoningEffort
    });
    setCommandPanel(null);
    setNotice(`${modeLabel(preset.mode)} mode selected.`);
  }

  function selectModel(model: any, effort?: ReasoningEffort) {
    const nextModel = modelId(model);
    if (!nextModel) return;
    updateRuntimeSettings({
      model: nextModel,
      reasoningEffort: effort ?? model?.defaultReasoningEffort ?? runtimeSettings.reasoningEffort
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

    const response = await codex("thread/resume", {
      threadId: selectedThread.id,
      excludeTurns: false,
      ...runtimeThreadParams(nextSettings)
    });
    const resumed = response.thread as Thread;
    selectedThreadIdRef.current = resumed.id;
    setSelectedThread(resumed);
    updateActiveTurn(resumed.id, activeTurnIdFromTurns(resumed.turns || []));
    setThreads((current) => [resumed, ...current.filter((candidate) => candidate.id !== resumed.id)]);
    applyItemsFromTurns(resumed.id, resumed.turns || []);
    updateRuntimeSettings({
      ...nextSettings,
      model: response.model || nextSettings.model,
      reasoningEffort: response.reasoningEffort ?? nextSettings.reasoningEffort,
      serviceTier: response.serviceTier ?? nextSettings.serviceTier,
      approvalPolicy: response.approvalPolicy ?? nextSettings.approvalPolicy
    });
    setNotice("Permissions refreshed for the idle session.");
  }

  async function saveRename() {
    if (!selectedThread) return;
    const name = renameValue.trim();
    if (!name) {
      setNotice("Enter a session title first.");
      return;
    }
    await codex("thread/name/set", { threadId: selectedThread.id, name });
    setSelectedThread((current) => (current && current.id === selectedThread.id ? { ...current, name } : current));
    setThreads((current) => current.map((thread) => (thread.id === selectedThread.id ? { ...thread, name } : thread)));
    setCommandPanel(null);
    setNotice("Session renamed.");
  }

  async function forkCurrentThread(ephemeral: boolean) {
    if (!selectedThread) return;
    const response = await codex("thread/fork", {
      threadId: selectedThread.id,
      ephemeral,
      excludeTurns: false,
      persistExtendedHistory: true,
      ...runtimeThreadParams(runtimeSettings)
    });
    const thread = response.thread as Thread;
    knownThreadIdsRef.current.add(thread.id);
    dismissedThreadIdsRef.current.delete(thread.id);
    selectedThreadIdRef.current = thread.id;
    setSelectedThread(thread);
    updateActiveTurn(thread.id, activeTurnIdFromTurns(thread.turns || []));
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    applyItemsFromTurns(thread.id, thread.turns || []);
    updateRuntimeSettings({
      model: response.model || runtimeSettings.model,
      reasoningEffort: response.reasoningEffort ?? runtimeSettings.reasoningEffort,
      serviceTier: response.serviceTier ?? runtimeSettings.serviceTier,
      approvalPolicy: response.approvalPolicy ?? runtimeSettings.approvalPolicy
    });
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
    setPrompt((current) => {
      const separator = current && !/\s$/.test(current) ? " " : "";
      return `${current}${separator}@${path}`;
    });
    setCommandPanel(null);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  async function toggleExperimentalFeature(feature: any) {
    const name = String(feature?.name || "");
    if (!name) return;
    await codex("experimentalFeature/enablement/set", { enablement: { [name]: !feature.enabled } });
    await loadCommandPanel("experimental");
  }

  async function setMemoryMode(mode: "enabled" | "disabled") {
    if (!selectedThread) return;
    await codex("thread/memoryMode/set", { threadId: selectedThread.id, mode });
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
        const nextMode: ModeKind = command.id === "plan" ? "plan" : "default";
        updateRuntimeSettings({ mode: nextMode });
        setNotice(`${modeLabel(nextMode)} mode selected.`);
        return;
      }

      if (command.action === "open-panel") {
        await openCommandPanel(command.id as Exclude<CommandPanel, null>);
        return;
      }

      if (command.action === "toggle-fast") {
        const serviceTier: ServiceTier = runtimeSettings.serviceTier === "fast" ? "flex" : "fast";
        updateRuntimeSettings({ serviceTier });
        setNotice(`Service tier set to ${serviceTier}. It applies to future turns in this browser session.`);
        return;
      }

      if (command.action === "run-review" && selectedThread) {
        try {
          const response = await codex("review/start", {
            threadId: selectedThread.id,
            target: { type: "uncommittedChanges" },
            delivery: "inline"
          });
          updateActiveTurn(selectedThread.id, response?.turn?.id || null);
          setNotice("Review started in the current session.");
        } catch (error) {
          if (!looksUnsupportedMethod(error)) throw error;
          await startTurn(
            selectedThread.id,
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
        await startThread();
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
        await codex("thread/compact/start", { threadId: selectedThread.id });
        setNotice("Conversation compaction started.");
        return;
      }

      if (command.action === "copy-last") {
        await copyLatestOutput();
        return;
      }

      if (command.action === "show-diff") {
        await openCommandPanel("diff");
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
          await codex("thread/backgroundTerminals/clean", { threadId: selectedThread.id });
          setNotice("Background terminals cleaned for this session.");
          return;
        }
        setNotice("No active turn or selected session to stop.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function closeThread() {
    if (!selectedThread) return;
    if (activeTurnId) {
      setNotice("Stop the active turn before closing this session.");
      return;
    }
    const closingId = selectedThread.id;
    await codex("thread/unsubscribe", { threadId: closingId });
    dismissedThreadIdsRef.current.add(closingId);
    knownThreadIdsRef.current.delete(closingId);
    selectedThreadIdRef.current = null;
    updateActiveTurn(closingId, null);
    setSelectedThread(null);
    discardThreadBucket(closingId);
  }

  async function archiveThread() {
    if (!selectedThread) return;
    if (activeTurnId) {
      setNotice("Stop the active turn before archiving this session.");
      return;
    }
    await archiveManagedThread(selectedThread);
  }

  async function answerServerRequest(request: ServerRequest, result: unknown) {
    await call({
      type: "codex:serverResponse",
      serverRequestId: request.id,
      result
    });
    setPendingRequests((current) => current.filter((item) => item.id !== request.id));
  }

  async function addImageFiles(files: File[]) {
    if (!files.length) return;
    try {
      const next = await Promise.all(files.map(readImageAttachment));
      setAttachments((current) => [...current, ...next].slice(0, 8));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
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
            <button title="Close session manager" type="button" onClick={() => setSessionManagerOpen(false)}>
              <X size={17} />
            </button>
          </header>

          <div className="sessionManagerToolbar">
            <label className="sessionSearch">
              <Search size={16} />
              <input
                value={sessionManagerSearch}
                onChange={(event) => setSessionManagerSearch(event.target.value)}
                placeholder="Search sessions"
              />
            </label>
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
                  const busy = sessionManagerBusy === thread.id;
                  return (
                    <div className={`managerThreadRow ${selectedThread?.id === thread.id ? "selected" : ""}`} key={thread.id}>
                      <button
                        className="managerThreadMain managerThreadMainFlat"
                        type="button"
                        onClick={() => chooseManagedThread(thread).catch((error) => setNotice(error.message))}
                      >
                        <strong>{thread.name || thread.preview || "Untitled session"}</strong>
                        <small>{formatTime(thread.updatedAt)}</small>
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
                      <div className="threadGroupPath">{group.cwd}</div>
                      <div className="managerThreadRows">
                        {group.threads.map((thread) => {
                          const active = threadIsActive(thread, activeTurnIdsByThread);
                          const busy = sessionManagerBusy === thread.id;
                          return (
                            <div className={`managerThreadRow ${selectedThread?.id === thread.id ? "selected" : ""}`} key={thread.id}>
                              <button
                                className="managerThreadMain"
                                type="button"
                                onClick={() => chooseManagedThread(thread).catch((error) => setNotice(error.message))}
                              >
                                <strong>{thread.name || thread.preview || "Untitled session"}</strong>
                                <small>{formatTime(thread.updatedAt)}</small>
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
            <p>Session-scoped command settings. Changes here do not write ~/.codex/config.toml.</p>
          </header>

          {commandPanelLoading ? <p className="muted">Loading...</p> : null}
          {commandPanelError ? <p className="errorText">{commandPanelError}</p> : null}

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
                return (
                  <div className={`commandRow modelRow ${active ? "selected" : ""}`} key={modelId(model)}>
                    <button type="button" onClick={() => selectModel(model)}>
                      <span>
                        <strong>{modelTitle(model)}</strong>
                        <small>{modelDescription(model)}</small>
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
              <dd>{runtimeSettings.model || "server default"}</dd>
              <dt>Reasoning</dt>
              <dd>{runtimeSettings.reasoningEffort || "server default"}</dd>
              <dt>Service tier</dt>
              <dd>{runtimeSettings.serviceTier || "server default"}</dd>
              <dt>Mode</dt>
              <dd>{modeLabel(runtimeSettings.mode)}</dd>
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

  if (!bootstrap) {
    return <main className="boot">Loading Codex Remote Console...</main>;
  }

  if (!bootstrap.authenticated) {
    return (
      <main className="loginShell">
        <form className="loginPanel" onSubmit={login}>
          <Code2 size={32} />
          <h1>Codex Remote Console</h1>
          <p>Private access to server-side Codex sessions.</p>
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
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
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
            <button title="Expand sessions" type="button" onClick={() => setSidebarCollapsedValue(false)}>
              <PanelLeftOpen size={18} />
            </button>
            <button title="New session" type="button" onClick={() => startThread().catch((error) => setNotice(error.message))} disabled={wsState !== "online" || !cwd.trim()}>
              <SquarePen size={18} />
            </button>
            <button title="Manage sessions" type="button" onClick={openSessionManager}>
              <History size={18} />
              <span>{threads.length}</span>
            </button>
          </div>
        ) : (
          <>
        <div className="brand">
          <Code2 size={24} />
          <div>
            <h1>Codex Remote Console</h1>
            <span>{bootstrap.codexVersion}</span>
          </div>
          <div className="brandActions">
            <button className="desktopCollapseButton" title="Collapse sessions" type="button" onClick={() => setSidebarCollapsedValue(true)}>
              <PanelLeftClose size={17} />
            </button>
          <button className="mobileSheetClose" title="Close panel" type="button" onClick={() => setMobilePanel(null)}>
            <X size={17} />
          </button>
          </div>
        </div>

        <section className="panel projectPanel">
          <label>Server directory</label>
          <div className="pathRow">
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} spellCheck={false} />
            <button
              title={pinTargetPinned ? "Unpin current directory" : "Pin current directory"}
              type="button"
              onClick={() => togglePinnedDirectory(pinTarget)}
            >
              {pinTargetPinned ? <PinOff size={18} /> : <Pin size={18} />}
            </button>
            <button
              title="Browse server directories"
              type="button"
              onClick={() => {
                setMobilePanel(null);
                setDirectoryPickerOpen(true);
              }}
            >
              <FolderOpen size={18} />
            </button>
          </div>
          <div className="pathActions">
            <button type="button" onClick={resolveCwd}>
              <Check size={15} />
              Check path
            </button>
            {pinnedDirs.slice(0, 3).map((path) => (
              <button className="pinnedPathButton" key={path} title={path} type="button" onClick={() => useDirectory(path)}>
                <Pin size={13} />
                {directoryLabel(path)}
              </button>
            ))}
            {recentDirs.filter((path) => !pinnedDirSet.has(normalizeDirectoryPath(path))).slice(0, 2).map((path) => (
              <button key={path} title={path} type="button" onClick={() => useDirectory(path)}>
                {path.split("/").filter(Boolean).at(-1) || path}
              </button>
            ))}
          </div>
          {project ? (
            <div className="projectMeta">
              <span>{project.realpath}</span>
              {project.git?.insideWorkTree ? (
                <span>
                  <GitBranch size={14} />
                  {project.git.branch || "detached"}
                </span>
              ) : null}
            </div>
          ) : null}
          {projectError ? <p className="errorText">{projectError}</p> : null}
            <button className="wideButton" type="button" onClick={() => startThread()} disabled={wsState !== "online" || !cwd.trim()}>
            <SquarePen size={17} />
            {wsState === "online" ? "New session" : "Connecting to Codex"}
          </button>
        </section>

	        <section className="threadHeader">
	          <span>
	            <History size={16} />
	            Sessions
	          </span>
	          <div className="threadHeaderActions">
            <button title="Manage sessions" type="button" onClick={openSessionManager}>
              <ListTree size={16} />
            </button>
            <button title="Refresh sessions" type="button" onClick={() => loadThreads()} disabled={wsState !== "online"}>
              <RefreshCcw size={16} />
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
          {threadLayout === "recent" ? (
            <div className="threadGroupItems">
              {orderedThreads.map((thread) => {
                const kind = threadStatusKind(thread, activeTurnIdsByThread, waitingThreadIds);
                return (
                  <button
                    className={`threadItem statusKind-${kind} ${selectedThread?.id === thread.id ? "selected" : ""}`}
                    key={thread.id}
                    type="button"
                    onClick={() => resumeThread(thread).catch((error) => setNotice(error.message))}
                  >
                    <span>
                      <span className={`threadDot ${kind}`} aria-label={`status ${kind}`} />
                      {thread.name || thread.preview || "Untitled session"}
                    </span>
                    <small>{formatTime(thread.updatedAt)}</small>
                    <small title={thread.cwd}>{directoryLabel(thread.cwd)}</small>
                    <small>{statusLabel(thread.status)}</small>
                  </button>
                );
              })}
            </div>
          ) : threadGroups.map((group) => {
            const collapsed = collapsedThreadGroupSet.has(group.cwd);
            const runningCount = group.threads.reduce(
              (sum, thread) => sum + (threadStatusKind(thread, activeTurnIdsByThread, waitingThreadIds) === "running" ? 1 : 0),
              0
            );
            const waitingCount = group.threads.reduce(
              (sum, thread) => sum + (threadStatusKind(thread, activeTurnIdsByThread, waitingThreadIds) === "waiting" ? 1 : 0),
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
                    <div className="threadGroupPath">{group.cwd}</div>
                    <div className="threadGroupItems">
                      {group.threads.map((thread) => {
                        const kind = threadStatusKind(thread, activeTurnIdsByThread, waitingThreadIds);
                        return (
                          <button
                            className={`threadItem statusKind-${kind} ${selectedThread?.id === thread.id ? "selected" : ""}`}
                            key={thread.id}
                            type="button"
                            onClick={() => resumeThread(thread).catch((error) => setNotice(error.message))}
                          >
                            <span>
                              <span className={`threadDot ${kind}`} aria-label={`status ${kind}`} />
                              {thread.name || thread.preview || "Untitled session"}
                            </span>
                            <small>{formatTime(thread.updatedAt)}</small>
                            <small>{statusLabel(thread.status)}</small>
                          </button>
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

      <section className="workspace">
          <header className="topbar">
            <div className="topbarTitle">
              <strong>{threadTitle(selectedThread)}</strong>
              <span>{selectedThread?.cwd || cwd || "No server directory selected"}</span>
              <div className="topbarMeta">
                {project?.git?.insideWorkTree ? (
                  <span>
                    <GitBranch size={13} />
                    {project.git.branch || "detached"}
                  </span>
                ) : null}
                {sessionModel ? <span>{sessionModel}</span> : null}
                {runtimeSettings.reasoningEffort ? (
                  <span>
                    <Sparkles size={13} />
                    {runtimeSettings.reasoningEffort}
                  </span>
                ) : null}
                <span>{modeLabel(mode)}</span>
                {selectedThread ? <span>{statusLabel(selectedThread.status)}</span> : null}
                {usageLabel ? (
                  <span>
                    <BarChart3 size={13} />
                    {usageLabel}
                  </span>
                ) : null}
              </div>
            </div>
          <div className="topActions">
            <span className={`statusPill ${wsState}`}>{wsState}</span>
            <div className="modeSwitch">
              <button className={mode === "default" ? "active" : ""} type="button" onClick={() => updateRuntimeSettings({ mode: "default" })}>
                Agent
              </button>
              <button className={mode === "plan" ? "active" : ""} type="button" onClick={() => updateRuntimeSettings({ mode: "plan" })}>
                Plan
              </button>
            </div>
            <button title="Logout" type="button" onClick={logout}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="turnList">
          {groupedRounds.length === 0 ? (
            <div className="emptyState">
              <Sparkles size={34} />
              <h2>{selectedThread ? "New session ready" : "Start or resume a Codex session"}</h2>
              <p>
                {selectedThread
                  ? "Send the first task below."
                  : wsState === "online"
                  ? "Pick a server directory, choose Chat or Plan, then send a task."
                  : "Codex is reconnecting. You can browse directories while it connects."}
              </p>
            </div>
          ) : (
            groupedRounds.map((turn, index) => {
              const active = turn.pending || Boolean(activeTurnItemIds && turn.itemIds.some((id) => activeTurnItemIds.has(id)));
              return <TurnPanel active={active} defaultOpen={index === 0} key={turn.id} turn={turn} />;
            })
          )}
        </div>

        {notice ? (
          <div className="notice">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice("")}>
              <X size={15} />
            </button>
          </div>
        ) : null}

        <form className="composer" onSubmit={submitPrompt}>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => {
                const imageFiles = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
                if (!imageFiles.length) return;
                event.preventDefault();
                addImageFiles(imageFiles);
              }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (slashOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((current) => (slashMatches.length ? (current + 1) % slashMatches.length : 0));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((current) =>
                    slashMatches.length ? (current - 1 + slashMatches.length) % slashMatches.length : 0
                  );
                  return;
                }
                if ((event.key === "Tab" || event.key === "Enter") && selectedSlashCommand && !event.shiftKey) {
                  event.preventDefault();
                  setPrompt("");
                  executeSlashCommand(selectedSlashCommand);
                  return;
                }
              }
              if (event.key === "Escape") {
                event.preventDefault();
                if (slashOpen) setPrompt("");
                else if (activeTurnId) interrupt().catch((error) => setNotice(error.message));
                else if (prompt) setPrompt("");
                return;
              }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                if (event.shiftKey && activeTurnId) {
                  submitSteerPrompt();
                  return;
                }
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={activeTurnId ? "Queue the next task or steer the active turn..." : "Send a task to Codex..."}
            rows={3}
          />
            {slashOpen ? (
              <SlashPalette
                commands={slashMatches}
                context={slashContext}
                selectedIndex={selectedSlashIndex}
                onHover={setSlashIndex}
                onSelect={(command) => {
                  setPrompt("");
                  executeSlashCommand(command);
                }}
              />
            ) : null}
            <ShortcutHints
            items={[
              { keys: ["Enter"], label: "newline" },
              { keys: ["Ctrl/Cmd", "Enter"], label: activeTurnId ? "queue" : "send" },
              ...(activeTurnId ? [{ keys: ["Ctrl/Cmd", "Shift", "Enter"], label: "steer" }] : []),
              { keys: ["Esc"], label: activeTurnId ? "stop" : "clear" }
              ]}
            />
            <input
              accept="image/*"
              className="hiddenFileInput"
              multiple
              ref={fileInputRef}
              type="file"
              onChange={(event) => {
                addImageFiles([...(event.currentTarget.files || [])]);
                event.currentTarget.value = "";
              }}
            />
            {attachments.length ? (
              <div className="attachmentTray">
                {attachments.map((attachment) => (
                  <div className="attachmentChip" key={attachment.id}>
                    <img alt="" src={attachment.url} />
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>{formatBytes(attachment.size)}</small>
                    </span>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} title="Remove image">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          {selectedThread && selectedQueuedPrompts.length ? (
            <section className="promptQueue">
              <div className="promptQueueHeader">
                <strong>{selectedQueuedPrompts.length} queued</strong>
                <button type="button" onClick={() => clearQueuedPrompts(selectedThread.id)}>
                  <X size={15} />
                  Clear queue
                </button>
              </div>
              <div className="promptQueueList">
                {selectedQueuedPrompts.map((queuedPrompt, index) => (
                  <div className="queuedPrompt" key={queuedPrompt.id}>
                    <span className="queuePosition">{index + 1}</span>
                    <div className="queuedPromptText">
                      <strong>{compactText(queuedPrompt.text, 140)}</strong>
                      <small>{formatTime(queuedPrompt.createdAt)}</small>
                    </div>
                    <button type="button" onClick={() => removeQueuedPrompt(selectedThread.id, queuedPrompt.id)}>
                      <X size={14} />
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          <div className="composerActions">
              <div className="composerSecondaryActions">
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={17} />
                  Image
                </button>
                <button type="button" onClick={closeThread} disabled={!selectedThread}>
                  <X size={17} />
                Close
              </button>
              <button type="button" onClick={archiveThread} disabled={!selectedThread}>
                <Archive size={17} />
                Archive
              </button>
            </div>
            <div className="composerPrimaryActions">
              {activeTurnId ? (
                <button className="dangerButton" type="button" onClick={interrupt}>
                  <CircleStop size={17} />
                  Stop
                </button>
              ) : null}
              {activeTurnId ? (
                <button type="button" onClick={submitSteerPrompt} disabled={!prompt.trim()}>
                  <ChevronRight size={17} />
                  Steer now
                </button>
              ) : null}
              {mode === "plan" && selectedThread ? (
                <button type="button" onClick={runPlan} disabled={wsState !== "online"}>
                  <Play size={17} />
                  Execute plan
                </button>
              ) : null}
              <button className="primaryButton" type="submit" disabled={wsState !== "online"}>
                <Send size={17} />
                {activeTurnId ? "Queue" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </section>

      <aside className="inspector">
        <section className="panel">
          <h2>
            <ListTree size={17} />
            Active requests
          </h2>
          {pendingRequests.length === 0 ? <p className="muted">No pending approval or question.</p> : null}
            {pendingRequests.map((request) => (
              <button className="requestChip" key={String(request.id)} type="button">
                <MessageSquare size={15} />
                <span>
                  <strong>{approvalTitle(request)}</strong>
                  <small>{compactText(approvalSummary(request), 80)}</small>
                </span>
              </button>
            ))}
        </section>
      </aside>

      {sessionManagerOpen ? renderSessionManager() : null}
      {commandPanel ? renderCommandPanel() : null}
      {activeRequest ? <ServerRequestDialog request={activeRequest} onAnswer={answerServerRequest} /> : null}
      {directoryPickerOpen ? (
        <DirectoryPicker
          initialPath={cwd}
          pinnedDirs={pinnedDirs}
          recentDirs={recentDirs}
          onClose={() => setDirectoryPickerOpen(false)}
          onSelect={useDirectory}
          onTogglePinned={togglePinnedDirectory}
        />
      ) : null}
      <nav className="bottomTabBar" aria-label="Mobile navigation">
        <button
          className={mobilePanel === "project" ? "active" : ""}
          type="button"
          onClick={() => {
            setCommandPanel(null);
            setSessionManagerOpen(false);
            setMobilePanel((current) => (current === "project" ? null : "project"));
          }}
        >
          <FolderOpen size={18} />
          <span>Project</span>
        </button>
        <button
          className={!mobilePanel && !sessionManagerOpen && !commandPanel ? "active" : ""}
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setCommandPanel(null);
            setSessionManagerOpen(false);
          }}
        >
          <MessageSquare size={18} />
          <span>Chat</span>
        </button>
        <button
          className={sessionManagerOpen ? "active" : ""}
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setCommandPanel(null);
            openSessionManager();
          }}
        >
          <History size={18} />
          <span>{threads.length || "Sessions"}</span>
        </button>
        <button
          className={commandPanel ? "active" : ""}
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setSessionManagerOpen(false);
            openCommandPanel("status").catch((error) => setNotice(error.message));
          }}
        >
          <ShieldCheck size={18} />
          <span>Status</span>
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
  onSelect: (path: string) => void;
  onTogglePinned: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pinnedDirSet = useMemo(() => new Set(pinnedDirs.map(normalizeDirectoryPath)), [pinnedDirs]);

  async function load(target: string) {
    setLoading(true);
    setError("");
    try {
      const next = await getJson<ProjectDirectoryListing>(`/api/projects/list?cwd=${encodeURIComponent(target)}`);
      setListing(next);
      setPath(next.realpath);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getJson<{ data: ProjectSuggestion[] }>("/api/projects/suggestions")
      .then((response) => setSuggestions(response.data))
      .catch((suggestionError) =>
        setError(suggestionError instanceof Error ? suggestionError.message : String(suggestionError))
      );
    load(initialPath);
  }, [initialPath]);

  const quickPaths = [
    ...pinnedDirs.map((item) => ({ label: directoryLabel(item), path: item })),
    ...recentDirs.map((item) => ({ label: item.split("/").filter(Boolean).at(-1) || item, path: item })),
    ...suggestions
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index);
  const pathPinned = pinnedDirSet.has(normalizeDirectoryPath(path));

  return (
    <div className="dialogBackdrop">
      <section className="dialog directoryDialog">
        <header>
          <h2>Choose server directory</h2>
          <p>Select a project root on the server. You can still paste an absolute path manually.</p>
        </header>

        <div className="directoryPathBar">
          <input value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} />
          <button type="button" onClick={() => onTogglePinned(path)}>
            {pathPinned ? <PinOff size={17} /> : <Pin size={17} />}
            {pathPinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" onClick={() => load(path)} disabled={loading}>
            <FolderOpen size={17} />
            Open
          </button>
        </div>

        {quickPaths.length ? (
          <div className="quickPathList">
            {quickPaths.slice(0, 18).map((item) => (
              <button type="button" key={item.path} onClick={() => load(item.path)}>
                {pinnedDirSet.has(normalizeDirectoryPath(item.path)) ? <Pin size={15} /> : <HomeIcon size={15} />}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="directoryList">
          {listing?.parent ? (
            <button type="button" className="directoryRow" onClick={() => load(listing.parent!)}>
              <ArrowUp size={17} />
              <span>..</span>
              <small>{listing.parent}</small>
            </button>
          ) : null}
          {listing?.entries.map((entry) => (
            <button type="button" className="directoryRow" key={entry.path} onClick={() => load(entry.path)}>
              <Folder size={17} />
              <span>{entry.name}</span>
              <small>{entry.path}</small>
            </button>
          ))}
          {!loading && listing?.entries.length === 0 ? <p className="muted">No child directories.</p> : null}
          {loading ? <p className="muted">Loading directories...</p> : null}
        </div>

        {error ? <p className="errorText">{error}</p> : null}

        <footer>
          <button type="button" onClick={onClose}>
            <X size={17} />
            Cancel
          </button>
          <button className="primaryButton" type="button" onClick={() => onSelect(path)}>
            <Check size={17} />
            Use this directory
          </button>
        </footer>
      </section>
    </div>
  );
}

function SlashPalette({
  commands,
  context,
  selectedIndex,
  onHover,
  onSelect
}: {
  commands: SlashCommand[];
  context: { hasThread: boolean; activeTurn: boolean };
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}) {
  return (
    <div className="slashPalette" role="listbox" aria-label="Slash commands">
      {commands.length ? (
        commands.map((command, index) => {
          const disabledReason = slashCommandDisabledReason(command, context);
          return (
            <button
              aria-disabled={Boolean(disabledReason)}
              className={`slashCommand ${index === selectedIndex ? "selected" : ""} ${disabledReason ? "disabled" : ""}`}
              key={command.id}
              role="option"
              type="button"
              onClick={() => onSelect(command)}
              onMouseEnter={() => onHover(index)}
            >
              <span>
                <strong>{command.label}</strong>
                {command.aliases?.length ? <code>{command.aliases.map((alias) => `/${alias}`).join(", ")}</code> : null}
              </span>
              <small>{disabledReason || command.description}</small>
            </button>
          );
        })
      ) : (
        <div className="slashEmpty">No matching slash commands.</div>
      )}
    </div>
  );
}

function TurnPanel({
  active,
  defaultOpen,
  turn
}: {
  active: boolean;
  defaultOpen: boolean;
  turn: DisplayTurn;
}) {
  const [open, setOpen] = useState(defaultOpen || active);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const userItem = turn.items.find((item) => item.type === "userMessage");
  const responseItems = turn.items.filter((item) => item.type !== "userMessage").reverse();
  const hasCodexOutput = open && responseItems.length > 0;
  const title = userItem
    ? compactText(itemText(userItem), 120) || "User message"
    : turn.pending
      ? "Sending to Codex"
      : active
        ? "Running turn"
        : "Codex turn";
  const time = turn.completedAt || turn.updatedAt || turn.startedAt || 0;
  const status = turn.pending ? "sending" : active ? "streaming" : statusLabel(turn.status);
  const contentVersion = open && (active || turn.pending) ? turn.items.map(itemVersion).join("|") : "";

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  useEffect(() => {
    if (!open || (!active && !turn.pending)) return;
    bodyRef.current?.scrollTo({ top: 0 });
  }, [active, contentVersion, open, turn.pending]);

  return (
    <details
      className={`turnPanel ${active || turn.pending ? "active" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="turnSummaryMain">
          <strong>{title}</strong>
          {time ? <small>{formatTime(time)}</small> : null}
        </span>
        <span className="turnSummaryMeta">
          <span className={active || turn.pending ? "liveBadge" : ""}>{status}</span>
          <span>{responseItems.length} response items</span>
        </span>
      </summary>
      {open ? (
        <div className="turnBody" ref={bodyRef}>
          {responseItems.map((item) => (
            <MessageItem item={item} key={item.id} streaming={(active || turn.pending) && item.type !== "userMessage"} />
          ))}
          {(active || turn.pending) && !hasCodexOutput ? (
            <div className="streamPlaceholder">
              <span className="pulseDot" />
              {turn.pending ? "Sending to Codex..." : "Codex is working..."}
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function DiffViewer({ diff }: { diff: string }) {
  const sections = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!diff) return <p className="muted">No diff returned.</p>;

  return (
    <div className="diffViewer">
      {sections.map((section, sectionIndex) => (
        <section className="diffFile" key={`${section.file}-${sectionIndex}`}>
          <header>
            <FileText size={14} />
            <strong>{section.file}</strong>
          </header>
          <pre>
            {section.lines.map((line, lineIndex) => (
              <span className={`diffLine diffLine-${line.kind}`} key={`${lineIndex}-${line.text}`}>
                {line.text || " "}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function ProjectDiffPanel({ data }: { data: ProjectDiff | null }) {
  if (!data) return <p className="muted">No diff returned.</p>;
  if (!data.hasChanges) {
    return (
      <div className="diffPanel">
        <div className="diffSummary">
          <strong>No working-tree changes</strong>
          <small>{data.root}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="diffPanel">
      <div className="diffSummary">
        <strong>
          {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
        </strong>
        <small>
          {data.branch || "detached"} · +{data.additions} -{data.deletions}
        </small>
        <small>{data.root}</small>
      </div>
      <div className="diffFileChips">
        {data.files.map((file) => (
          <span key={file.path} title={file.path}>
            <FileText size={13} />
            {file.path}
            <code>{file.status}</code>
            {file.binary ? <code>binary</code> : null}
            {file.tooLarge ? <code>large</code> : null}
            {!file.binary && !file.tooLarge ? <small>+{file.additions} -{file.deletions}</small> : null}
          </span>
        ))}
      </div>
      <DiffViewer diff={data.diff} />
      <details>
        <summary>Raw git status</summary>
        <pre className="diffRaw">{data.status || "clean"}</pre>
      </details>
    </div>
  );
}

const MessageItem = memo(function MessageItem({ item, streaming = false }: { item: ThreadItem; streaming?: boolean }) {
  const text = itemText(item);
  const [expanded, setExpanded] = useState(false);
  const label =
    item.type === "userMessage"
      ? "You"
      : item.type === "agentMessage"
        ? "Codex"
        : item.type === "commandExecution"
          ? "Command"
          : item.type === "fileChange"
            ? "File change"
            : item.type === "diff"
                ? "Diff"
                : item.type;
  const output = text || (streaming ? "Waiting for output" : "...");
  const isLong = output.length > 800;
  const preClass = expanded ? "expandedPre" : "";

  async function copy(value: string) {
    await navigator.clipboard?.writeText(value).catch(() => undefined);
  }

  if (item.type === "userMessage") {
    const parts = userMessageParts(item);
    return (
      <article className="message userMessage">
        <header>
          <span>You</span>
          {parts.images.length ? <code>{parts.images.length} image{parts.images.length === 1 ? "" : "s"}</code> : null}
        </header>
        {parts.text ? <pre>{parts.text}</pre> : null}
        {parts.images.length ? (
          <div className="messageImages">
            {parts.images.map((url, index) => (
              <img alt={`Attachment ${index + 1}`} key={`${url}-${index}`} src={url} />
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  if (item.type === "plan" && item.planEntries?.length) {
    return (
      <article className={`message plan ${streaming ? "streamingMessage" : ""}`}>
        <header>
          <span>Plan</span>
          {streaming ? (
            <span className="messageLive">
              <span className="pulseDot" />
              Streaming
            </span>
          ) : null}
        </header>
        {item.explanation ? <p className="planExplanation">{item.explanation}</p> : null}
        <ol className="planList">
          {item.planEntries.map((entry, index) => (
            <li className={`planStep ${entry.status}`} key={`${entry.step}-${index}`}>
              <span>{entry.status}</span>
              <p>{entry.step}</p>
            </li>
          ))}
        </ol>
      </article>
    );
  }

  if (item.type === "commandExecution") {
    return (
      <article className={`message commandExecution ${streaming ? "streamingMessage" : ""}`}>
        <header>
          <span>
            <Terminal size={14} />
            Command
          </span>
          {typeof item.exitCode === "number" ? (
            <code className={item.exitCode === 0 ? "exitOk" : "exitError"}>exit {item.exitCode}</code>
          ) : null}
          {streaming ? (
            <span className="messageLive">
              <span className="pulseDot" />
              Streaming
            </span>
          ) : null}
          {item.command ? <code>{item.command}</code> : null}
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy size={14} />
            Copy
          </button>
        </header>
        <pre className={preClass}>
          {output}
          {streaming ? <span className="streamCursor" /> : null}
        </pre>
        {isLong ? (
          <button className="textButton" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </article>
    );
  }

  if (item.type === "fileChange" || item.type === "diff") {
    const projectDiff = item.type === "diff" && item.projectDiff && typeof item.projectDiff === "object" ? (item.projectDiff as ProjectDiff) : null;
    const files = projectDiff?.files?.length
      ? projectDiff.files.map((file) => file.path)
      : item.type === "diff"
        ? diffFiles(output)
        : changedFiles(item).map((change) => change.path);
    return (
      <article className={`message ${item.type} ${streaming ? "streamingMessage" : ""}`}>
        <header>
          <span>
            <FileDiff size={14} />
            {item.type === "diff" ? String(item.title || "Code changes") : "File change"}
          </span>
          <code>{files.length} file{files.length === 1 ? "" : "s"}</code>
          {projectDiff ? <code>+{projectDiff.additions} -{projectDiff.deletions}</code> : null}
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy size={14} />
            Copy
          </button>
        </header>
        {files.length ? (
          <div className="fileList">
            {files.slice(0, 8).map((file) => (
              <span key={file}>
                <FileText size={13} />
                {file}
              </span>
            ))}
            {files.length > 8 ? <small>+{files.length - 8} more</small> : null}
          </div>
        ) : null}
        {projectDiff ? <ProjectDiffPanel data={projectDiff} /> : item.type === "diff" ? <DiffViewer diff={output} /> : <pre className={preClass}>{output}</pre>}
        {isLong && item.type !== "diff" ? (
          <button className="textButton" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </article>
    );
  }

  const renderMarkdown = item.type === "agentMessage" || item.type === "plan";

  return (
    <article className={`message ${item.type} ${streaming ? "streamingMessage" : ""}`}>
      <header>
        <span>{label}</span>
        {streaming ? (
          <span className="messageLive">
            <span className="pulseDot" />
            Streaming
          </span>
        ) : null}
        {item.command ? <code>{item.command}</code> : null}
        {renderMarkdown ? (
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy size={14} />
            Copy
          </button>
        ) : null}
      </header>
      {renderMarkdown ? (
        <MarkdownBody expanded={expanded} streaming={streaming} text={output} />
      ) : (
        <pre className={`agentPre ${preClass}`}>
          {output}
          {streaming ? <span className="streamCursor" /> : null}
        </pre>
      )}
      {isLong ? (
        <button className="textButton" type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      ) : null}
    </article>
  );
});

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
      <section className={`dialog approvalDialog ${kind}`} onKeyDown={handleKeyDown} ref={dialogRef} tabIndex={-1}>
        <header>
          <h2>{approvalTitle(request)}</h2>
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
                <Terminal size={15} />
                Command
              </h3>
              <pre>{command}</pre>
            </section>
          ) : null}
          {files.length ? (
            <section className="approvalPreview">
              <h3>
                <FileDiff size={15} />
                Files
              </h3>
              <div className="fileList">
                {files.map((file) => (
                  <span key={file}>
                    <FileText size={13} />
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
            <X size={17} />
            Decline
          </button>
          {canApproveForSession ? (
            <button type="button" onClick={() => onAnswer(request, approveForSessionResult)}>
              <Check size={17} />
              Approve session
            </button>
          ) : null}
          <button className="primaryButton" type="button" onClick={() => onAnswer(request, approveResult)}>
            <Check size={17} />
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

  useEffect(() => {
    dialogRef.current?.focus();
  }, [request.id]);

  function toggle(questionId: string, label: string) {
    setAnswers((current) => {
      const selected = current[questionId] || [];
      return {
        ...current,
        [questionId]: selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label]
      };
    });
  }

  function optionShortcut(questionId: string, label: string) {
    return optionShortcuts.find((shortcut) => shortcut.questionId === questionId && shortcut.label === label)?.key;
  }

  function submit() {
    const result: Record<string, { answers: string[] }> = {};
    for (const question of params.questions) {
      const selected = [...(answers[question.id] || [])];
      const typed = freeText[question.id]?.trim();
      if (typed) selected.push(typed);
      result[question.id] = { answers: selected };
    }
    onAnswer(request, { answers: result });
  }

  function cancel() {
    onAnswer(request, { answers: {} });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;

    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }

    if (/^[1-9]$/.test(event.key) && !isTextEditingTarget(event.target)) {
      const shortcut = optionShortcuts.find((item) => item.key === event.key);
      if (!shortcut) return;
      event.preventDefault();
      toggle(shortcut.questionId, shortcut.label);
    }
  }

  return (
    <div className="dialogBackdrop">
      <section className="dialog" onKeyDown={handleKeyDown} ref={dialogRef} tabIndex={-1}>
        <header>
          <h2>Codex needs input</h2>
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
                          type="checkbox"
                          checked={(answers[question.id] || []).includes(option.label)}
                          onChange={() => toggle(question.id, option.label)}
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
                  className="freeInput"
                  type={question.isSecret ? "password" : "text"}
                  value={freeText[question.id] || ""}
                  onChange={(event) => setFreeText((current) => ({ ...current, [question.id]: event.target.value }))}
                  placeholder={question.isOther ? "Other answer" : "Answer"}
                />
              ) : null}
            </section>
          ))}
        </div>

        <footer>
          <button type="button" onClick={cancel}>
            <X size={17} />
            Cancel
          </button>
          <button className="primaryButton" type="button" onClick={submit}>
            <Play size={17} />
            Confirm
          </button>
        </footer>
      </section>
    </div>
  );
}
