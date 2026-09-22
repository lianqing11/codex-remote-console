import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentModelSummary,
  AgentNormalizedEvent,
  AgentProviderSnapshot,
  AgentRunStatus,
  AgentSessionSummary
} from "../types";
import { parseCursorUsage, type CursorUsageSnapshot } from "../../app/cursorUsage";
import { fetchCursorUsage } from "../cursorUsage";
import { resolveProject } from "../project";
import { epochSeconds } from "../../app/threadModel";
import { childProcessEnv } from "../codex/stdioSupport";
import {
  buildSessionTitlePrompt,
  extractTitleSource,
  fallbackSessionTitle,
  isUntitledSessionTitle,
  sanitizeSessionTitle,
  sessionTitleTimeoutMs
} from "../sessionTitle";

type CursorStatus = AgentRunStatus | "idle";
type CursorExecutionMode = "agent" | "plan" | "ask";

type CursorTranscriptItem =
  | { event: "user_text"; text: string; mode: "agent" | "plan" | "ask"; runId: string; at: number }
  | { event: "assistant_text"; text: string; runId: string; at: number }
  | { event: "tool_started" | "tool_completed" | "tool_failed"; toolName?: string; toolCallId?: string; summary?: string; runId: string; at: number }
  | { event: "result"; text?: string; durationMs?: number; runId: string; at: number }
  | { event: "status"; status?: CursorStatus; message?: string; runId: string; at: number }
  | { event: "error"; message: string; runId: string; at: number };

type CursorSessionRecord = {
  provider: "cursor";
  sessionId: string;
  nativeSessionId: string;
  cwd: string;
  title: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  mode: CursorExecutionMode;
  status: CursorStatus;
  lastError?: string;
  transcript: CursorTranscriptItem[];
};

type CursorIndex = {
  sessions: Array<{
    sessionId: string;
    nativeSessionId: string;
    cwd: string;
    title: string;
    archived: boolean;
    createdAt: number;
    updatedAt: number;
    model: string | null;
    mode?: CursorExecutionMode;
    status: CursorStatus;
    lastError?: string;
  }>;
};

type CursorRun = {
  runId: string;
  child: ChildProcess;
  sessionId: string;
  resultSeen: boolean;
  cancellationRequested: boolean;
  finalized: boolean;
  stderr: string;
  stopTimers: NodeJS.Timeout[];
  done: Promise<void>;
  resolveDone: () => void;
};

type CursorRequestHandler = (event: AgentNormalizedEvent) => void;

const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const maxStderrChars = 12_000;
const modelCacheMs = 10 * 60_000;
const modelListFailureCacheMs = 20_000;
const cliTimeoutMs = 5_000;
const defaultCreateChatTimeoutMs = 30_000;
const defaultListModelsTimeoutMs = 20_000;
const defaultVersionTimeoutMs = 15_000;
const nestedCursorEnvKeys = [
  "CURSOR_AGENT",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_INVOKED_AS",
  "CURSOR_REQUEST_ID",
  "CURSOR_LAYOUT",
  "CURSOR_AGENT_STORE_FILES_DIR",
  "CURSOR_AGENT_STORE_SHARED_PATHS",
  "__CURSOR_SANDBOX_ENV_RESTORE"
] as const;

function now() {
  return Math.floor(Date.now() / 1000);
}

export function stripAnsiAndControls(value: string) {
  return value.replace(ansiPattern, "").replace(controlPattern, "");
}

function truncate(value: string, limit = 2_000) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function safeSummary(value: unknown) {
  if (typeof value === "string") return truncate(stripAnsiAndControls(value));
  return truncate(stripAnsiAndControls(JSON.stringify(value)));
}

function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stateRoot() {
  const configured = process.env.CODING_AGENT_CONSOLE_STATE_DIR;
  return configured ? path.join(configured, "cursor") : path.join(homedir(), ".local", "share", "coding-agent-console", "cursor");
}

async function ensurePrivateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

