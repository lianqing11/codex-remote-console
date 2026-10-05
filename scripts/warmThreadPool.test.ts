import assert from "node:assert/strict";
import { WarmThreadPool, requestWithWarmPool } from "../server/codex/warmThreadPool";

const pool = new WarmThreadPool(3);
assert.deepEqual(pool.touch("a"), []);
assert.deepEqual(pool.touch("b"), []);
assert.deepEqual(pool.touch("c"), []);
assert.deepEqual(pool.ids(), ["a", "b", "c"]);
assert.deepEqual(pool.touch("a"), []);
assert.deepEqual(pool.ids(), ["b", "c", "a"]);
assert.deepEqual(pool.touch("d"), ["b"]);
assert.deepEqual(pool.ids(), ["c", "a", "d"]);
pool.remove("a");
assert.deepEqual(pool.ids(), ["c", "d"]);
pool.clear();
assert.deepEqual(pool.ids(), []);

type Call = { method: string; params?: unknown };
const calls: Call[] = [];
const loaded = new Set<string>(["warm-1"]);

const gateway = {
  async request(method: string, params?: unknown) {
    calls.push({ method, params });
    if (method === "thread/loaded/list") return { data: [...loaded], nextCursor: null };
    if (method === "thread/read") {
      return {
        thread: {
          id: (params as { threadId: string }).threadId,
          modelProvider: "openai",
          cwd: "/tmp",
          turns: []
        }
      };
    }
    if (method === "thread/resume") {
      const threadId = (params as { threadId: string }).threadId;
      loaded.add(threadId);
      return {
        thread: { id: threadId, modelProvider: "openai", cwd: "/tmp", turns: [] },
        model: "gpt-test",
        modelProvider: "openai"
      };
    }
    if (method === "thread/unsubscribe") {
      loaded.delete((params as { threadId: string }).threadId);
      return { status: "unsubscribed" };
    }
    if (method === "thread/start") {
      return { thread: { id: "new-1", modelProvider: "openai", cwd: "/tmp", turns: [] } };
    }
    return {};
  }
};

const warmPool = new WarmThreadPool(2);

async function main() {
  calls.length = 0;
  const warmHit = await requestWithWarmPool(gateway, warmPool, "thread/resume", {
    threadId: "warm-1",
    excludeTurns: true,
    model: "gpt-test"
  });
  assert.equal((warmHit as { thread: { id: string } }).thread.id, "warm-1");
  assert.ok(calls.some((call) => call.method === "thread/read"));
  assert.ok(!calls.some((call) => call.method === "thread/resume"));
  assert.deepEqual(warmPool.ids(), ["warm-1"]);

  calls.length = 0;
  await requestWithWarmPool(gateway, warmPool, "thread/resume", {
    threadId: "cold-1",
    excludeTurns: true
  });
  assert.ok(calls.some((call) => call.method === "thread/resume"));
  assert.deepEqual(warmPool.ids(), ["warm-1", "cold-1"]);

  calls.length = 0;
  await requestWithWarmPool(gateway, warmPool, "thread/start", {});
  assert.ok(calls.some((call) => call.method === "thread/unsubscribe"));
  assert.deepEqual(
    calls
      .filter((call) => call.method === "thread/unsubscribe")
      .map((call) => (call.params as { threadId: string }).threadId),
    ["warm-1"]
  );
  assert.deepEqual(warmPool.ids(), ["cold-1", "new-1"]);

  calls.length = 0;
  await requestWithWarmPool(gateway, warmPool, "thread/resume", {
    threadId: "cold-1",
    forceResume: true,
    approvalPolicy: "never"
  });
  assert.ok(calls.some((call) => call.method === "thread/resume"));
  const forced = calls.find((call) => call.method === "thread/resume");
  assert.equal((forced?.params as { forceResume?: boolean } | undefined)?.forceResume, undefined);
  assert.equal((forced?.params as { approvalPolicy?: string }).approvalPolicy, "never");

  const fastPool = new WarmThreadPool(2);
  const settings = { threadId: "fast", excludeTurns: true, reuseIfUnchanged: true,
    model: "gpt-test", approvalPolicy: "never", sandbox: "read-only", config: { a: 1, b: 2 } };
  await requestWithWarmPool(gateway, fastPool, "thread/resume", settings);
  await requestWithWarmPool(gateway, fastPool, "turn/start", { threadId: "fast", input: [], model: "gpt-test", approvalPolicy: "never", effort: "medium" });
  calls.length = 0;
  await requestWithWarmPool(gateway, fastPool, "thread/resume", { ...settings, config: { b: 2, a: 1 } });
  assert.equal(calls.length, 0, "unchanged settings need no resume, read, or list RPC");
  for (const change of [{ model: "other" }, { approvalPolicy: "on-request" }, { sandbox: "workspace-write" }, { serviceTier: "priority" }]) {
    calls.length = 0;
    await requestWithWarmPool(gateway, fastPool, "thread/resume", { ...settings, ...change });
    assert.ok(calls.some((call) => call.method === "thread/resume"), "changed settings must be applied");
    assert.equal((calls.find((call) => call.method === "thread/resume")?.params as any).reuseIfUnchanged, undefined);
    await requestWithWarmPool(gateway, fastPool, "thread/resume", settings);
  }
  await requestWithWarmPool(gateway, fastPool, "turn/start", { threadId: "fast", model: "override", input: [] });
  calls.length = 0;
  await requestWithWarmPool(gateway, fastPool, "thread/resume", settings);
  assert.ok(calls.some((call) => call.method === "thread/resume"), "turn overrides invalidate settings");
  calls.length = 0;
  await requestWithWarmPool(gateway, fastPool, "thread/resume", { ...settings, forceResume: true });
  assert.ok(calls.some((call) => call.method === "thread/resume"), "explicit force always wins");
  fastPool.clear();
  calls.length = 0;
  await requestWithWarmPool(gateway, fastPool, "thread/resume", settings);
  assert.ok(calls.some((call) => call.method === "thread/resume"), "restart clears settings cache");
  fastPool.remove("fast");
  assert.equal(fastPool.matchesResume("fast", settings), false);
  const failing = { async request() { throw new Error("resume failed"); } };
  await assert.rejects(requestWithWarmPool(failing, fastPool, "thread/resume", settings), /resume failed/);
  assert.equal(fastPool.matchesResume("fast", settings), false);
  await requestWithWarmPool(gateway, fastPool, "thread/resume", settings);
  await assert.rejects(requestWithWarmPool(failing, fastPool, "thread/resume", { ...settings, model: "changed" }), /resume failed/);
  assert.equal(fastPool.matchesResume("fast", settings), false, "failed changed resume invalidates old settings too");
  await requestWithWarmPool(gateway, fastPool, "thread/resume", settings);
  fastPool.touch("evict-1");
  fastPool.touch("evict-2");
  assert.equal(fastPool.matchesResume("fast", settings), false, "eviction clears remembered settings");
  const actionPool = new WarmThreadPool(5);
  calls.length = 0;
  await requestWithWarmPool(gateway, actionPool, "thread/compact/start", { threadId: "unopened" });
  assert.deepEqual(calls.filter(call => call.method !== "thread/loaded/list").map(call => call.method), ["thread/resume", "thread/compact/start"], "thread actions load a read-only session first");
  calls.length = 0;
  await requestWithWarmPool(gateway, actionPool, "thread/name/set", { threadId: "unopened", name: "x" });
  assert.deepEqual(calls.map(call => call.method), ["thread/name/set"], "an already loaded session is not resumed again");
  console.log("warmThreadPool.test.ts: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
