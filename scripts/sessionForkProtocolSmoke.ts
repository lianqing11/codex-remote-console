import "../server/loadLocalEnv";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

async function main() {
  const root = process.env.FORK_SMOKE_ROOT;
  if (!root) throw new Error("FORK_SMOKE_ROOT must point to independent live smoke fixtures.");
  const fixtures = JSON.parse(await readFile(path.join(root, "results.json"), "utf8"));
  const base = process.env.CODING_AGENT_CONSOLE_TEST_URL || "http://127.0.0.1:3042/codex-fork-preview/";
  const login = await fetch(new URL("api/auth/login", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const ws = new WebSocket(new URL("ws", base).href.replace(/^http/, "ws"), { headers: { cookie, origin: new URL(base).origin } });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const call = (input: any) => new Promise<any>((resolve, reject) => {
    const requestId = randomUUID();
    const timeout = setTimeout(() => { ws.off("message", handler); reject(new Error("Timed out")); }, 30000);
    const handler = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.requestId !== requestId) return;
      clearTimeout(timeout); ws.off("message", handler);
      if (message.ok) resolve(message.result); else reject(new Error(message.error));
    };
    ws.on("message", handler); ws.send(JSON.stringify({ ...input, requestId }));
  });
  const request = (provider: string, method: string, params: any) => call({ type: "agent:request", provider, method, params });
  try {
    const initialQueue = await call({ type: "queue:list" });
    for (const fixture of fixtures) {
      const provider = fixture.provider, source = fixture.parentId;
      if (provider !== "codex") await assert.rejects(request(provider, "thread/fork", { threadId: source, ephemeral: true }), /Temporary side sessions/);
      const params = { threadId: source, forkRequestId: randomUUID() };
      const [first, retry] = await Promise.all([request(provider, "thread/fork", params), request(provider, "thread/fork", params)]);
      const child = first.thread.id;
      assert.equal(child, retry.thread.id);
      assert.equal(first.thread.forkedFromId, source);
      const queueId = `queued-${randomUUID()}`, threadKey = `${provider}:${child}`;
      await call({ type: "queue:pause", threadKey });
      try {
        await call({ type: "queue:enqueue", item: { id: queueId, provider, threadId: child, threadKey, text: "Must stay paused; never execute.", cwd: root, threadParams: {}, turnParams: {}, createdAt: Date.now() / 1000 } });
        await assert.rejects(request(provider, "thread/fork", { threadId: child, forkRequestId: randomUUID() }), /tasks|pending input/);
        assert.equal((await call({ type: "queue:list" })).items.find((item: any) => item.id === queueId).status, "queued");
      } finally { await call({ type: "queue:cancel", queueId }); await call({ type: "queue:resume", threadKey }); }
      if (provider !== "codex") await assert.rejects(request(provider, "thread/fork", { threadId: child, lastTurnId: "invalid", forkRequestId: randomUUID() }), /Historical/);
      const grandchild = await request(provider, "thread/fork", { threadId: child, forkRequestId: randomUUID() });
      await request(provider, "thread/archive", { threadId: child });
      const read = await request(provider, "thread/read", { threadId: grandchild.thread.id, includeTurns: true });
      assert.equal(read.thread.forkedFromId, child);
      const list = await request(provider, "thread/list", { limit: 100 });
      assert.ok(list.data.some((thread: any) => (thread.id || thread.sessionId) === grandchild.thread.id));
      console.log(JSON.stringify({ provider, idempotency: "passed", queuedGuard: "passed", parentArchive: "passed", independentChild: grandchild.thread.id }));
    }
    const finalQueue = await call({ type: "queue:list" });
    assert.equal(finalQueue.items.filter((item: any) => ["running", "dispatching", "waiting_for_input", "completed"].includes(item.status)).length, initialQueue.items.filter((item: any) => ["running", "dispatching", "waiting_for_input", "completed"].includes(item.status)).length, "Forking does not execute a task");
  } finally { ws.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