async function writePrivateFileAtomic(filePath: string, content: string) {
  await ensurePrivateDir(path.dirname(filePath));
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

function sessionToIndex(session: CursorSessionRecord): CursorIndex["sessions"][number] {
  return {
    sessionId: session.sessionId,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd,
    title: session.title,
    archived: session.archived,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    mode: session.mode,
    status: session.status,
    lastError: session.lastError
  };
}

function publicSession(session: CursorSessionRecord): AgentSessionSummary {
  const previewItem = [...session.transcript].reverse().find((item) => item.event === "assistant_text" || item.event === "user_text");
  return {
    provider: "cursor",
    id: session.sessionId,
    key: `cursor:${session.nativeSessionId}`,
    sessionId: session.sessionId,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd,
    name: session.title,
    title: session.title,
    preview: previewItem && "text" in previewItem ? previewItem.text : "",
    empty: session.transcript.length === 0,
    archived: session.archived,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    mode: session.mode,
    status: session.status,
    turns: new Set(session.transcript.map((item) => item.runId)).size,
    lastError: session.lastError
  };
}

function asThread(session: CursorSessionRecord) {
  return {
    id: session.sessionId,
    provider: "cursor",
    title: session.title,
    empty: session.transcript.length === 0,
    cwd: session.cwd,
    archived: session.archived,
    updatedAt: session.updatedAt,
    model: session.model,
    mode: session.mode,
    status: session.status,
    nativeSessionId: session.nativeSessionId
  };
}

const endedSessionStatuses = new Set(["completed", "failed", "failed-after-restart", "cancelled"]);

function lastTranscriptRunId(transcript: CursorTranscriptItem[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const runId = transcript[index]?.runId;
    if (runId) return runId;
  }
  return "";
}

function appendTerminalStatus(session: CursorSessionRecord, status: AgentRunStatus, message?: string) {
  const runId = lastTranscriptRunId(session.transcript);
  if (!runId) return;
  const last = session.transcript.at(-1);
  if (last?.event === "status" && last.status === status) return;
  session.transcript.push({ event: "status", status, message, runId, at: now() });
}

function sessionTurns(session: CursorSessionRecord) {
  const turns = new Map<string, { id: string; userMessage: string; agentMessage: string; toolCall: Array<{ id?: string; name?: string; status: string; summary?: string }>; status: CursorStatus }>();
  for (const item of session.transcript) {
    const turn = turns.get(item.runId) || { id: item.runId, userMessage: "", agentMessage: "", toolCall: [], status: "running" as CursorStatus };
    if (item.event === "user_text") turn.userMessage = item.text;
    if (item.event === "assistant_text") turn.agentMessage += item.text;
    if (item.event === "tool_started" || item.event === "tool_completed" || item.event === "tool_failed") {
      turn.toolCall.push({ id: item.toolCallId, name: item.toolName, status: item.event.replace("tool_", ""), summary: item.summary });
    }
    if (item.event === "status" && item.status) turn.status = item.status;
    turns.set(item.runId, turn);
  }
  const list = [...turns.values()];
  if (endedSessionStatuses.has(session.status)) {
    for (const turn of list) {
      if (turn.status === "running" || turn.status === "idle") turn.status = session.status;
    }
  }
  return list;
}

export function parseCursorModels(stdout: string): AgentModelSummary[] {
  const clean = stripAnsiAndControls(stdout);
  const models: AgentModelSummary[] = [];
  const seen = new Set<string>();
  const skip = /^(loading|available|tip|models?|[-=]+)\b/i;

  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || skip.test(trimmed)) continue;

    const json = tryParseJson(trimmed);
    if (json && typeof json === "object") {
      const rows = Array.isArray(json) ? json : "models" in json && Array.isArray(json.models) ? json.models : [json];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const source = row as Record<string, unknown>;
        const id = typeof source.id === "string" ? source.id : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : id });
      }
      continue;
    }

    const bulletless = trimmed.replace(/^[-*]\s*/, "");
    const dash = bulletless.match(/^([A-Za-z0-9._:/+-]+)\s+-\s+(.+)$/);
    const whitespace = bulletless.match(/^([A-Za-z0-9._:/+-]+)(?:\s{2,}|\t+)(.+)$/);
    const bare = bulletless.match(/^([A-Za-z0-9._:/+-]+)$/);
    const match = dash || whitespace || bare;
    if (!match) continue;

    const id = match[1];
    if (!id || seen.has(id) || skip.test(id)) continue;
    seen.add(id);
    models.push({ id, name: (match[2] || id).trim() });
  }

  return models.length ? models : [{ id: "auto", name: "Auto" }];
}

function nestedText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nestedText).join("");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) return nestedText(item.content);
    if (item.message) return nestedText(item.message);
    if (item.delta) return nestedText(item.delta);
  }
  return "";
}

function cursorToolInfo(item: Record<string, unknown>) {
  const call = item.tool_call && typeof item.tool_call === "object" ? (item.tool_call as Record<string, unknown>) : null;
  const nestedToolKey = call
    ? Object.keys(call).find((key) => key.endsWith("ToolCall") && call[key] && typeof call[key] === "object")
    : null;
  const nested = nestedToolKey && call ? (call[nestedToolKey] as Record<string, unknown>) : null;
  const rawName = String(item.name || item.tool || item.toolName || nestedToolKey || "");
  const toolName = rawName.endsWith("ToolCall")
    ? rawName.slice(0, -"ToolCall".length).replace(/^\w/, (letter) => letter.toUpperCase())
    : rawName;
  const toolCallId =
    item.call_id === undefined
      ? item.id === undefined
        ? call?.toolCallId === undefined
          ? nested?.toolCallId === undefined
            ? undefined
            : String(nested.toolCallId)
          : String(call.toolCallId)
        : String(item.id)
      : String(item.call_id);
  return { call, nested, toolName, toolCallId };
}

function summarizeToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(summarizeToolPayload);

  const source = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (/^(content|text|data|raw|blob|output)$/i.test(key)) {
      summary[`${key}Bytes`] = typeof child === "string" ? Buffer.byteLength(child) : Array.isArray(child) ? child.length : child ? JSON.stringify(child).length : 0;
      continue;
    }
    if (/^(file|files|path|paths|success|error|bytes|size|duration|duration_ms|durationMs|exitCode|status)$/i.test(key)) {
      summary[key] = summarizeToolPayload(child);
    }
  }
  return Object.keys(summary).length ? summary : safeSummary(value);
}

export function normalizeCursorStreamItem(raw: unknown, seenAssistantText: { value: string }, runId: string): CursorTranscriptItem[] {
  const at = now();
  if (!raw || typeof raw !== "object") return [{ event: "status", message: safeSummary(raw), runId, at }];

  const item = raw as Record<string, unknown>;
  const kind = String(item.type || item.event || item.kind || "");
  const subtype = String(item.subtype || item.status || item.phase || "");

  if (kind === "system" || kind === "init") {
    return [{ event: "status", status: "running", message: safeSummary(item.message || item.subtype || kind), runId, at }];
  }

  if (kind === "thinking" || kind === "user") return [];

  if (kind === "assistant" || kind === "assistant_message") {
    const text = stripAnsiAndControls(nestedText(item.text || item.message || item.content || item.delta));
    if (!text) return [];
    if (seenAssistantText.value.endsWith(text)) return [];
    const delta = text.startsWith(seenAssistantText.value) ? text.slice(seenAssistantText.value.length) : text;
    if (!delta) return [];
    seenAssistantText.value = text.startsWith(seenAssistantText.value) ? text : seenAssistantText.value + delta;
    return [{ event: "assistant_text", text: delta, runId, at }];
  }

  if (kind === "tool_call") {
    const { call, nested, toolName, toolCallId } = cursorToolInfo(item);
    const summary = safeSummary(summarizeToolPayload(item.summary || nested?.result || nested?.error || item.output || item.error || call || item));
    if (subtype === "completed" || subtype === "complete" || subtype === "success") {
      return [{ event: "tool_completed", toolName, toolCallId, summary, runId, at }];
    }
    if (subtype === "failed" || subtype === "error") {
      return [{ event: "tool_failed", toolName, toolCallId, summary, runId, at }];
    }
    return [{ event: "tool_started", toolName, toolCallId, summary, runId, at }];
  }

  if (kind === "tool_result" || kind === "tool_completed") {
    return [{
      event: "tool_completed",
      toolName: String(item.name || item.tool || item.toolName || ""),
      toolCallId: item.id === undefined ? undefined : String(item.id),
      summary: safeSummary(summarizeToolPayload(item.output || item.result || item)),
      runId,
      at
    }];
  }

  if (kind === "tool_failed") {
    return [{
      event: "tool_failed",
      toolName: String(item.name || item.tool || item.toolName || ""),
      toolCallId: item.id === undefined ? undefined : String(item.id),
      summary: safeSummary(summarizeToolPayload(item.error || item)),
      runId,
      at
    }];
  }

  if (kind === "result") {
    return [{
      event: "result",
      text: stripAnsiAndControls(String(item.text || item.final_text || item.response || item.result || "")) || undefined,
      durationMs: typeof item.duration_ms === "number" ? item.duration_ms : typeof item.durationMs === "number" ? item.durationMs : undefined,
      runId,
      at
    }];
  }

  if (kind === "error") return [{ event: "error", message: safeSummary(item.message || item.error || item), runId, at }];

  return [{ event: "status", status: "running", message: safeSummary(item), runId, at }];
}

function transcriptToEvent(provider: "cursor", sessionId: string, runId: string, item: CursorTranscriptItem): AgentNormalizedEvent {
  if (item.event === "assistant_text") return { type: "agent:event", provider, sessionId, runId, event: "assistant_text", text: item.text, delta: true };
  if (item.event === "tool_started" || item.event === "tool_completed" || item.event === "tool_failed") {
    return { type: "agent:event", provider, sessionId, runId, event: item.event, toolName: item.toolName, toolCallId: item.toolCallId, summary: item.summary };
  }
  if (item.event === "result") return { type: "agent:event", provider, sessionId, runId, event: "result", result: { text: item.text, durationMs: item.durationMs } };
  if (item.event === "error") return { type: "agent:event", provider, sessionId, runId, event: "error", message: item.message };
  if (item.event === "status") return { type: "agent:event", provider, sessionId, runId, event: "status", status: item.status || "running", message: item.message };
  return { type: "agent:event", provider, sessionId, runId, event: "status", status: "running" };
}

function cursorEnvironment() {
  const environment = childProcessEnv(process.env);
  for (const key of nestedCursorEnvKeys) delete environment[key];
  return environment;
}

