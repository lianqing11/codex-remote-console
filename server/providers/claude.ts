import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { childProcessEnv } from "../codex/stdioSupport";
import type {
  AgentModelSummary,
  AgentNormalizedEvent,
  AgentProviderSnapshot,
  AgentRunStatus
} from "../types";

export type ClaudeProviderOptions = {
  command?: string;
  configDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
};

type ClaudeMode = "agent" | "plan";

type ClaudeOverlay = {
  id: string;
  cwd: string;
  title: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  mode: ClaudeMode;
  effort: string | null;
  nativeStarted: boolean;
};

type ClaudeTurn = {
  id: string;
  items: Array<Record<string, unknown>>;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
};

type ClaudeRun = {
  runId: string;
  child: ChildProcess;
  sessionId: string;
  finalized: boolean;
  failed: boolean;
  stderr: string;
};

type ClaudeStreamEvent = {
  event: AgentNormalizedEvent["event"];
  runId: string;
  text?: string;
  delta?: boolean;
  toolName?: string;
  toolCallId?: string;
  summary?: string;
  status?: AgentRunStatus;
  message?: string;
  result?: unknown;
};

type Handler = (event: AgentNormalizedEvent) => void;

const defaultClaudeModel = "claude-sonnet-5";
const defaultEffort = "high";

const fallbackModels: AgentModelSummary[] = [
  listedModel("claude-sonnet-5", "Sonnet 5", "Most efficient for everyday tasks", ["low", "medium", "high", "xhigh", "max"], true),
  listedModel("claude-fable-5-1", "Fable 5.1", "For your toughest challenges", ["low", "medium", "high", "xhigh", "max"]),
  listedModel("claude-opus-5", "Opus 5", "For complex tasks", ["low", "medium", "high", "xhigh", "max"]),
  listedModel("claude-haiku-4-5-20251001", "Haiku 4.5", "Fastest for quick answers", [])
];

function listedModel(
  id: string,
  name: string,
  description: string,
  efforts: string[],
  isDefault = false
): AgentModelSummary {
  return {
    id,
    name,
    displayName: name,
    description,
    isDefault,
    defaultReasoningEffort: efforts.includes(defaultEffort) ? defaultEffort : efforts[0] || null,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort }))
  };
}

export function parseClaudeModelCatalog(raw: unknown): AgentModelSummary[] {
  const root = record(raw);
  const catalog = record(root.catalog);
  const config = record(catalog.config);
  const models = Array.isArray(config.models) ? config.models : Array.isArray(root.models) ? root.models : [];
  const listed: AgentModelSummary[] = [];
  for (const item of models) {
    const row = record(item);
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    const name = String(row.name || row.short_name || id);
    const thinking = record(row.thinking);
    const options = Array.isArray(thinking.effort_options) ? thinking.effort_options : [];
    const efforts = thinking.type === "none"
      ? []
      : options.map((option) => String(record(option).id || "")).filter(Boolean);
    listed.push(listedModel(id, name, String(row.description || ""), efforts, listed.length === 0));
  }
  return listed;
}

async function loadClaudeModels(configDir: string) {
  const dir = path.join(configDir, "cache", "model-catalog");
  const files = await readdir(dir).catch(() => []);
  const catalogs = files.filter((file) => file.endsWith(".json"));
  let newest: { file: string; mtime: number } | null = null;
  for (const file of catalogs) {
    const filePath = path.join(dir, file);
    const mtime = await stat(filePath).then((info) => info.mtimeMs).catch(() => 0);
    if (!newest || mtime > newest.mtime) newest = { file: filePath, mtime };
  }
  if (!newest) return fallbackModels;
  const parsed = parseClaudeModelCatalog(JSON.parse(await readFile(newest.file, "utf8")));
  return parsed.length ? parsed : fallbackModels;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  const item = record(value);
  if (typeof item.text === "string") return item.text;
  if (item.content !== undefined) return textOf(item.content);
  if (typeof item.message === "string") return item.message;
  return "";
}

