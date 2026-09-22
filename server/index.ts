import "./loadLocalEnv";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { allowLoginAttempt, clearSessionCookie, isAuthenticated, authEnabled, requireProductionAuth, setSessionCookie, validateLogin } from "./auth";
import { createCodexGateway } from "./codexGateway";
import { enrichCodexThreadRuntime } from "./codex/threadRuntime";
import { requestWithWarmPool, WarmThreadPool } from "./codex/warmThreadPool";
import { AgentQueue, AgentQueueStore, type AgentQueueItem } from "./agentQueue";
import { ClaudeProvider } from "./providers/claude";
import { CursorProvider } from "./providers/cursor";
import {
  cursorCompletionNotification,
  cursorFeishuSource,
  cursorThreadMeta,
  ensureCursorSessionTitle
} from "./cursorFeishuNotify";
import {
  gitTreeFile,
  gitWorkingTreeDiff,
  gitWorkingTreeDiffFromSnapshot,
  gitWorkingTreeFile,
  gitWorkingTreeSnapshot
} from "./gitDiff";
import {
  loadFeishuNotifyConfig,
  notifyTurnCompleted,
  notifyUserInputRequested,
  streamCompletionNotification,
  type FeishuNotifySource,
  type ThreadMetaLookup
} from "./feishuNotify";
import { HttpError, readJson, sendError, sendJson } from "./http";
import {
  listProjectDirectory,
  listProjectTree,
  projectSuggestions,
  readProjectAsset,
  readProjectFile,
  resolveProject,
  writeProjectUpload
} from "./project";
import { attachSelectiveProxy } from "./selectiveProxy";
import type { AgentNormalizedEvent, AgentProviderId, AgentProviderSnapshot, BrowserEvent, BrowserMessage, BrowserReply } from "./types";
import { resolveUploadedInputs, UploadStore } from "./uploads";

const execFileAsync = promisify(execFile);
const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || process.env.CODEX_WEB_PORT || 3000);
const publicBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

requireProductionAuth();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const gateway = createCodexGateway();
const warmThreadPool = new WarmThreadPool();
const feishuNotifyConfig = loadFeishuNotifyConfig();
const cursorProvider = new CursorProvider();
const claudeProvider = new ClaudeProvider();
const streamProviders = {
  cursor: cursorProvider,
  claude: claudeProvider
} as const;
const claudeFeishuSource = { id: "claude", label: "Claude Code" } as const;
const uploadStore = new UploadStore();
const pendingQueueRequests = new Map<string | number, { provider: "codex"; threadId: string }>();

const agentQueue = new AgentQueue(new AgentQueueStore(), {
  execute: executeQueueItem,
  createBaseline: async (item) => item.cwd ? (await gitWorkingTreeSnapshot(item.cwd)).tree : null,
  createDiff: async (item) => item.cwd && item.baseTree
    ? await gitWorkingTreeDiffFromSnapshot(item.cwd, item.baseTree)
    : null
});

const codexThreadMetaLookup: ThreadMetaLookup = async (threadId, options) => {
  // Default to metadata-only reads. Full turn payloads are large and only needed
  // when the completion notification itself lacks an assistant summary.
  const result = (await gateway.request("thread/read", {
    threadId,
    includeTurns: Boolean(options?.includeTurns)
  })) as {
    thread?: Record<string, unknown>;
    cwd?: string;
    name?: string | null;
    preview?: string;
    turns?: Array<{ id?: string; items?: Array<{ id?: string; type?: string; text?: string }> }>;
    parentThreadId?: string | null;
    forkedFromId?: string | null;
    agentNickname?: string | null;
    agentRole?: string | null;
    source?: unknown;
  };
  const thread = (result?.thread || result) as Record<string, unknown>;
  const strOrNull = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    cwd: typeof thread?.cwd === "string" ? thread.cwd : "",
    name: strOrNull(thread?.name),
    preview: typeof thread?.preview === "string" ? thread.preview : "",
    turns: Array.isArray(thread?.turns)
      ? (thread.turns as Array<{ id?: string; items?: Array<{ id?: string; type?: string; text?: string }> }>)
      : [],
    parentThreadId: strOrNull(thread?.parentThreadId),
    forkedFromId: strOrNull(thread?.forkedFromId),
    agentNickname: strOrNull(thread?.agentNickname),
    agentRole: strOrNull(thread?.agentRole),
    source: thread?.source
  };
};

