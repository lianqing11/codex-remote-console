/** Opt-in live smoke: creates independent native test sessions; never subscribes notifications. */
import "../server/loadLocalEnv";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StdioCodexGateway } from "../server/codex/stdioGateway";
import { ClaudeProvider } from "../server/providers/claude";
import { CursorProvider } from "../server/providers/cursor";
import { enrichCodexThreadRuntime } from "../server/codex/threadRuntime";
import { SessionForks } from "../server/sessionFork";

async function main() {
  if (!process.argv.includes("--live")) throw new Error("Pass --live to create billable short-text test sessions.");
  const root = await mkdtemp(path.join(tmpdir(), "fork-live-"));
  process.env.CODING_AGENT_CONSOLE_STATE_DIR = path.join(root, "state");
  process.env.CODEX_WEB_PROJECT_ROOTS = root;
  const forks = new SessionForks(path.join(root, "forks.sqlite"));
  const codex = new StdioCodexGateway(), claude = new ClaudeProvider(), cursor = new CursorProvider();
  const clients = { codex, claude, cursor };
  const request = async (provider: keyof typeof clients, method: string, params: any): Promise<any> => provider === "codex" ? enrichCodexThreadRuntime(method, await codex.request(method, params)) : clients[provider].handle(method, params);
  const reports: any[] = [];
  console.log(JSON.stringify({ workspace: root }));
  async function turn(provider: keyof typeof clients, id: string, text: string) {
    const client = clients[provider];
    let end!: (event: any) => void;
    const completed = new Promise<any>(resolve => { end = resolve; });
    let answer = "";
    const unsubscribe = client.subscribe((event: any) => {
      if (provider === "codex") {
        const msg = event.message;
        if (msg?.params?.threadId !== id) return;
        if (msg.method === "turn/completed") end(msg.params.turn);
      } else if (event.sessionId === id) {
        if (event.event === "status" && ["completed", "failed", "cancelled"].includes(event.status)) end(event);
        if (event.event === "assistant_text") answer += event.text || event.delta || "";
      }
    });
    const timeout = setTimeout(() => end({ status: "timeout" }), 150_000);
    try {
      await request(provider, "turn/start", { threadId: id, sessionId: id, input: [{ type: "text", text }], prompt: text, mode: "agent", ...(provider === "codex" ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } : {}) });
      const result = await completed;
      assert.equal(result.status, "completed", JSON.stringify(result));
      const read = await request(provider, "thread/read", { threadId: id, includeTurns: true });
      if (provider !== "cursor") {
        const turns = read.thread.turns;
        answer = turns.at(-1).items.filter((item: any) => item.type === "agentMessage").map((item: any) => item.text).join("\n");
      } else {
        const userIndex = read.transcript.findLastIndex((item: any) => item.event === "user_text");
        answer = read.transcript.slice(userIndex + 1).filter((item: any) => item.event === "assistant_text").map((item: any) => item.text).join("");
      }
      return { read, answer };
    } finally { clearTimeout(timeout); unsubscribe(); }
  }
  try {
    for (const provider of ["codex", "claude", "cursor"] as const) {
      if (process.env.FORK_SMOKE_PROVIDER && provider !== process.env.FORK_SMOKE_PROVIDER) continue;
      try {
        const started = await request(provider, "thread/start", { cwd: root, mode: "agent", ...(provider === "claude" ? { model: "sonnet", effort: "low" } : {}) });
        const id = started.thread?.id || started.session?.sessionId;
        assert.ok(id);
        const token = `apricot-${randomUUID().slice(0, 8)}`;
        const first = await turn(provider, id, `This is a short context test. Do not use tools or modify files. Remember the secret word ${token}. Reply only OK.`);
        const before = await request(provider, "thread/read", { threadId: id, includeTurns: true });
        const child = await forks.fork(provider, { threadId: id, forkRequestId: randomUUID() }, request, () => false);
        const childId = child.thread?.id || child.session?.sessionId;
        assert.notEqual(childId, id);
        if (provider === "codex") {
          assert.equal(child.approvalPolicy, "never");
          assert.equal(child.sandbox.type, "readOnly", "Fork inherits the applied sandbox rather than global defaults");
        }
        assert.deepEqual(await request(provider, "thread/read", { threadId: id, includeTurns: true }), before);
        const inherited = await turn(provider, childId, "What is the secret word? Reply only with it. Do not use tools.");
        assert.ok(inherited.answer.includes(token), `${provider} missing inherited context: ${inherited.answer}`);
        await turn(provider, id, "Change the secret word to parent-only-blue. Reply only OK. Do not use tools.");
        const independent = await turn(provider, childId, "What is the secret word now? Reply only with it. Do not use tools.");
        assert.ok(independent.answer.includes(token) && !independent.answer.includes("parent-only-blue"), independent.answer);
        await turn(provider, childId, "Change the secret word to branch-only-red. Reply only OK. Do not use tools.");
        const parent = await turn(provider, id, "What is the secret word now? Reply only with it. Do not use tools.");
        assert.ok(parent.answer.includes("parent-only-blue"), parent.answer);
        let historicalId: string | undefined;
        if (provider === "codex") {
          const historical = await forks.fork(provider, { threadId: id, lastTurnId: first.read.thread.turns[0].id, forkRequestId: randomUUID() }, request, () => false);
          assert.equal(historical.thread.turns.length, 1);
          historicalId = historical.thread.id;
          const truncated = await turn(provider, historicalId!, "What is the secret word? Reply only with it. Do not use tools.");
          assert.ok(truncated.answer.includes(token), truncated.answer);
        }
        const report = { provider, parentId: id, childId, historicalId, result: "passed", context: inherited.answer, independent: independent.answer, parent: parent.answer };
        reports.push(report); console.log(JSON.stringify(report));
      } catch (error) { const report = { provider, result: "failed", error: String(error) }; reports.push(report); console.log(JSON.stringify(report)); }
    }
    await writeFile(path.join(root, "results.json"), JSON.stringify(reports, null, 2));
    assert.ok(reports.every(r => r.result === "passed"), "Some live providers failed");
  } finally { codex.stop(); claude.stop(); cursor.stop(); forks.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