export function projectSlug(cwd: string) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function parseClaudeTranscript(raw: string): { turns: ClaudeTurn[]; cwd: string; preview: string; title: string; updatedAt: number } {
  const turns: ClaudeTurn[] = [];
  let cwd = "";
  let updatedAt = 0;
  let current: ClaudeTurn | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = record(parsed);
    if (typeof row.cwd === "string" && row.cwd) cwd = row.cwd;
    const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) / 1000 : typeof row.timestamp === "number" ? row.timestamp : 0;
    if (timestamp) updatedAt = Math.max(updatedAt, timestamp);

    const type = String(row.type || row.role || "");
    const message = record(row.message);
    const content = message.content ?? row.content ?? row.message;
    const blocks = Array.isArray(content) ? content.map(record) : [];
    const isToolResult = type === "user" && blocks.some((block) => block.type === "tool_result");

    if ((type === "user" || type === "human") && !isToolResult) {
      const text = textOf(content) || textOf(row);
      current = {
        id: String(row.uuid || row.id || `turn-${turns.length + 1}`),
        items: [],
        status: "completed",
        startedAt: timestamp || null,
        completedAt: timestamp || null
      };
      turns.push(current);
      if (text) {
        current.items.push({
          id: `${current.id}-user`,
          type: "userMessage",
          content: [{ type: "text", text, text_elements: [] }]
        });
      }
      continue;
    }

    if (!current) continue;

    if (isToolResult) {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const toolId = String(block.tool_use_id || block.toolUseId || `${current.id}-tool`);
        const existing = current.items.find((item) => item.id === toolId);
        const output = textOf(block.content || block);
        if (existing) Object.assign(existing, { status: "completed", output });
        else current.items.push({ id: toolId, type: "toolCall", tool: "tool", status: "completed", output });
      }
      continue;
    }

    if (type === "assistant" || type === "assistant_text") {
      for (const block of blocks.length ? blocks : [{ type: "text", text: textOf(content) }]) {
        if (block.type === "tool_use") {
          current.items.push({
            id: String(block.id || `${current.id}-tool-${current.items.length}`),
            type: "toolCall",
            tool: String(block.name || "tool"),
            status: "completed",
            output: textOf(block.input)
          });
          continue;
        }
        const text = textOf(block);
        if (!text) continue;
        const assistantId = `${current.id}-assistant`;
        const assistant = current.items.find((item) => item.id === assistantId);
        if (assistant) assistant.text = `${assistant.text || ""}${text}`;
        else current.items.push({ id: assistantId, type: "agentMessage", text });
      }
    }
  }

  const firstUser = turns[0]?.items.find((item) => item.type === "userMessage");
  const title = textOf(record(firstUser).content).trim() || "New session";
  return { turns, cwd, preview: title, title: title.slice(0, 80), updatedAt };
}

export function claudeStreamEvents(raw: unknown, runId: string): ClaudeStreamEvent[] {
  const row = record(raw);
  const type = String(row.type || row.event || "");
  const nested = record(row.event);
  const message = record(row.message);
  const content = Array.isArray(message.content) ? message.content.map(record) : [];

  if (type === "rate_limit_event") {
    return row.rate_limit_info ? [{ event: "rate_limits", runId, result: row.rate_limit_info }] : [];
  }

  if (type === "assistant" || type === "assistant_text") {
    if (row.error || row.is_api_error_message) {
      const text = textOf(content) || textOf(row.result || row.error);
      return text ? [{ event: "error", runId, message: text }] : [];
    }
    const events: ClaudeStreamEvent[] = [];
    for (const block of content) {
      if (block.type === "tool_use") {
        events.push({
          event: "tool_started",
          runId,
          toolName: String(block.name || "tool"),
          toolCallId: String(block.id || ""),
          summary: textOf(block.input)
        });
      }
    }
    return events;
  }

  if (type === "content_block_delta" || nested.type === "content_block_delta") {
    const block = type === "content_block_delta" ? row : nested;
    const delta = record(block.delta);
    if (delta.type && delta.type !== "text_delta") return [];
    const text = typeof delta.text === "string" ? delta.text : "";
    return text ? [{ event: "assistant_text", runId, text, delta: true }] : [];
  }

  if (type === "user") {
    return content.filter((block) => block.type === "tool_result").map((block) => ({
      event: "tool_completed" as const,
      runId,
      toolCallId: String(block.tool_use_id || block.toolUseId || ""),
      summary: textOf(block.content)
    }));
  }

  if (type === "result") {
    const failed = row.is_error === true || row.subtype === "error" || row.subtype === "failed";
    const text = textOf(row.result || row.error);
    const events: ClaudeStreamEvent[] = [];
    if (failed && text) events.push({ event: "error", runId, message: text });
    if (row.usage) events.push({ event: "token_usage", runId, result: row.usage });
    return events;
  }

  if (type === "error") {
    return [{ event: "error", runId, message: textOf(row.error || row.message || raw) }];
  }

  return [];
}

function defaultStateDir() {
  const root = process.env.CODING_AGENT_CONSOLE_STATE_DIR?.trim()
    || path.join(homedir(), ".local", "share", "coding-agent-console");
  return path.join(root, "claude");
}