function subscribeStreamProvider(
  provider: { subscribe(callback: (event: AgentNormalizedEvent) => void): () => void; handle(method: string, params?: unknown): Promise<unknown> },
  id: "cursor" | "claude",
  source: FeishuNotifySource
) {
  const unsubscribeNotify = provider.subscribe((event) => {
    const notification = id === "cursor" ? cursorCompletionNotification(event) : streamCompletionNotification(event);
    if (!notification) return;
    void (async () => {
      if (id === "cursor") {
        try {
          await ensureCursorSessionTitle(cursorProvider, event.sessionId);
        } catch (error) {
          console.warn(
            "[feishu-notify] cursor title ensure failed:",
            error instanceof Error ? error.message : error
          );
        }
      }
      await notifyTurnCompleted(notification, {
        config: feishuNotifyConfig,
        source,
        lookupThread: async (threadId) => cursorThreadMeta(
          await provider.handle("thread/read", { threadId }),
          id
        )
      });
    })();
  });
  const unsubscribeQueue = provider.subscribe((event) => {
    if (event.event !== "status") return;
    if (event.status === "running") {
      agentQueue.handleProviderStarted(id, event.sessionId);
      return;
    }
    if (["completed", "failed", "cancelled", "failed-after-restart"].includes(String(event.status))) {
      void agentQueue.handleProviderTerminal(id, event.sessionId, event.runId || null, String(event.status), event.message);
    }
  });
  return () => {
    unsubscribeNotify();
    unsubscribeQueue();
  };
}

const unsubscribeCursor = subscribeStreamProvider(cursorProvider, "cursor", cursorFeishuSource);
const unsubscribeClaude = subscribeStreamProvider(claudeProvider, "claude", claudeFeishuSource);

gateway.subscribe((event) => {
  if (event.type === "gateway:state" && (event.status === "disconnected" || event.status === "error")) {
    warmThreadPool.clear();
  }
  if (event.type === "gateway:state" && event.status === "disconnected") {
    pendingQueueRequests.clear();
    agentQueue.handleGatewayLost("codex", event.detail || "Codex gateway disconnected.");
  }

  if (event.type === "codex:notification") {
    const method = event.message.method;
    const params = event.message.params;
    const threadId =
      params && typeof params === "object" && "threadId" in params && typeof params.threadId === "string"
        ? params.threadId
        : null;
    if (threadId && (method === "thread/closed" || method === "thread/archived" || method === "thread/deleted")) {
      warmThreadPool.remove(threadId);
    }
    if (threadId && method === "turn/started") {
      agentQueue.handleProviderStarted("codex", threadId);
    }
    if (threadId && method === "turn/completed") {
      const turn = params && typeof params === "object" && "turn" in params && params.turn && typeof params.turn === "object"
        ? params.turn as Record<string, unknown>
        : null;
      const runId = typeof turn?.id === "string" ? turn.id : null;
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      const error = turn?.error && typeof turn.error === "object" && "message" in turn.error
        ? String(turn.error.message || "")
        : undefined;
      void agentQueue.handleProviderTerminal("codex", threadId, runId, status, error);
    }
  }

  if (event.type === "codex:serverRequest") {
    const params = event.request.params && typeof event.request.params === "object"
      ? event.request.params as Record<string, unknown>
      : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (threadId) {
      pendingQueueRequests.set(event.request.id, { provider: "codex", threadId });
      agentQueue.handleWaitingForInput("codex", threadId, true);
    }
    if (event.request.method === "item/tool/requestUserInput") {
      void notifyUserInputRequested(event.request, {
        config: feishuNotifyConfig,
        lookupThread: codexThreadMetaLookup
      });
    }
  }

  if (event.type === "codex:serverRequestResolved") {
    const pending = pendingQueueRequests.get(event.requestId);
    if (pending) {
      pendingQueueRequests.delete(event.requestId);
      agentQueue.handleWaitingForInput(pending.provider, pending.threadId, false);
    }
  }

  if (event.type !== "codex:notification" || event.message.method !== "turn/completed") return;
  void notifyTurnCompleted(event.message, {
    config: feishuNotifyConfig,
    lookupThread: codexThreadMetaLookup
  });
});

