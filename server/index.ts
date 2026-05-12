import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { clearSessionCookie, isAuthenticated, authEnabled, requireProductionAuth, setSessionCookie, validateLogin } from "./auth";
import { createCodexGateway } from "./codexGateway";
import { gitWorkingTreeDiff, gitWorkingTreeDiffFromSnapshot, gitWorkingTreeSnapshot } from "./gitDiff";
import { readJson, sendError, sendJson } from "./http";
import { listProjectDirectory, projectSuggestions, resolveProject } from "./project";
import type { BrowserEvent, BrowserMessage, BrowserReply } from "./types";

const execFileAsync = promisify(execFile);
const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || process.env.CODEX_WEB_PORT || 3000);
const publicBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

requireProductionAuth();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const gateway = createCodexGateway();

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

async function handleApi(req: IncomingMessage, res: ServerResponse) {
  if (!originAllowed(req)) {
    sendError(res, 403, "Origin is not allowed.");
    return true;
  }

  const route = pathname(req);
  const url = new URL(req.url || "/", "http://localhost");

  if (route === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
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
        defaultCwd: process.cwd()
      });
      return true;
    }

    gateway.ensureStarted().catch(() => {});

    sendJson(res, 200, {
      authenticated: true,
      authEnabled: authEnabled(),
      codexVersion: version,
      defaultCwd: process.cwd(),
      codex: gateway.getSnapshot(),
      codexError: null
    });
    return true;
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
  }

  return false;
}

async function handleBrowserMessage(ws: WebSocket, raw: string) {
  const message = JSON.parse(raw) as BrowserMessage;

  if (message.type === "project:resolve") {
    const result = await resolveProject(message.cwd);
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result });
    return;
  }

  if (message.type === "codex:request") {
    const result = await gateway.request(message.method, withCodexDefaults(message.method, message.params));
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result });
    return;
  }

  if (message.type === "codex:serverResponse") {
    await gateway.respondToServerRequest(message.serverRequestId, message.result);
    send(ws, { type: "reply", requestId: message.requestId, ok: true, result: { ok: true } });
  }
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      if (await handleApi(req, res)) return;
      const route = pathname(req);
      if (!route.startsWith("/_next/") && !route.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
      }
      await handle(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, message);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

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
    const unsubscribe = gateway.subscribe((event) => send(ws, event));

    send(ws, { type: "gateway:snapshot", snapshot: gateway.getSnapshot() });
    gateway
      .ensureStarted()
      .then(() => send(ws, { type: "gateway:snapshot", snapshot: gateway.getSnapshot() }))
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

    ws.on("close", unsubscribe);
  });

  server.listen(port, hostname, () => {
    console.log(`codex-remote-console listening on http://${hostname}:${port}`);
    if (!authEnabled()) {
      console.log("auth is disabled; set CODEX_WEB_PASSWORD for private deployments");
    }
    codexVersion();
    gateway.ensureStarted().catch((error) => {
      console.warn("[codex-remote-console] gateway warmup failed:", error instanceof Error ? error.message : error);
    });
  });

  const shutdown = () => {
    gateway.stop();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});