function stringParam(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modeParam(input: Record<string, unknown>): CursorExecutionMode {
  return input.mode === "plan" || input.mode === "ask" ? input.mode : "agent";
}

const imageMimeToExt: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif"
};
const maxCursorImageBytes = 8 * 1024 * 1024;
const maxCursorImages = 8;

function recordItems(input: Record<string, unknown>) {
  return Array.isArray(input.input)
    ? input.input.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function promptText(input: Record<string, unknown>) {
  const direct = stringParam(input, "prompt") || stringParam(input, "message");
  if (direct) return direct;
  const texts = recordItems(input)
    .filter((item) => item.type === "text")
    .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean);
  return texts.join("\n") || null;
}

function imageAttachments(input: Record<string, unknown>) {
  return recordItems(input).filter((item) => item.type === "image" && typeof item.url === "string");
}

function localFileAttachments(input: Record<string, unknown>) {
  return recordItems(input)
    .filter((item) => (item.type === "localImage" || item.type === "mention") && typeof item.path === "string")
    .map((item) => String(item.path).trim())
    .filter(Boolean);
}

function decodeDataImage(url: string) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim());
  if (!match) throw new Error("Cursor image attachments must be data URLs.");
  const mime = match[1].toLowerCase();
  const ext = imageMimeToExt[mime];
  if (!ext) throw new Error(`Unsupported Cursor image type: ${mime}`);
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("Cursor image attachment is empty.");
  if (buffer.length > maxCursorImageBytes) throw new Error("Cursor image attachments must be 8MB or smaller.");
  return { ext, buffer };
}

function safeImageName(name: unknown, ext: string, index: number) {
  const raw = typeof name === "string" ? path.basename(name) : "";
  const stem = raw.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "").slice(0, 40);
  return `${stem || `image-${index + 1}`}-${randomUUID().slice(0, 8)}${ext}`;
}

function createChatTimeoutMs() {
  const configured = Number(process.env.CODEX_WEB_CURSOR_CREATE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return defaultCreateChatTimeoutMs;
  return Math.min(120_000, Math.max(50, Math.round(configured)));
}

function listModelsTimeoutMs() {
  const configured = Number(process.env.CODEX_WEB_CURSOR_LIST_MODELS_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return defaultListModelsTimeoutMs;
  return Math.min(120_000, Math.max(50, Math.round(configured)));
}

function versionTimeoutMs() {
  const configured = Number(process.env.CODEX_WEB_CURSOR_VERSION_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return defaultVersionTimeoutMs;
  return Math.min(120_000, Math.max(50, Math.round(configured)));
}

async function execCursor(args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const timeout = options.timeout || cliTimeoutMs;
    const child = execFile(
      "cursor-agent",
      args,
      { cwd: options.cwd, timeout, env: cursorEnvironment() },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stripAnsiAndControls(stderr || "").trim();
          const command = `cursor-agent ${args[0] || "command"}`;
          const message = detail || (error.killed
            ? `${command} timed out after ${timeout}ms.`
            : stripAnsiAndControls(error.message));
          reject(new Error(message));
        }
        else resolve({ stdout, stderr });
      }
    );
    child.on("error", (error) => reject(error));
  });
}