async function handleProviderRequest(provider: AgentProviderId, method: string, params: unknown) {
  if (provider === "codex") return codexRequest(method, params);
  const stream = streamProviders[provider];
  if (!stream) throw new Error(`Unsupported provider: ${provider}`);
  return stream.handle(method, params);
}

async function executeQueueItem(item: AgentQueueItem) {
  if (item.provider === "cursor") {
    const result = await cursorProvider.handle("run/start", {
      sessionId: item.threadId,
      prompt: item.text,
      ...item.turnParams
    }) as { runId?: string; turn?: { id?: string } };
    const runId = result.runId || result.turn?.id;
    if (!runId) throw new Error("Cursor did not return a run id.");
    return { runId };
  }

  try {
    await handleProviderRequest(item.provider, "thread/resume", {
      threadId: item.threadId,
      excludeTurns: true,
      forceResume: true,
      ...item.threadParams
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A just-created Codex thread can be resident in app-server before its
    // rollout is visible on disk. Keep the forced resume for normal settings
    // updates, but fall back to the already-loaded thread for this narrow race.
    if (item.provider !== "codex" || !warmThreadPool.has(item.threadId) || !/no rollout found/i.test(message)) throw error;
    await codexRequest("thread/resume", {
      threadId: item.threadId,
      excludeTurns: true,
      ...item.threadParams
    });
  }
  const result = await handleProviderRequest(item.provider, "turn/start", {
    threadId: item.threadId,
    input: [{ type: "text", text: item.text, text_elements: [] }],
    ...item.turnParams
  }) as { turn?: { id?: string } };
  const runId = result.turn?.id;
  if (!runId) throw new Error(`${item.provider} did not return a turn id.`);
  return { runId };
}

function send(ws: WebSocket, message: BrowserEvent | BrowserReply | { type: string; [key: string]: unknown }) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function originAllowed(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    const hosts = [req.headers.host, req.headers["x-forwarded-host"]]
      .flat()
      .filter((value): value is string => typeof value === "string");

    return hosts.some((host) => parsed.host === host || parsed.hostname === host.split(":")[0]);
  } catch {
    return false;
  }
}

function pathname(req: IncomingMessage) {
  const parsed = new URL(req.url || "/", "http://localhost");
  if (publicBasePath && parsed.pathname.startsWith(`${publicBasePath}/`)) {
    return parsed.pathname.slice(publicBasePath.length) || "/";
  }
  return parsed.pathname;
}

let codexVersionCache: Promise<string> | null = null;
function codexVersion() {
  if (!codexVersionCache) {
    codexVersionCache = execFileAsync("codex", ["--version"])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "unavailable");
  }
  return codexVersionCache;
}

async function codexRequest(method: string, params: unknown) {
  const rawResult = await requestWithWarmPool(
    gateway,
    warmThreadPool,
    method,
    withCodexDefaults(method, params)
  );
  return enrichCodexThreadRuntime(method, rawResult);
}

function withCodexDefaults(method: string, params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;

  if (method === "thread/start") {
    return {
      ...params,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    };
  }

  if (method === "thread/resume") {
    return {
      ...params,
      persistExtendedHistory: true
    };
  }

  return params;
}

async function codexProviderSnapshot(): Promise<AgentProviderSnapshot> {
  const snapshot = gateway.getSnapshot();
  const version = await codexVersion();
  const available = version !== "unavailable" && !snapshot.diagnostic;
  return {
    provider: "codex",
    available,
    authenticated: available,
    version,
    status: available ? "ready" : version === "unavailable" ? "unavailable" : "degraded",
    diagnostic: snapshot.diagnostic?.detail || null,
    capabilities: {
      models: true,
      planMode: true,
      askMode: false,
      approvals: true,
      steering: true,
      images: true,
      fork: true,
      compact: true,
      plugins: true,
      skills: true,
      mcpStatus: true,
      memory: true,
      serviceTier: true,
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
      steer: true,
      mcp: true
    }
  };
}