function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
}

function stringParam(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function promptFrom(input: Record<string, unknown>) {
  const direct = stringParam(input, "prompt") || stringParam(input, "message");
  if (direct) return direct;
  const items = Array.isArray(input.input) ? input.input : [];
  const texts = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "text" || typeof item.text === "string")
    .map((item) => String(item.text || "").trim())
    .filter(Boolean);
  const files = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => typeof item.path === "string" ? item.path : "")
    .filter(Boolean);
  const body = texts.join("\n");
  if (!files.length) return body;
  return [body, files.map((file) => `File: ${file}`).join("\n")].filter(Boolean).join("\n\n");
}

async function writePrivate(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700).catch(() => {});
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

export class ClaudeProvider {
  readonly provider = "claude" as const;
  private readonly command: string;
  private readonly configDir: string;
  private readonly stateDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly indexPath: string;
  private overlays = new Map<string, ClaudeOverlay>();
  private runs = new Map<string, ClaudeRun>();
  private subscribers = new Set<Handler>();
  private ready: Promise<void>;
  private versionCache: { value: string; diagnostic: string | null } | null = null;
  private lastRateLimit: unknown = null;

  constructor(options: ClaudeProviderOptions = {}) {
    this.command = options.command || "claude";
    this.configDir = options.configDir || defaultConfigDir();
    this.stateDir = options.stateDir || defaultStateDir();
    this.env = options.env || process.env;
    this.indexPath = path.join(this.stateDir, "index.json");
    this.ready = this.load();
  }