export class CursorProvider {
  readonly provider = "cursor" as const;
  private root = stateRoot();
  private indexPath = path.join(this.root, "index.json");
  private sessionsDir = path.join(this.root, "sessions");
  private sessions = new Map<string, CursorSessionRecord>();
  private activeRuns = new Map<string, CursorRun>();
  private sessionWriteQueues = new Map<string, Promise<void>>();
  private subscribers = new Set<CursorRequestHandler>();
  private modelsCache: { expiresAt: number; value: AgentModelSummary[]; diagnostic: string | null } | null = null;
  private lastGoodModels: AgentModelSummary[] | null = null;
  private modelsRefresh: Promise<AgentModelSummary[]> | null = null;
  private versionCache: { expiresAt: number; value: string; diagnostic: string | null } | null = null;
  private lastUsage: CursorUsageSnapshot | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.load();
  }

  subscribe(callback: CursorRequestHandler) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async getSnapshot(): Promise<AgentProviderSnapshot> {
    await this.ready;
    const [models, version] = await Promise.all([this.listModels(), this.version()]);
    const diagnostics = {
      models: this.modelsCache?.diagnostic || null,
      version: this.versionCache?.diagnostic || null
    };
    const degraded = Boolean(diagnostics.models || diagnostics.version);
    return {
      provider: "cursor",
      available: !(diagnostics.version && diagnostics.models),
      authenticated: !diagnostics.models,
      version,
      status: degraded ? "degraded" : "ready",
      diagnostic: diagnostics.models || diagnostics.version,
      diagnostics,
      capabilities: {
        models: true,
        planMode: true,
        askMode: true,
        approvals: false,
        steering: false,
        images: true,
        fork: false,
        compact: false,
        plugins: false,
        skills: false,
        mcpStatus: false,
        memory: false,
        serviceTier: false,
        reasoningEffort: false,
        rename: true,
        archive: true,
        diff: true,
        sessions: true,
        threads: true,
        turnStart: true,
        turnInterrupt: true,
        agentMode: true,
        unarchive: true,
        steer: false,
        mcp: false
      },
      sessions: this.visibleSessions(),
      models,
      rateLimit: this.lastUsage
    };
  }

  async handle(method: string, params: unknown) {
    await this.ready;
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};

    if (method === "session/list" || method === "thread/list") return { data: this.visibleSessions(), threads: this.visibleThreads() };
    if (method === "session/create" || method === "thread/start") return this.createSession(input);
    if (method === "session/read" || method === "thread/read") return this.readSession(input);
    if (method === "session/rename" || method === "thread/name" || method === "thread/setName") return this.renameSession(input);
    if (method === "session/suggest-title" || method === "thread/title/suggest") return this.suggestTitle(input);
    if (method === "session/archive" || method === "thread/archive") return this.archiveSession(input, true);
    if (method === "session/unarchive" || method === "thread/unarchive") return this.archiveSession(input, false);
    if (method === "model/list") return { data: await this.listModels() };
    if (method === "account/usage/read" || method === "account/rateLimits/read") return this.readUsage();
    if (method === "run/start" || method === "turn/start") return this.startRun(input);
    if (method === "run/stop" || method === "turn/interrupt") return this.stopRun(input);
    throw new Error(`Unsupported Cursor method: ${method}`);
  }

  stop() {
    for (const run of this.activeRuns.values()) this.forceStop(run);
  }

  private refreshModels() {
    if (this.modelsRefresh) return this.modelsRefresh;

    const refresh = (async () => {
      try {
        const result = await execCursor(["--list-models"], { timeout: listModelsTimeoutMs() });
        const models = parseCursorModels(result.stdout);
        this.lastGoodModels = models;
        this.modelsCache = { expiresAt: Date.now() + modelCacheMs, value: models, diagnostic: null };
        return models;
      } catch (error) {
        const fallback = this.lastGoodModels || [{ id: "auto", name: "Auto" }];
        this.modelsCache = {
          expiresAt: Date.now() + modelListFailureCacheMs,
          value: fallback,
          diagnostic: `cursor-agent model list unavailable: ${error instanceof Error ? error.message : String(error)}`
        };
        return fallback;
      }
    })();
    this.modelsRefresh = refresh;
    void refresh.finally(() => {
      if (this.modelsRefresh === refresh) this.modelsRefresh = null;
    });
    return refresh;
  }

  async listModels(options: { allowStale?: boolean } = {}) {
    const cached = this.modelsCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached && options.allowStale) {
      void this.refreshModels();
      return cached.value;
    }
    return this.refreshModels();
  }

  private async version() {
    const cached = this.versionCache;
    if (cached && (cached.expiresAt > Date.now() || !cached.diagnostic)) return cached.value;
    try {
      const result = await execCursor(["--version"], { timeout: versionTimeoutMs() });
      const version = stripAnsiAndControls(result.stdout).trim() || "unknown";
      this.versionCache = { expiresAt: Number.POSITIVE_INFINITY, value: version, diagnostic: null };
      return version;
    } catch (error) {
      this.versionCache = {
        expiresAt: Date.now() + modelListFailureCacheMs,
        value: "unavailable",
        diagnostic: `cursor-agent version unavailable: ${error instanceof Error ? error.message : String(error)}`
      };
      return "unavailable";
    }
  }

  private async load() {
    await ensurePrivateDir(this.root);
    await ensurePrivateDir(this.sessionsDir);
    const text = await readFile(this.indexPath, "utf8").catch(() => "");
    const index = text ? (JSON.parse(text) as CursorIndex) : { sessions: [] };

    let changed = false;
    for (const entry of index.sessions || []) {
      const sessionPath = this.sessionFile(entry.nativeSessionId);
      const stored: Partial<CursorSessionRecord> = await readFile(sessionPath, "utf8")
        .then((value) => JSON.parse(value) as Partial<CursorSessionRecord>)
        .catch(() => ({}));
      const status = entry.status === "running" ? "failed-after-restart" : entry.status;
      const createdAt = epochSeconds(entry.createdAt);
      const updatedAt = epochSeconds(entry.updatedAt);
      const transcript = Array.isArray(stored.transcript) ? stored.transcript : [];
      const session: CursorSessionRecord = {
        provider: "cursor",
        ...entry,
        createdAt,
        updatedAt,
        mode: entry.mode || stored.mode || "agent",
        status,
        lastError: status === "failed-after-restart" ? "Run was marked failed after server restart." : entry.lastError,
        transcript
      };
      if (status === "failed-after-restart") {
        const before = session.transcript.length;
        appendTerminalStatus(session, "failed-after-restart", session.lastError);
        changed ||= session.transcript.length !== before;
      }
      changed ||= status !== entry.status || createdAt !== entry.createdAt || updatedAt !== entry.updatedAt;
      this.sessions.set(session.sessionId, session);
    }
    if (changed) await this.saveAll();
    const usageRaw = await readFile(path.join(this.root, "usage.json"), "utf8").catch(() => "");
    if (usageRaw) this.lastUsage = parseCursorUsage(JSON.parse(usageRaw));
  }

  private async readUsage() {
    const env = cursorEnvironment();
    const usage = await fetchCursorUsage({
      env,
      proxyUrl: env.HTTPS_PROXY || env.https_proxy || null
    });
    this.lastUsage = usage;
    await writePrivateFileAtomic(path.join(this.root, "usage.json"), JSON.stringify(usage));
    return usage;
  }

  private sessionFile(nativeSessionId: string) {
    return path.join(this.sessionsDir, `${nativeSessionId}.json`);
  }

  private async saveIndex() {
    const index: CursorIndex = { sessions: [...this.sessions.values()].map(sessionToIndex) };
    await writePrivateFileAtomic(this.indexPath, JSON.stringify(index, null, 2));
  }

  private async saveSession(session: CursorSessionRecord) {
    const key = session.nativeSessionId;
    const previous = this.sessionWriteQueues.get(key) || Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(() => writePrivateFileAtomic(
        this.sessionFile(key),
        JSON.stringify({ session: publicSession(session), transcript: session.transcript }, null, 2)
      ));
    this.sessionWriteQueues.set(key, queued);
    await queued.finally(() => {
      if (this.sessionWriteQueues.get(key) === queued) this.sessionWriteQueues.delete(key);
    });
  }

  private async saveAll() {
    await this.saveIndex();
    await Promise.all([...this.sessions.values()].map((session) => this.saveSession(session)));
  }

  private visibleSessions() {
    return [...this.sessions.values()]
      .filter((session) => !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(publicSession);
  }

  private visibleThreads() {
    return [...this.sessions.values()]
      .filter((session) => !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(asThread);
  }

  private sessionOrThrow(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Cursor session was not created by this console.");
    return session;
  }

  private async createNativeChat(cwd: string) {
    const result = await execCursor(["create-chat", "--workspace", cwd], {
      cwd,
      timeout: createChatTimeoutMs()
    });
    const clean = stripAnsiAndControls(result.stdout).trim();
    const json = tryParseJson(clean);
    const id = json && typeof json === "object" && "id" in json ? String(json.id || "") : clean.split(/\s+/).find(Boolean) || "";
    if (!id) throw new Error("cursor-agent create-chat did not return a chat id.");
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new Error("cursor-agent create-chat returned an unsafe chat id.");
    return id;
  }

  private async createSession(input: Record<string, unknown>) {
    const cwd = stringParam(input, "cwd") || process.cwd();
    const project = await resolveProject(cwd);
    if (!project.readable || !project.writable) throw new Error("Cursor session cwd must be an existing readable and writable directory.");
    const nativeSessionId = await this.createNativeChat(project.realpath);
    const createdAt = now();
    const session: CursorSessionRecord = {
      provider: "cursor",
      sessionId: nativeSessionId,
      nativeSessionId,
      cwd: project.realpath,
      title: stringParam(input, "title") || "",
      archived: false,
      createdAt,
      updatedAt: createdAt,
      model: stringParam(input, "model") || null,
      mode: modeParam(input),
      status: "idle",
      transcript: []
    };
    this.sessions.set(session.sessionId, session);
    await this.saveIndex();
    await this.saveSession(session);
    return { session: publicSession(session), thread: asThread(session) };
  }

  private async readSession(input: Record<string, unknown>) {
    const session = this.sessionOrThrow(String(input.sessionId || input.threadId || ""));
    return {
      session: publicSession(session),
      thread: asThread(session),
      transcript: session.transcript,
      items: session.transcript,
      turns: sessionTurns(session),
      incomplete: this.activeRuns.has(session.sessionId)
    };
  }

  private async renameSession(input: Record<string, unknown>) {
    const session = this.sessionOrThrow(String(input.sessionId || input.threadId || ""));
    const title = stringParam(input, "title") || stringParam(input, "name");
    if (!title) throw new Error("A non-empty title is required.");
    session.title = title;
    session.updatedAt = now();
    await this.saveIndex();
    await this.saveSession(session);
    return { session: publicSession(session), thread: asThread(session) };
  }

  private async suggestTitle(input: Record<string, unknown>) {
    const session = this.sessionOrThrow(String(input.sessionId || input.threadId || ""));
    const { userText, assistantText } = extractTitleSource(session.transcript);
    if (!userText) throw new Error("A user message is required before suggesting a title.");

    const prompt = buildSessionTitlePrompt(userText, assistantText);
    const args = [
      "--print",
      "--output-format",
      "text",
      "--mode",
      "ask",
      "--trust",
      "--workspace",
      session.cwd
    ];
    if (session.model && session.model !== "auto") args.push("--model", session.model);
    args.push(prompt);

    const result = await execCursor(args, {
      cwd: session.cwd,
      timeout: sessionTitleTimeoutMs()
    });
    const title = sanitizeSessionTitle(result.stdout);
    if (!title) throw new Error("cursor-agent returned an empty title suggestion.");
    return { title };
  }

  private async archiveSession(input: Record<string, unknown>, archived: boolean) {
    const session = this.sessionOrThrow(String(input.sessionId || input.threadId || ""));
    if (this.activeRuns.has(session.sessionId)) throw new Error("Stop the active Cursor run before changing archive state.");
    session.archived = archived;
    session.updatedAt = now();
    await this.saveIndex();
    await this.saveSession(session);
    return { session: publicSession(session), thread: asThread(session) };
  }

  private async startRun(input: Record<string, unknown>) {
    const session = this.sessionOrThrow(String(input.sessionId || input.threadId || ""));
    if (this.activeRuns.has(session.sessionId)) throw new Error("This Cursor session already has an active run.");
    const text = promptText(input);
    const imagePaths = await this.materializeImages(session.sessionId, imageAttachments(input));
    const attachmentPaths = [...imagePaths, ...localFileAttachments(input)];
    const prompt = [text, ...attachmentPaths.map((filePath) => `@${filePath}`)].filter(Boolean).join("\n");
    if (!prompt) throw new Error("A non-empty prompt or file attachment is required.");

    const project = await resolveProject(session.cwd);
    const models = await this.listModels({ allowStale: true });
    const model = stringParam(input, "model") || session.model;
    const catalogReliable = Boolean(this.modelsCache && !this.modelsCache.diagnostic);
    if (model && model !== "auto" && catalogReliable && !models.some((item) => item.id === model)) {
      throw new Error(`Cursor model is not available: ${model}`);
    }

    const runId = randomUUID();
    const mode = modeParam(input);
    const hasStarted = session.transcript.some((item) => item.event === "user_text");
    if (hasStarted && mode !== session.mode) {
      throw new Error(`Cursor CLI mode is fixed for this native session (${session.mode}); create a new ${mode} session.`);
    }
    session.mode = mode;
    const args = ["--print", "--output-format", "stream-json", "--stream-partial-output", "--workspace", project.realpath, "--resume", session.nativeSessionId];
    if (model && model !== "auto") args.push("--model", model);
    if (mode === "agent") args.push("--trust", "--sandbox", "disabled");
    else args.push("--trust", "--mode", mode);
    for (const dir of new Set(attachmentPaths.map((filePath) => path.dirname(filePath)))) {
      args.push("--add-dir", dir);
    }
    args.push(prompt);

    const child = spawn("cursor-agent", args, {
      cwd: project.realpath,
      detached: true,
      env: cursorEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const run: CursorRun = {
      runId,
      child,
      sessionId: session.sessionId,
      resultSeen: false,
      cancellationRequested: false,
      finalized: false,
      stderr: "",
      stopTimers: [],
      done,
      resolveDone
    };
    this.activeRuns.set(session.sessionId, run);

    session.status = "running";
    session.updatedAt = now();
    session.model = model || session.model;
    if (isUntitledSessionTitle(session.title, session.cwd)) {
      session.title = fallbackSessionTitle(text || "") || session.title;
    }
    delete session.lastError;
    session.transcript.push({ event: "user_text", text: prompt, mode, runId, at: now() });
    await this.saveIndex();
    await this.saveSession(session);
    this.emit({ type: "agent:event", provider: "cursor", sessionId: session.sessionId, runId, event: "status", status: "running" });

    let buffer = "";
    const seenAssistantText = { value: "" };
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) this.handleRunLine(session, run, line, seenAssistantText);
    });
    child.stderr?.on("data", (chunk) => {
      run.stderr = (run.stderr + stripAnsiAndControls(chunk.toString("utf8"))).slice(-maxStderrChars);
    });
    child.on("error", async (error) => {
      await this.finishRun(session, run, "failed", `cursor-agent failed to start: ${error.message}`);
    });
    child.on("close", async (code, signal) => {
      if (buffer.trim()) this.handleRunLine(session, run, buffer, seenAssistantText);
      if (run.cancellationRequested) await this.finishRun(session, run, "cancelled", "Run cancelled.");
      else if (code === 0 && run.resultSeen) await this.finishRun(session, run, "completed");
      else await this.finishRun(session, run, "failed", run.stderr || `cursor-agent exited ${code === null ? signal : code} without a result event.`);
    });

    return { session: publicSession(session), thread: asThread(session), turn: { id: runId, status: "running" }, runId };
  }

  private handleRunLine(session: CursorSessionRecord, run: CursorRun, line: string, seenAssistantText: { value: string }) {
    const clean = stripAnsiAndControls(line).trim();
    if (!clean) return;
    const raw = tryParseJson(clean);
    const items = raw
      ? normalizeCursorStreamItem(raw, seenAssistantText, run.runId)
      : [{ event: "status", status: "running", message: "Malformed cursor-agent stream-json line ignored.", runId: run.runId, at: now() } satisfies CursorTranscriptItem];
    for (const item of items) {
      if (item.event === "result") run.resultSeen = true;
      session.transcript.push(item);
      this.emit(transcriptToEvent("cursor", session.sessionId, run.runId, item));
    }
    session.updatedAt = now();
    this.saveSession(session).catch((error) => {
      this.emit({ type: "agent:event", provider: "cursor", sessionId: session.sessionId, runId: run.runId, event: "error", message: error.message });
    });
  }

  private async materializeImages(sessionId: string, items: Record<string, unknown>[]) {
    if (!items.length) return [] as string[];
    if (items.length > maxCursorImages) throw new Error("Cursor accepts up to 8 image attachments per turn.");
    const dir = path.join(this.root, "attachments", sessionId);
    await ensurePrivateDir(dir);
    const paths: string[] = [];
    for (const [index, item] of items.entries()) {
      const decoded = decodeDataImage(String(item.url));
      const filePath = path.join(dir, safeImageName(item.name, decoded.ext, index));
      const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(tmp, decoded.buffer, { mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, filePath);
      await chmod(filePath, 0o600).catch(() => {});
      paths.push(filePath);
    }
    return paths;
  }

  private async stopRun(input: Record<string, unknown>) {
    const sessionId = String(input.sessionId || input.threadId || "");
    const run = this.activeRuns.get(sessionId);
    if (run) {
      const session = this.sessionOrThrow(sessionId);
      run.cancellationRequested = true;
      this.stopGracefully(run);
      await Promise.race([run.done, new Promise<void>((resolve) => setTimeout(resolve, 7_000))]);
      if (this.activeRuns.get(sessionId) === run) {
        this.forceStop(run);
        await this.finishRun(session, run, "cancelled", "Run cancelled.");
      }
      return { ok: true, cancelled: true, runId: run.runId, turn: { id: run.runId, status: "cancelled" } };
    }

    const session = this.sessions.get(sessionId);
    if (!session) return { ok: true, cancelled: false };
    const orphaned = session.status === "running"
      || session.status === "failed-after-restart"
      || sessionTurns(session).some((turn) => turn.status === "running");
    if (!orphaned) return { ok: true, cancelled: false };
    session.status = "cancelled";
    session.updatedAt = now();
    delete session.lastError;
    appendTerminalStatus(session, "cancelled", "Run cancelled.");
    await this.saveIndex();
    await this.saveSession(session);
    const runId = lastTranscriptRunId(session.transcript);
    this.emit({
      type: "agent:event",
      provider: "cursor",
      sessionId: session.sessionId,
      runId,
      event: "status",
      status: "cancelled",
      message: "Run cancelled."
    });
    return { ok: true, cancelled: true, runId, turn: { id: runId, status: "cancelled" } };
  }

  private killGroup(run: CursorRun, signal: NodeJS.Signals) {
    const pid = run.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        run.child.kill(signal);
      } catch {
        // Process may already be gone.
      }
    }
  }

  private stopGracefully(run: CursorRun) {
    this.killGroup(run, "SIGINT");
    run.stopTimers.push(
      setTimeout(() => this.killGroup(run, "SIGTERM"), 3_000),
      setTimeout(() => this.killGroup(run, "SIGKILL"), 6_000)
    );
  }

  private forceStop(run: CursorRun) {
    run.cancellationRequested = true;
    for (const timer of run.stopTimers) clearTimeout(timer);
    this.killGroup(run, "SIGKILL");
  }

  private async finishRun(session: CursorSessionRecord, run: CursorRun, status: AgentRunStatus, message?: string) {
    if (run.finalized) return;
    run.finalized = true;
    try {
      this.activeRuns.delete(session.sessionId);
      for (const timer of run.stopTimers) clearTimeout(timer);
      session.status = status;
      session.updatedAt = now();
      if ((status === "failed-after-restart" || status === "failed") && message) session.lastError = message;
      const terminal: CursorTranscriptItem = { event: "status", status, message, runId: run.runId, at: now() };
      session.transcript.push(terminal);
      await this.saveIndex();
      await this.saveSession(session);
      this.emit(transcriptToEvent("cursor", session.sessionId, run.runId, terminal));
      if ((status === "failed-after-restart" || status === "failed") && message) {
        this.emit({ type: "agent:event", provider: "cursor", sessionId: session.sessionId, runId: run.runId, event: "error", message });
      }
    } finally {
      run.resolveDone();
    }
  }

  private emit(event: AgentNormalizedEvent) {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}