function codexAgentEvent(event: BrowserEvent): BrowserEvent | null {
  if (event.type === "codex:notification") {
    const method = event.message.method;
    const params = event.message.params && typeof event.message.params === "object"
      ? event.message.params as Record<string, unknown>
      : {};
    const sessionId = typeof params.threadId === "string" ? params.threadId : "";
    if (!sessionId) return null;
    const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : null;
    const runId = typeof params.turnId === "string"
      ? params.turnId
      : typeof turn?.id === "string"
        ? turn.id
        : undefined;
    if (method === "turn/started") {
      return { type: "agent:event", provider: "codex", sessionId, runId, event: "status", status: "running" };
    }
    if (method === "turn/completed") {
      return { type: "agent:event", provider: "codex", sessionId, runId, event: "status", status: "completed" };
    }
    if (method === "item/updated" || method === "item/completed") {
      if ("item" in params) {
        const item = params.item;
        if (item && typeof item === "object" && "text" in item) {
          return {
            type: "agent:event",
            provider: "codex",
            sessionId,
            runId,
            event: "assistant_text",
            text: String((item as { text?: unknown }).text || ""),
            delta: false
          };
        }
      }
    }
  }

  return null;
}

async function providersSnapshot() {
  return {
    codex: await codexProviderSnapshot(),
    cursor: await cursorProvider.getSnapshot(),
    claude: await claudeProvider.getSnapshot()
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse) {
  if (!originAllowed(req)) {
    sendError(res, 403, "Origin is not allowed.");
    return true;
  }

  const route = pathname(req);
  const url = new URL(req.url || "/", "http://localhost");

  if (route === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    if (!allowLoginAttempt(req)) {
      sendError(res, 429, "Too many login attempts. Try again in a minute.");
      return true;
    }
    if (!validateLogin(body)) {
      sendError(res, 401, "Invalid password or token.");
      return true;
    }

    setSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (route === "/api/auth/logout" && req.method === "POST") {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (route === "/api/bootstrap" && req.method === "GET") {
    const authenticated = isAuthenticated(req);
    const version = await codexVersion();
    if (!authenticated) {
      sendJson(res, 200, {
        authenticated: false,
        authEnabled: authEnabled(),
        codexVersion: version,
        defaultCwd: ""
      });
      return true;
    }

    gateway.ensureStarted().catch(() => {});

    sendJson(res, 200, {
      authenticated: true,
      authEnabled: authEnabled(),
      codexVersion: version,
      defaultCwd: process.cwd(),
      uploads: { maxBytes: uploadStore.maxBytes, maxFiles: 8 },
      providers: await providersSnapshot(),
      codex: gateway.getSnapshot(),
      codexError: null
    });
    return true;
  }

  if (route === "/api/uploads" && req.method === "POST") {
    if (!isAuthenticated(req)) {
      sendError(res, 401, "Unauthorized.");
      return true;
    }
    const rawLength = req.headers["content-length"];
    const contentLength = typeof rawLength === "string" && rawLength.trim() ? Number(rawLength) : null;
    const upload = await uploadStore.save(req, {
      name: url.searchParams.get("name") || "upload",
      contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
      contentLength
    });
    sendJson(res, 201, uploadStore.toPublic(upload));
    return true;
  }

  const uploadMatch = /^\/api\/uploads\/([0-9a-f-]+)$/i.exec(route);
  if (uploadMatch) {
    if (!isAuthenticated(req)) {
      sendError(res, 401, "Unauthorized.");
      return true;
    }
    const uploadId = uploadMatch[1];
    if (req.method === "DELETE") {
      sendJson(res, 200, await uploadStore.remove(uploadId));
      return true;
    }
    if (req.method === "GET") {
      const upload = await uploadStore.get(uploadId);
      const encodedName = encodeURIComponent(upload.name).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
      res.writeHead(200, {
        "cache-control": "private, no-store",
        "content-disposition": `${upload.image ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
        "content-length": upload.size,
        "content-type": upload.image ? upload.contentType : "application/octet-stream",
        "x-content-type-options": "nosniff"
      });
      createReadStream(upload.filePath).pipe(res);
      return true;
    }
  }

  if (route.startsWith("/api/projects/")) {
    if (!isAuthenticated(req)) {
      sendError(res, 401, "Unauthorized.");
      return true;
    }

    if (route === "/api/projects/suggestions" && req.method === "GET") {
      sendJson(res, 200, { data: await projectSuggestions() });
      return true;
    }

    if (route === "/api/projects/resolve" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      sendJson(res, 200, await resolveProject(cwd));
      return true;
    }

    if (route === "/api/projects/list" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      sendJson(res, 200, await listProjectDirectory(cwd));
      return true;
    }

    if (route === "/api/projects/tree" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const filePath = url.searchParams.get("path") || "";
      sendJson(res, 200, await listProjectTree(cwd, filePath));
      return true;
    }

    if (route === "/api/projects/upload" && req.method === "POST") {
      const rawLength = req.headers["content-length"];
      const contentLength = typeof rawLength === "string" && rawLength.trim() ? Number(rawLength) : null;
      const upload = await writeProjectUpload(url.searchParams.get("cwd") || "", req, {
        directory: url.searchParams.get("path") || "",
        name: url.searchParams.get("name") || "",
        overwrite: ["1", "true"].includes(url.searchParams.get("overwrite") || ""),
        contentLength,
        maxBytes: uploadStore.maxBytes
      });
      sendJson(res, upload.overwritten ? 200 : 201, upload);
      return true;
    }

    if (route === "/api/projects/read" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const filePath = url.searchParams.get("path") || "";
      sendJson(res, 200, await readProjectFile(cwd, filePath));
      return true;
    }

    if (route === "/api/projects/asset" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const filePath = url.searchParams.get("path") || "";
      const asset = await readProjectAsset(cwd, filePath);
      res.writeHead(200, {
        "cache-control": "private, max-age=60",
        "content-length": asset.size,
        "content-type": asset.contentType,
        "last-modified": new Date(asset.modifiedAt).toUTCString(),
        "x-content-type-options": "nosniff"
      });
      res.end(asset.buffer);
      return true;
    }

    if (route === "/api/projects/diff" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const baseTree = url.searchParams.get("baseTree");
      sendJson(res, 200, baseTree ? await gitWorkingTreeDiffFromSnapshot(cwd, baseTree) : await gitWorkingTreeDiff(cwd));
      return true;
    }

    if (route === "/api/projects/diff-snapshot" && req.method === "POST") {
      const body = await readJson(req);
      const cwd = body && typeof body === "object" && "cwd" in body ? String(body.cwd || "") : "";
      sendJson(res, 200, await gitWorkingTreeSnapshot(cwd));
      return true;
    }

    if (route === "/api/projects/file" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const filePath = url.searchParams.get("path") || "";
      sendJson(res, 200, await gitWorkingTreeFile(cwd, filePath));
      return true;
    }

    if (route === "/api/projects/file-at-tree" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const tree = url.searchParams.get("tree") || "";
      const filePath = url.searchParams.get("path") || "";
      sendJson(res, 200, await gitTreeFile(cwd, tree, filePath));
      return true;
    }
  }

  return false;
}

async function handleBrowserMessage(ws: WebSocket, raw: string) {
  const message = JSON.parse(raw) as BrowserMessage;

  if (message.type === "queue:enqueue") {
    const item = agentQueue.enqueue(message.item);
    // enqueue() already broadcasts the committed snapshot to every client.
    // Keep the acknowledgement small so the composer does not parse the same
    // full queue twice before it can show that the task was saved.
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: { item } });
    return;
  }

  if (message.type === "queue:list") {
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: agentQueue.snapshot() });
    return;
  }

  if (message.type === "queue:cancel") {
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: agentQueue.cancel(message.queueId) });
    return;
  }

  if (message.type === "queue:retry") {
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: agentQueue.retry(message.queueId) });
    return;
  }

  if (message.type === "queue:pause") {
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: agentQueue.pauseThread(message.threadKey) });
    return;
  }

  if (message.type === "queue:resume") {
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: agentQueue.resumeThread(message.threadKey) });
    return;
  }

  if (message.type === "queue:clear") {
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: agentQueue.clearThread(message.threadKey) });
    return;
  }

  if (message.type === "project:resolve") {
    const result = await resolveProject(message.cwd);
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result });
    return;
  }

  if (message.type === "agent:request") {
    const params = await resolveUploadedInputs(message.params, uploadStore);
    const result = await handleProviderRequest(message.provider, message.method, params);
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result });
    return;
  }

  if (message.type === "codex:request") {
    const result = await codexRequest(message.method, await resolveUploadedInputs(message.params, uploadStore));
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result });
    return;
  }

  if (message.type === "codex:serverResponse") {
    await gateway.respondToServerRequest(message.serverRequestId, message.result);
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: { ok: true } });
  }
}

app.prepare().then(async () => {
  const selectiveProxy = await attachSelectiveProxy();
  const server = createServer(async (req, res) => {
    try {
      if (await handleApi(req, res)) return;
      const route = pathname(req);
      if (!route.startsWith("/_next/") && !route.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
      }
      await handle(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 500;
      sendError(res, status, error instanceof Error ? error.message : String(error));
    }
  });

  // Compress large frames (thread history is hundreds of KB); skip small
  // streaming deltas where deflate costs more than it saves.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: { threshold: 4096, zlibDeflateOptions: { level: 3, memLevel: 7 } }
  });

  server.on("upgrade", (req, socket, head) => {
    if (pathname(req) !== "/ws") {
      socket.destroy();
      return;
    }

    if (!originAllowed(req) || !isAuthenticated(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const unsubscribeGateway = gateway.subscribe((event) => {
      send(ws, event);
      const neutral = codexAgentEvent(event);
      if (neutral) send(ws, neutral);
    });
    const unsubscribeCursorEvents = cursorProvider.subscribe((event) => send(ws, event));
    const unsubscribeClaudeEvents = claudeProvider.subscribe((event) => send(ws, event));
    const unsubscribeQueue = agentQueue.subscribe((event) => send(ws, event));

    send(ws, { type: "gateway:snapshot", snapshot: gateway.getSnapshot() });
    send(ws, { type: "queue:snapshot", snapshot: agentQueue.snapshot() });
    providersSnapshot().then((snapshot) => send(ws, { type: "agent:snapshot", providers: snapshot })).catch(() => {});
    gateway
      .ensureStarted()
      .then(async () => {
        send(ws, { type: "gateway:snapshot", snapshot: gateway.getSnapshot() });
        send(ws, { type: "agent:snapshot", providers: await providersSnapshot() });
      })
      .catch((error) =>
        send(ws, {
          type: "gateway:state",
          status: "error",
          detail: error instanceof Error ? error.message : String(error)
        })
      );

    ws.on("message", async (data) => {
      try {
        await handleBrowserMessage(ws, data.toString());
      } catch (error) {
        let requestId = "unknown";
        try {
          const parsed = JSON.parse(data.toString()) as { requestId?: string };
          requestId = parsed.requestId || requestId;
        } catch {
          // Keep the original protocol error visible in the reply.
        }
        send(ws, {
          type: "reply",
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    ws.on("close", () => {
      unsubscribeGateway();
      unsubscribeCursorEvents();
      unsubscribeClaudeEvents();
      unsubscribeQueue();
    });
  });

  server.listen(port, hostname, () => {
    console.log(`coding-agent-console listening on http://${hostname}:${port}`);
    if (!authEnabled()) {
      console.log("auth is disabled; set CODEX_WEB_PASSWORD for private deployments");
    }
    if (feishuNotifyConfig.enabled && feishuNotifyConfig.userOpenId) {
      console.log("[feishu-notify] enabled");
    } else if (feishuNotifyConfig.enabled) {
      console.warn("[feishu-notify] disabled: missing CODEX_WEB_FEISHU_USER_OPEN_ID");
    }
    codexVersion();
    agentQueue.start();
    gateway.ensureStarted().catch((error) => {
      console.warn("[coding-agent-console] gateway warmup failed:", error instanceof Error ? error.message : error);
    });
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribeCursor();
    unsubscribeClaude();
    for (const client of wss.clients) client.terminate();
    wss.close();
    gateway.stop();
    cursorProvider.stop();
    claudeProvider.stop();
    agentQueue.stop();
    void selectiveProxy?.close();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});