  subscribe(callback: Handler) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async getSnapshot(): Promise<AgentProviderSnapshot> {
    await this.ready;
    const { version, diagnostic, authenticated } = await this.probe();
    const available = version !== "unavailable" && authenticated;
    return {
      provider: "claude",
      available,
      authenticated,
      version,
      status: available ? "ready" : version === "unavailable" ? "unavailable" : "degraded",
      diagnostic,
      capabilities: {
        models: true,
        planMode: true,
        askMode: false,
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
        reasoningEffort: true,
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
      sessions: (await this.listSessions()).filter((session) => !session.archived),
      models: await loadClaudeModels(this.configDir),
      rateLimit: this.lastRateLimit
    };
  }

  async handle(method: string, params: unknown) {
    await this.ready;
    const input = params && typeof params === "object" ? params as Record<string, unknown> : {};
    if (method === "thread/list") return { data: (await this.listSessions()).filter((session) => !session.archived) };
    if (method === "thread/start") return this.startThread(input);
    if (method === "thread/read" || method === "thread/resume") return this.readThread(input);
    if (method === "thread/name/set" || method === "thread/name") return this.renameThread(input);
    if (method === "thread/archive") return this.archiveThread(input, true);
    if (method === "thread/unarchive") return this.archiveThread(input, false);
    if (method === "model/list") return { data: await loadClaudeModels(this.configDir) };
    if (method === "turn/start") return this.startTurn(input);
    if (method === "turn/interrupt") return this.interruptTurn(input);
    throw new Error(`Unsupported Claude method: ${method}`);
  }

  stop() {
    for (const run of this.runs.values()) {
      run.child.kill("SIGTERM");
    }
  }

  private emit(event: AgentNormalizedEvent) {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private async load() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const raw = await readFile(this.indexPath, "utf8").catch(() => "");
    if (raw) {
      const parsed = JSON.parse(raw) as { sessions?: ClaudeOverlay[] };
      for (const session of parsed.sessions || []) {
        if (session?.id) this.overlays.set(session.id, session);
      }
    }
    const usageRaw = await readFile(path.join(this.stateDir, "usage.json"), "utf8").catch(() => "");
    if (usageRaw) this.lastRateLimit = JSON.parse(usageRaw);
  }

  private async persistUsage() {
    if (this.lastRateLimit == null) return;
    await writePrivate(path.join(this.stateDir, "usage.json"), JSON.stringify(this.lastRateLimit));
  }

  private async persist() {
    await writePrivate(this.indexPath, JSON.stringify({ sessions: [...this.overlays.values()] }, null, 2));
  }

  private overlay(id: string, cwd = "", patch: Partial<ClaudeOverlay> = {}): ClaudeOverlay {
    const current = this.overlays.get(id) || {
      id,
      cwd,
      title: "New session",
      archived: false,
      createdAt: now(),
      updatedAt: now(),
      model: null,
      mode: "agent" as const,
      effort: null,
      nativeStarted: false
    };
    const next = { ...current, ...patch, id, cwd: patch.cwd || current.cwd || cwd, updatedAt: now() };
    this.overlays.set(id, next);
    return next;
  }

  private jsonlPath(cwd: string, id: string) {
    return path.join(this.configDir, "projects", projectSlug(cwd), `${id}.jsonl`);
  }

  private async readJsonl(cwd: string, id: string) {
    const filePath = this.jsonlPath(cwd, id);
    const raw = await readFile(filePath, "utf8").catch(() => "");
    return raw ? parseClaudeTranscript(raw) : { turns: [], cwd, preview: "", title: "", updatedAt: 0 };
  }

  private asThread(overlay: ClaudeOverlay, transcript: Awaited<ReturnType<typeof parseClaudeTranscript>>) {
    const title = overlay.title && overlay.title !== "New session" ? overlay.title : transcript.title || overlay.title;
    return {
      thread: {
        id: overlay.id,
        nativeId: overlay.id,
        provider: "claude",
        cwd: overlay.cwd || transcript.cwd,
        name: title,
        title,
        preview: transcript.preview || title,
        empty: transcript.turns.length === 0,
        archived: overlay.archived,
        createdAt: overlay.createdAt,
        updatedAt: Math.max(overlay.updatedAt, transcript.updatedAt),
        model: overlay.model,
        mode: overlay.mode,
        status: this.runs.has(overlay.id) ? "running" : "idle",
        runtime: { model: overlay.model, mode: overlay.mode, reasoningEffort: overlay.effort, serviceTier: null },
        turns: transcript.turns
      }
    };
  }

  private async listSessions() {
    const sessions = [];
    for (const overlay of this.overlays.values()) {
      const transcript = await this.readJsonl(overlay.cwd, overlay.id);
      const { thread } = this.asThread(overlay, transcript);
      sessions.push({
        provider: "claude" as const,
        id: overlay.id,
        key: `claude:${overlay.id}`,
        sessionId: overlay.id,
        nativeSessionId: overlay.id,
        cwd: thread.cwd,
        name: thread.name,
        title: thread.title,
        preview: thread.preview,
        empty: thread.empty,
        archived: overlay.archived,
        createdAt: overlay.createdAt,
        updatedAt: thread.updatedAt,
        model: overlay.model,
        mode: overlay.mode,
        status: thread.status as AgentRunStatus,
        turns: transcript.turns.length
      });
    }

    return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async startThread(input: Record<string, unknown>) {
    const cwd = stringParam(input, "cwd") || process.cwd();
    const id = randomUUID();
    const overlay = this.overlay(id, cwd, {
      model: stringParam(input, "model") || defaultClaudeModel,
      mode: input.mode === "plan" ? "plan" : "agent",
      effort: stringParam(input, "effort") || stringParam(input, "reasoningEffort") || defaultEffort,
      nativeStarted: false
    });
    await this.persist();
    return this.asThread(overlay, { turns: [], cwd, preview: "", title: overlay.title, updatedAt: overlay.updatedAt });
  }

  private async readThread(input: Record<string, unknown>) {
    const id = stringParam(input, "threadId") || stringParam(input, "sessionId");
    if (!id) throw new Error("Claude thread id is required.");
    const overlay = this.overlays.get(id) || this.overlay(id, stringParam(input, "cwd"));
    const transcript = await this.readJsonl(overlay.cwd, id);
    return this.asThread(overlay, transcript);
  }

  private async renameThread(input: Record<string, unknown>) {
    const id = stringParam(input, "threadId") || stringParam(input, "sessionId");
    const title = stringParam(input, "name") || stringParam(input, "title");
    if (!id || !title) throw new Error("Claude rename requires a thread id and title.");
    const overlay = this.overlay(id, stringParam(input, "cwd"), { title });
    await this.persist();
    return this.readThread({ threadId: overlay.id });
  }

  private async archiveThread(input: Record<string, unknown>, archived: boolean) {
    const id = stringParam(input, "threadId") || stringParam(input, "sessionId");
    if (!id) throw new Error("Claude thread id is required.");
    this.overlay(id, stringParam(input, "cwd"), { archived });
    await this.persist();
    return this.readThread({ threadId: id });
  }

  private async startTurn(input: Record<string, unknown>) {
    const id = stringParam(input, "threadId") || stringParam(input, "sessionId");
    const prompt = promptFrom(input);
    if (!id) throw new Error("Claude thread id is required.");
    if (!prompt) throw new Error("Claude turn requires a prompt.");
    if (this.runs.has(id)) throw new Error("Claude already has an active turn for this session.");

    const overlay = this.overlays.get(id) || this.overlay(id, stringParam(input, "cwd"));
    const mode = input.mode === "plan" ? "plan" : overlay.mode;
    const model = stringParam(input, "model") || overlay.model || defaultClaudeModel;
    const effort = stringParam(input, "effort") || stringParam(input, "reasoningEffort") || overlay.effort || defaultEffort;
    const runId = randomUUID();
    this.overlay(id, overlay.cwd, {
      model,
      mode,
      effort,
      title: overlay.title === "New session" ? prompt.slice(0, 80) : overlay.title
    });
    await this.persist();

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      overlay.nativeStarted ? "--resume" : "--session-id",
      id,
      "--permission-mode",
      mode === "plan" ? "plan" : "acceptEdits",
      "--model",
      model
    ];
    if (effort) args.push("--effort", effort);
    if (overlay.title && overlay.title !== "New session") args.push("--name", overlay.title);
    args.push(prompt);

    this.emit({ type: "agent:event", provider: "claude", sessionId: id, runId, event: "status", status: "running" });

    const child = spawn(this.command, args, {
      cwd: overlay.cwd || process.cwd(),
      env: childProcessEnv(this.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const run: ClaudeRun = { runId, child, sessionId: id, finalized: false, failed: false, stderr: "" };
    this.runs.set(id, run);

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) this.handleStreamLine(id, runId, line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      run.stderr = `${run.stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.on("error", (error) => this.finishRun(run, "failed", error.message));
    child.on("close", (code) => {
      this.handleStreamLine(id, runId, stdout);
      const failed = run.failed || code !== 0;
      this.finishRun(
        run,
        failed ? "failed" : "completed",
        failed ? (run.stderr.trim() || `claude exited with ${code}`) : undefined
      );
    });
    return { turn: { id: runId, items: [], status: "inProgress", startedAt: now(), completedAt: null } };
  }

  private handleStreamLine(sessionId: string, runId: string, line: string) {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const overlay = this.overlays.get(sessionId);
    if (overlay && !overlay.nativeStarted) {
      this.overlay(sessionId, overlay.cwd, { nativeStarted: true });
      void this.persist();
    }
    const run = this.runs.get(sessionId);
    for (const event of claudeStreamEvents(parsed, runId)) {
      if (event.event === "error" && run) run.failed = true;
      if (event.event === "rate_limits") {
        this.lastRateLimit = event.result;
        void this.persistUsage();
      }
      this.emit({
        type: "agent:event",
        provider: "claude",
        sessionId,
        runId: event.runId,
        event: event.event,
        text: event.text,
        delta: event.delta,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        summary: event.summary,
        status: event.status,
        message: event.message,
        result: event.result
      } as AgentNormalizedEvent);
    }
  }

  private finishRun(run: ClaudeRun, status: AgentRunStatus, message?: string) {
    if (run.finalized) return;
    run.finalized = true;
    this.runs.delete(run.sessionId);
    this.emit({
      type: "agent:event",
      provider: "claude",
      sessionId: run.sessionId,
      runId: run.runId,
      event: "status",
      status,
      message
    });
  }

  private async interruptTurn(input: Record<string, unknown>) {
    const id = stringParam(input, "threadId") || stringParam(input, "sessionId");
    const run = id ? this.runs.get(id) : [...this.runs.values()][0];
    if (!run) return { ok: true };
    run.child.kill("SIGTERM");
    setTimeout(() => {
      if (!run.finalized) run.child.kill("SIGKILL");
    }, 1500);
    this.finishRun(run, "cancelled", "Interrupted.");
    return { ok: true };
  }

  private exec(args: string[], timeout = 15_000) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(this.command, args, { timeout, env: childProcessEnv(this.env) }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ stdout, stderr });
      });
    });
  }

  private async probe() {
    if (this.versionCache) {
      return {
        version: this.versionCache.value,
        diagnostic: this.versionCache.diagnostic,
        authenticated: !this.versionCache.diagnostic
      };
    }
    try {
      const version = (await this.exec(["--version"])).stdout.trim() || "claude";
      try {
        await this.exec(["auth", "status"]);
        this.versionCache = { value: version, diagnostic: null };
        return { version, diagnostic: null, authenticated: true };
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        this.versionCache = { value: version, diagnostic };
        return { version, diagnostic, authenticated: false };
      }
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      this.versionCache = { value: "unavailable", diagnostic };
      return { version: "unavailable", diagnostic, authenticated: false };
    }
  }
}
