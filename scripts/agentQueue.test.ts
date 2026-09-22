import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentQueue, AgentQueueStore, type AgentQueueEnqueueInput, type AgentQueueItem } from "../server/agentQueue";
import type { GitDiffResult } from "../server/gitDiff";

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function item(id: string, threadId: string, createdAt: number): AgentQueueEnqueueInput {
  return {
    id,
    provider: "cursor",
    threadKey: `cursor:${threadId}`,
    threadId,
    text: `prompt ${id}`,
    cwd: "/tmp",
    threadParams: { model: "auto", mode: "agent" },
    turnParams: { model: "auto", mode: "agent" },
    createdAt
  };
}

async function withQueue(run: (context: {
  queue: AgentQueue;
  store: AgentQueueStore;
  starts: AgentQueueItem[];
  databasePath: string;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-queue-test-"));
  const databasePath = path.join(root, "queue.sqlite");
  const starts: AgentQueueItem[] = [];
  const store = new AgentQueueStore(databasePath);
  const queue = new AgentQueue(store, {
    execute: async (queued) => {
      starts.push(queued);
      return { runId: `run-${queued.id}` };
    }
  });
  queue.start();
  try {
    await run({ queue, store, starts, databasePath });
  } finally {
    try {
      queue.stop();
    } catch {
      // A recovery test may close the first queue before shared cleanup.
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
await withQueue(async ({ queue, store, starts }) => {
  queue.enqueue(item("queued-a", "thread-1", 1));
  queue.enqueue(item("queued-b", "thread-1", 2));
  queue.enqueue(item("queued-b", "thread-1", 2));
  await waitFor(() => starts.length === 1, "first FIFO dispatch");
  assert.equal(starts[0].id, "queued-a");
  assert.equal(store.snapshot().items.length, 2, "duplicate enqueue id must be idempotent");
  assert.equal(store.get("queued-a")?.status, "running");
  assert.equal(store.get("queued-b")?.status, "queued");
  queue.start();
  assert.equal(store.get("queued-a")?.status, "running", "calling start twice must not recover a live queue");

  await queue.handleProviderTerminal("cursor", "thread-1", "run-queued-a", "completed");
  await waitFor(() => starts.length === 2, "second FIFO dispatch");
  assert.equal(starts[1].id, "queued-b");
  assert.equal(store.get("queued-a")?.status, "completed");
});

await withQueue(async ({ queue, starts }) => {
  queue.enqueue(item("queued-a", "thread-a", 1));
  queue.enqueue(item("queued-b", "thread-b", 2));
  await waitFor(() => starts.length === 2, "parallel per-thread dispatch");
  assert.deepEqual(new Set(starts.map((entry) => entry.threadId)), new Set(["thread-a", "thread-b"]));
});

{
  const root = await mkdtemp(path.join(tmpdir(), "agent-queue-baseline-parallel-"));
  const store = new AgentQueueStore(path.join(root, "queue.sqlite"));
  const starts: AgentQueueItem[] = [];
  let baselineStarted = false;
  let finishBaseline: ((tree: string) => void) | null = null;
  const queue = new AgentQueue(store, {
    createBaseline: async () => {
      baselineStarted = true;
      return await new Promise<string>((resolve) => {
        finishBaseline = resolve;
      });
    },
    execute: async (queued) => {
      starts.push(queued);
      return { runId: `run-${queued.id}` };
    }
  });
  queue.start();
  try {
    queue.enqueue(item("queued-parallel-baseline", "thread-parallel-baseline", 1));
    await waitFor(() => baselineStarted, "background baseline start");
    await waitFor(() => starts.length === 1, "provider start without baseline completion");
    assert.equal(store.get("queued-parallel-baseline")?.status, "running");
    assert.equal(store.get("queued-parallel-baseline")?.baseTree, null);

    const completeBaseline = finishBaseline as ((tree: string) => void) | null;
    assert.ok(completeBaseline, "baseline completion hook should be registered");
    completeBaseline("a".repeat(40));
    await waitFor(() => store.get("queued-parallel-baseline")?.baseTree === "a".repeat(40), "background baseline persistence");
    assert.equal(store.get("queued-parallel-baseline")?.status, "running");
  } finally {
    queue.stop();
    await rm(root, { recursive: true, force: true });
  }
}

{
  const root = await mkdtemp(path.join(tmpdir(), "agent-queue-diff-parallel-"));
  const store = new AgentQueueStore(path.join(root, "queue.sqlite"));
  const starts: AgentQueueItem[] = [];
  let diffStarted = false;
  let finishDiff: ((diff: GitDiffResult) => void) | null = null;
  const queue = new AgentQueue(store, {
    createDiff: async () => {
      diffStarted = true;
      return await new Promise<GitDiffResult>((resolve) => {
        finishDiff = resolve;
      });
    },
    execute: async (queued) => {
      starts.push(queued);
      return { runId: `run-${queued.id}` };
    }
  });
  queue.start();
  try {
    queue.enqueue(item("queued-parallel-diff-a", "thread-parallel-diff", 1));
    queue.enqueue(item("queued-parallel-diff-b", "thread-parallel-diff", 2));
    await waitFor(() => starts.length === 1, "first diff test dispatch");
    store.setBaseTree("queued-parallel-diff-a", "b".repeat(40));

    await queue.handleProviderTerminal("cursor", "thread-parallel-diff", "run-queued-parallel-diff-a", "completed");
    assert.equal(diffStarted, true);
    assert.equal(store.get("queued-parallel-diff-a")?.status, "completed");
    await waitFor(() => starts.length === 2, "next provider start without diff completion");

    const completeDiff = finishDiff as ((diff: GitDiffResult) => void) | null;
    assert.ok(completeDiff, "diff completion hook should be registered");
    completeDiff({
      root: "/tmp",
      branch: "main",
      status: "",
      diff: "",
      files: [],
      additions: 0,
      deletions: 0,
      hasChanges: false,
      baseTree: "b".repeat(40),
      currentTree: "c".repeat(40)
    });
    await waitFor(() => store.get("queued-parallel-diff-a")?.diff?.currentTree === "c".repeat(40), "background diff persistence");
  } finally {
    queue.stop();
    await rm(root, { recursive: true, force: true });
  }
}

await withQueue(async ({ queue, store, starts }) => {
  queue.enqueue(item("queued-fail", "thread-1", 1));
  queue.enqueue(item("queued-after", "thread-1", 2));
  await waitFor(() => starts.length === 1, "failed head dispatch");
  await queue.handleProviderTerminal("cursor", "thread-1", "run-queued-fail", "failed", "synthetic failure");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(starts.length, 1, "failure must leave later items queued");
  assert.equal(store.threadState("cursor:thread-1").paused, false);
  assert.equal(store.get("queued-fail")?.status, "failed");
  assert.equal(store.get("queued-after")?.status, "queued");

  queue.enqueue(item("queued-later", "thread-1", 3));
  await waitFor(() => starts.length === 2, "next enqueue continues the waiting FIFO item");
  assert.equal(starts[1].id, "queued-after");
});

await withQueue(async ({ queue, store, starts }) => {
  queue.enqueue(item("queued-stop", "thread-stop", 1));
  queue.enqueue(item("queued-rest", "thread-stop", 2));
  await waitFor(() => starts.length === 1, "running item before stop");
  await queue.handleProviderTerminal("cursor", "thread-stop", "run-queued-stop", "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(starts.length, 1, "stop must not start the next queued item");
  assert.equal(store.threadState("cursor:thread-stop").paused, false);
  assert.equal(store.get("queued-rest")?.status, "queued");

  queue.enqueue(item("queued-again", "thread-stop", 3));
  await waitFor(() => starts.length === 2, "next send continues leftover queue");
  assert.equal(starts[1].id, "queued-rest");
});

await withQueue(async ({ queue, store, starts, databasePath }) => {
  queue.enqueue(item("queued-recover", "thread-1", 1));
  await waitFor(() => starts.length === 1, "running item before restart");
  assert.equal(store.get("queued-recover")?.status, "running");
  queue.stop();

  const recoveredStore = new AgentQueueStore(databasePath);
  const recoveredQueue = new AgentQueue(recoveredStore, {
    execute: async () => {
      throw new Error("needs-review tasks must not replay automatically");
    }
  });
  recoveredQueue.start();
  assert.equal(recoveredStore.get("queued-recover")?.status, "needs_review");
  assert.equal(recoveredStore.threadState("cursor:thread-1").paused, true);
  recoveredQueue.stop();
});

{
  const root = await mkdtemp(path.join(tmpdir(), "agent-queue-fast-terminal-"));
  const store = new AgentQueueStore(path.join(root, "queue.sqlite"));
  let queue: AgentQueue;
  queue = new AgentQueue(store, {
    execute: async (queued) => {
      await queue.handleProviderTerminal("cursor", queued.threadId, `run-${queued.id}`, "completed");
      return { runId: `run-${queued.id}` };
    }
  });
  queue.start();
  try {
    queue.enqueue(item("queued-fast", "thread-fast", 1));
    await waitFor(() => store.get("queued-fast")?.status === "completed", "fast terminal event association");
    assert.equal(store.get("queued-fast")?.status, "completed");
  } finally {
    queue.stop();
    await rm(root, { recursive: true, force: true });
  }
}

await withQueue(async ({ queue, store }) => {
  await queue.handleProviderTerminal("cursor", "manual-only", null, "failed", "manual turn");
  assert.equal(store.threadState("cursor:manual-only").paused, false, "manual failure must not pause an empty queue");
});

await withQueue(async ({ queue, store, starts }) => {
  queue.enqueue(item("queued-head", "thread-lost", 1));
  await waitFor(() => starts.length === 1, "running item before gateway loss");
  queue.enqueue(item("queued-tail", "thread-lost", 2));
  queue.handleGatewayLost("cursor", "gateway down");
  assert.equal(store.get("queued-head")?.status, "needs_review");
  assert.equal(store.get("queued-tail")?.status, "queued");
  assert.equal(store.threadState("cursor:thread-lost").paused, true);
});

await withQueue(async ({ queue, store }) => {
  queue.enqueue({
    ...item("queued-claude", "thread-claude", 1),
    provider: "claude",
    threadKey: "claude:thread-claude",
    threadId: "thread-claude"
  });
  await waitFor(() => store.get("queued-claude")?.status === "running" || store.get("queued-claude")?.status === "completed" || Boolean(store.get("queued-claude")), "claude enqueue");
  assert.equal(store.get("queued-claude")?.provider, "claude");
});

{
  const root = await mkdtemp(path.join(tmpdir(), "agent-queue-migrate-"));
  const databasePath = path.join(root, "queue.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE queue_items (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'cursor')),
      thread_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      cwd TEXT NOT NULL,
      thread_params_json TEXT NOT NULL,
      turn_params_json TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      base_tree TEXT,
      diff_json TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  legacy.prepare(`INSERT INTO queue_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "queued-old", "codex", "codex:old", "old", "hello", "/tmp", "{}", "{}", "queued", null, 0, null, null, null, 1, 1
  );
  legacy.close();
  const store = new AgentQueueStore(databasePath);
  assert.equal(store.get("queued-old")?.provider, "codex");
  store.close();
  await rm(root, { recursive: true, force: true });
}

console.log("agent queue persistence and scheduling tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
