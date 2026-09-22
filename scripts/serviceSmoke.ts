import assert from "node:assert/strict";
import WebSocket from "ws";

const baseUrl = process.env.CODING_AGENT_CONSOLE_TEST_URL || "http://127.0.0.1:3032/";
const parsedBase = new URL(baseUrl);
const configuredPath = process.env.CODING_AGENT_CONSOLE_TEST_BASE_PATH || "/codex_web_cursor/";
const exposedBasePath = parsedBase.pathname === "/" ? configuredPath : parsedBase.pathname;
const expectedCookiePath = exposedBasePath === "/" ? "/" : `${exposedBasePath.replace(/\/+$/, "")}/`;
const password = process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN || "";

function appUrl(pathname: string) {
  return new URL(`${exposedBasePath.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`, parsedBase.origin);
}

async function responseJson(response: Response) {
  const text = await response.text();
  assert.ok(response.ok, `${response.url} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const root = await fetch(baseUrl);
  const html = await root.text();
  assert.equal(root.status, 200);
  assert.match(html, /<title>Coding Agent Console<\/title>/);
  const assetPath = html.match(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/)?.[1];
  assert.ok(assetPath, "No Next.js asset was found in the page.");
  const asset = await fetch(new URL(assetPath, parsedBase.origin));
  assert.equal(asset.status, 200);

  const login = await fetch(appUrl("api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(password ? { password } : {})
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") || "";
  assert.match(setCookie, /^coding_agent_console_session=/);
  assert.ok(setCookie.includes(`Path=${expectedCookiePath};`), `Unexpected cookie path: ${setCookie}`);
  const cookie = setCookie.split(";", 1)[0];

  const bootstrap = await responseJson(await fetch(appUrl("api/bootstrap"), {
    headers: { cookie }
  }));
  assert.equal(bootstrap.authenticated, true);
  assert.equal(bootstrap.providers?.codex?.provider, "codex");
  assert.equal(bootstrap.providers?.cursor?.provider, "cursor");

  const wsUrl = appUrl("ws");
  wsUrl.protocol = parsedBase.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl, { headers: { cookie, origin: parsedBase.origin } });
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for provider WebSocket snapshot.")), 15_000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "agent:snapshot") {
        clearTimeout(timeout);
        resolve();
      }
    });
    ws.on("error", reject);
  });
  assert.ok(messages.some((message) => message.type === "gateway:snapshot"));
  assert.ok(messages.some((message) => message.type === "queue:snapshot" && Array.isArray(message.snapshot?.items)));
  assert.ok(messages.some((message) => message.type === "agent:snapshot" && message.providers?.cursor));
  ws.close();

  console.log(JSON.stringify({
    rootStatus: root.status,
    assetStatus: asset.status,
    cookiePath: expectedCookiePath,
    codex: { version: bootstrap.providers.codex.version, status: bootstrap.providers.codex.status },
    cursor: { version: bootstrap.providers.cursor.version, status: bootstrap.providers.cursor.status },
    websocket: "agent:snapshot and queue:snapshot received"
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
