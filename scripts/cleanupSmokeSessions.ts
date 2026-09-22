import WebSocket from "ws";

const baseUrl = process.env.CODING_AGENT_CONSOLE_TEST_URL || "http://127.0.0.1:1818/codex_web_cursor/";
const password = process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN || "";
const smokePrefix = process.env.CODING_AGENT_CONSOLE_SMOKE_PREFIX || "/tmp/coding-agent-console-real-cursor-";

function appUrl(pathname: string) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
  return url;
}

function responseItems(value: any) {
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.threads)) return value.threads;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.data?.threads)) return value.data.threads;
  return [];
}

async function main() {
  const login = await fetch(appUrl("api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(password ? { password } : {})
  });
  if (!login.ok) throw new Error(`Login failed with ${login.status}.`);
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
  const wsUrl = appUrl("ws");
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl, { headers: { cookie, origin: new URL(baseUrl).origin } });
  const replies = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "reply" || !message.requestId) return;
    const pending = replies.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    replies.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(String(message.error || "Agent request failed.")));
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  function request(provider: "codex" | "cursor" | "claude", method: string, params: Record<string, unknown>) {
    const requestId = `cleanup-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(requestId);
        reject(new Error(`Timed out waiting for ${provider} ${method}.`));
      }, 15_000);
      replies.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "agent:request", provider, method, params, requestId }));
    });
  }

  const archived = { codex: 0, cursor: 0, claude: 0 };
  for (const provider of ["codex", "cursor", "claude"] as const) {
    const method = provider === "cursor" ? "session/list" : "thread/list";
    const result = await request(provider, method, { archived: false, limit: 200 });
    for (const session of responseItems(result)) {
      if (!String(session?.cwd || "").startsWith(smokePrefix)) continue;
      const id = String(session?.nativeSessionId || session?.sessionId || session?.id || "");
      if (!id) continue;
      if (provider === "cursor" && session?.status === "running") {
        await request(provider, "run/stop", { sessionId: id });
      }
      if (provider === "claude" && session?.status === "running") {
        await request(provider, "turn/interrupt", { threadId: id });
      }
      await request(
        provider,
        provider === "cursor" ? "session/archive" : "thread/archive",
        provider === "cursor" ? { sessionId: id } : { threadId: id }
      );
      archived[provider] += 1;
    }
  }

  ws.close();
  console.log(JSON.stringify({ smokePrefix, archived }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
