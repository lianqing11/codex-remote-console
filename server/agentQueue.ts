import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GitDiffResult } from "./gitDiff";
import { isAgentProviderId, type AgentProviderId } from "./types";
import type { AgentQueueEnqueueInput, AgentQueueItem, AgentQueueSnapshot, AgentQueueStatus, AgentQueueThreadState } from "./queueTypes";

export type { AgentQueueEnqueueInput, AgentQueueItem, AgentQueueSnapshot, AgentQueueStatus, AgentQueueThreadState };

type QueueRow = {
  id: string;
  provider: string;
  thread_key: string;
  thread_id: string;
  text: string;
  cwd: string;
  thread_params_json: string;
  turn_params_json: string;
  status: string;
  run_id: string | null;
  attempts: number;
  last_error: string | null;
  base_tree: string | null;
  diff_json: string | null;
  created_at: number;
  updated_at: number;
};

type ThreadRow = {
  thread_key: string;
  paused: number;
  reason: string | null;
  updated_at: number;
};

function nowSeconds() {
  return Date.now() / 1_000;
}

function parseRecord(value: string) {
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseDiff(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as GitDiffResult;
  } catch {
    return null;
  }
}

function rowToItem(row: QueueRow): AgentQueueItem {
  return {
    id: row.id,
    provider: row.provider as AgentProviderId,
    threadKey: row.thread_key,
    threadId: row.thread_id,
    text: row.text,
    cwd: row.cwd,
    threadParams: parseRecord(row.thread_params_json),
    turnParams: parseRecord(row.turn_params_json),
    status: row.status as AgentQueueStatus,
    runId: row.run_id,
    attempts: row.attempts,
    lastError: row.last_error,
    baseTree: row.base_tree,
    diff: parseDiff(row.diff_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToThread(row: ThreadRow): AgentQueueThreadState {
  return {
    threadKey: row.thread_key,
    paused: Boolean(row.paused),
    reason: row.reason,
    updatedAt: row.updated_at
  };
}

function defaultDatabasePath() {
  const root = process.env.CODING_AGENT_CONSOLE_STATE_DIR?.trim()
    || path.join(homedir(), ".local", "share", "coding-agent-console");
  return path.join(root, "queue.sqlite");
}

export class AgentQueueStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(databasePath = defaultDatabasePath()) {
    this.databasePath = databasePath;
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(databasePath), 0o700);
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS queue_items_thread_order ON queue_items(thread_key, created_at, id);
      CREATE INDEX IF NOT EXISTS queue_items_active_run ON queue_items(provider, thread_id, run_id, status);
      CREATE TABLE IF NOT EXISTS queue_threads (
        thread_key TEXT PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        updated_at REAL NOT NULL
      );
    `);
    migrateQueueProviderConstraint(this.db);
    chmodSync(databasePath, 0o600);
    this.cleanup();
  }

  close() {
    this.db.close();
  }

  private cleanup() {
    const cutoff = nowSeconds() - 7 * 24 * 60 * 60;
    this.db.prepare("DELETE FROM queue_items WHERE status IN ('completed', 'cancelled') AND updated_at < ?").run(cutoff);
  }

  snapshot(): AgentQueueSnapshot {
    const rows = this.db.prepare("SELECT * FROM queue_items ORDER BY created_at ASC, id ASC LIMIT 500").all() as QueueRow[];
    const threads = this.db.prepare("SELECT * FROM queue_threads ORDER BY thread_key ASC").all() as ThreadRow[];
    return { items: rows.map(rowToItem), threads: threads.map(rowToThread) };
  }

  enqueue(input: AgentQueueEnqueueInput) {
    const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : nowSeconds();
    const updatedAt = nowSeconds();
    this.db.prepare(`
      INSERT OR IGNORE INTO queue_items (
        id, provider, thread_key, thread_id, text, cwd, thread_params_json, turn_params_json,
        status, run_id, attempts, last_error, base_tree, diff_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, NULL, ?, ?)
    `).run(
      input.id,
      input.provider,
      input.threadKey,
      input.threadId,
      input.text,
      input.cwd,
      JSON.stringify(input.threadParams || {}),
      JSON.stringify(input.turnParams || {}),
      createdAt,
      updatedAt
    );
    this.db.prepare(`
      INSERT OR IGNORE INTO queue_threads(thread_key, paused, reason, updated_at) VALUES (?, 0, NULL, ?)
    `).run(input.threadKey, updatedAt);
    return this.get(input.id)!;
  }

  get(id: string) {
    const row = this.db.prepare("SELECT * FROM queue_items WHERE id = ?").get(id) as QueueRow | undefined;
    return row ? rowToItem(row) : null;
  }

  nextQueued(threadKey: string) {
    const row = this.db.prepare(`
      SELECT * FROM queue_items WHERE thread_key = ? AND status = 'queued'
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(threadKey) as QueueRow | undefined;
    return row ? rowToItem(row) : null;
  }

  activeItem(provider: AgentProviderId, threadId: string, runId?: string | null) {
    let row = runId
      ? this.db.prepare(`
          SELECT * FROM queue_items
          WHERE provider = ? AND thread_id = ? AND run_id = ? AND status IN ('dispatching', 'running', 'waiting_for_input')
          ORDER BY updated_at DESC LIMIT 1
        `).get(provider, threadId, runId) as QueueRow | undefined
      : this.db.prepare(`
          SELECT * FROM queue_items
          WHERE provider = ? AND thread_id = ? AND status IN ('dispatching', 'running', 'waiting_for_input')
          ORDER BY updated_at DESC LIMIT 1
        `).get(provider, threadId) as QueueRow | undefined;
    // Some providers can emit a terminal event before their start request has
    // returned the run id. In that narrow window the durable item is still
    // dispatching with a null run_id, so associate the event with that item.
    if (!row && runId) {
      row = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE provider = ? AND thread_id = ? AND run_id IS NULL AND status = 'dispatching'
        ORDER BY updated_at DESC LIMIT 1
      `).get(provider, threadId) as QueueRow | undefined;
    }
    return row ? rowToItem(row) : null;
  }

  runnableThreadKeys() {
    const rows = this.db.prepare(`
      SELECT DISTINCT qi.thread_key
      FROM queue_items qi
      LEFT JOIN queue_threads qt ON qt.thread_key = qi.thread_key
      WHERE qi.status = 'queued' AND COALESCE(qt.paused, 0) = 0
    `).all() as Array<{ thread_key: string }>;
    return rows.map((row) => row.thread_key);
  }

  threadState(threadKey: string) {
    const row = this.db.prepare("SELECT * FROM queue_threads WHERE thread_key = ?").get(threadKey) as ThreadRow | undefined;
    return row ? rowToThread(row) : { threadKey, paused: false, reason: null, updatedAt: 0 };
  }

  setThreadPaused(threadKey: string, paused: boolean, reason: string | null = null) {
    const updatedAt = nowSeconds();
    this.db.prepare(`
      INSERT INTO queue_threads(thread_key, paused, reason, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(threadKey, paused ? 1 : 0, paused ? reason : null, updatedAt);
    return this.threadState(threadKey);
  }

  markDispatching(id: string) {
    this.db.prepare(`
      UPDATE queue_items SET status = 'dispatching', attempts = attempts + 1, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(nowSeconds(), id);
    return this.get(id);
  }

  markRunning(id: string, runId: string) {
    this.db.prepare(`
      UPDATE queue_items SET status = 'running', run_id = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'
    `).run(runId, nowSeconds(), id);
    return this.get(id);
  }

  setBaseTree(id: string, baseTree: string | null) {
    this.db.prepare("UPDATE queue_items SET base_tree = ?, updated_at = ? WHERE id = ?").run(baseTree, nowSeconds(), id);
    return this.get(id);
  }

  setDiff(id: string, diff: GitDiffResult) {
    this.db.prepare("UPDATE queue_items SET diff_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(diff), nowSeconds(), id);
    return this.get(id);
  }

  setStatus(id: string, status: AgentQueueStatus, options: { error?: string | null; diff?: GitDiffResult | null } = {}) {
    this.db.prepare(`
      UPDATE queue_items SET status = ?, last_error = ?, diff_json = COALESCE(?, diff_json), updated_at = ? WHERE id = ?
    `).run(status, options.error ?? null, options.diff ? JSON.stringify(options.diff) : null, nowSeconds(), id);
    return this.get(id);
  }

  retry(id: string) {
    const item = this.get(id);
    if (!item || !["failed", "cancelled", "needs_review"].includes(item.status)) return item;
    this.db.prepare(`
      UPDATE queue_items SET status = 'queued', run_id = NULL, last_error = NULL, base_tree = NULL, diff_json = NULL, updated_at = ? WHERE id = ?
    `).run(nowSeconds(), id);
    this.setThreadPaused(item.threadKey, false);
    return this.get(id);
  }

  cancel(id: string) {
    const item = this.get(id);
    if (!item) return null;
    if (["running", "waiting_for_input", "dispatching"].includes(item.status)) {
      throw new Error("Stop the active run before cancelling this queue item.");
    }
    if (item.status !== "completed") this.setStatus(id, "cancelled");
    return this.get(id);
  }

  clearThread(threadKey: string) {
    this.db.prepare(`
      UPDATE queue_items SET status = 'cancelled', updated_at = ?
      WHERE thread_key = ? AND status IN ('queued', 'failed', 'needs_review')
    `).run(nowSeconds(), threadKey);
    return this.snapshot();
  }

  recoverInterrupted() {
    const interrupted = this.db.prepare(`
      SELECT DISTINCT thread_key FROM queue_items WHERE status IN ('dispatching', 'running', 'waiting_for_input')
    `).all() as Array<{ thread_key: string }>;
    this.db.prepare(`
      UPDATE queue_items SET status = 'needs_review', last_error = 'Service restarted while this task may have been running.', updated_at = ?
      WHERE status IN ('dispatching', 'running', 'waiting_for_input')
    `).run(nowSeconds());
    for (const row of interrupted) this.setThreadPaused(row.thread_key, true, "Interrupted by service restart; review before retrying.");
    return interrupted.map((row) => row.thread_key);
  }
}

type AgentQueueDependencies = {
  execute: (item: AgentQueueItem) => Promise<{ runId: string }>;
  createBaseline?: (item: AgentQueueItem) => Promise<string | null>;
  createDiff?: (item: AgentQueueItem) => Promise<GitDiffResult | null>;
};

type QueueSubscriber = (event: { type: "queue:snapshot"; snapshot: AgentQueueSnapshot }) => void;

export class AgentQueue {
  private readonly subscribers = new Set<QueueSubscriber>();
  private readonly activeThreads = new Set<string>();
  private readonly drainingThreads = new Set<string>();
  private readonly scheduledThreads = new Set<string>();
  private started = false;
  private stopped = false;

  constructor(readonly store: AgentQueueStore, private readonly dependencies: AgentQueueDependencies) {}

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.store.recoverInterrupted();
    this.emit();
    for (const threadKey of this.store.runnableThreadKeys()) this.kick(threadKey);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.store.close();
  }

  subscribe(callback: QueueSubscriber) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  snapshot() {
    return this.store.snapshot();
  }

  enqueue(input: AgentQueueEnqueueInput) {
    validateEnqueue(input);
    const item = this.store.enqueue(input);
    this.emit();
    this.kick(item.threadKey);
    return item;
  }

  cancel(id: string) {
    const item = this.store.cancel(id);
    this.emit();
    return item;
  }

  clearThread(threadKey: string) {
    const snapshot = this.store.clearThread(threadKey);
    this.emit(snapshot);
    return snapshot;
  }

  retry(id: string) {
    const item = this.store.retry(id);
    this.emit();
    if (item) this.kick(item.threadKey);
    return item;
  }

  pauseThread(threadKey: string, reason = "Paused by user.") {
    const state = this.store.setThreadPaused(threadKey, true, reason);
    this.emit();
    return state;
  }

  resumeThread(threadKey: string) {
    const state = this.store.setThreadPaused(threadKey, false);
    this.emit();
    this.kick(threadKey);
    return state;
  }

  handleProviderStarted(provider: AgentProviderId, threadId: string) {
    this.activeThreads.add(`${provider}:${threadId}`);
  }

  async handleProviderTerminal(provider: AgentProviderId, threadId: string, runId: string | null, status: string, message?: string) {
    const threadKey = `${provider}:${threadId}`;
    this.activeThreads.delete(threadKey);
    const item = this.store.activeItem(provider, threadId, runId);
    if (!item) {
      if (status === "completed") this.kick(threadKey);
      return;
    }

    const completed = status === "completed";
    const cancelled = status === "cancelled" || status === "interrupted";
    const diffPromise = completed && this.dependencies.createDiff && item.baseTree
      ? this.dependencies.createDiff(item).catch(() => null)
      : null;
    this.store.setStatus(item.id, completed ? "completed" : cancelled ? "cancelled" : "failed", {
      error: completed ? null : message || `Agent run ended with ${status}.`
    });
    this.emit();
    if (completed) this.kick(threadKey);

    // Computing a post-turn Git tree can be expensive on large/shared
    // workspaces. Start it at terminal notification time, but never hold up the
    // terminal state or the next queued turn. The resulting diff is best-effort
    // and appears in a later queue snapshot when it is ready.
    if (diffPromise) {
      void diffPromise.then((diff) => {
        if (!diff || this.stopped) return;
        const current = this.store.get(item.id);
        if (!current || !["completed", "failed", "cancelled"].includes(current.status)) return;
        this.store.setDiff(item.id, diff);
        this.emit();
      });
    }
  }

  handleWaitingForInput(provider: AgentProviderId, threadId: string, waiting: boolean) {
    const item = this.store.activeItem(provider, threadId);
    if (!item) return;
    this.store.setStatus(item.id, waiting ? "waiting_for_input" : "running");
    this.emit();
  }

  handleGatewayLost(provider: AgentProviderId, message = "Provider disconnected.") {
    const items = this.store.snapshot().items.filter((item) => (
      item.provider === provider && ["dispatching", "running", "waiting_for_input"].includes(item.status)
    ));
    if (!items.length) return;
    for (const item of items) {
      this.activeThreads.delete(item.threadKey);
      this.store.setStatus(item.id, "needs_review", { error: message });
      this.store.setThreadPaused(item.threadKey, true, "Provider disconnected; review before retrying.");
    }
    this.emit();
  }

  private kick(threadKey: string) {
    if (this.scheduledThreads.has(threadKey)) return;
    this.scheduledThreads.add(threadKey);
    queueMicrotask(() => {
      this.scheduledThreads.delete(threadKey);
      void this.drain(threadKey);
    });
  }

  private async drain(threadKey: string) {
    if (this.drainingThreads.has(threadKey) || this.activeThreads.has(threadKey)) return;
    if (this.store.threadState(threadKey).paused) return;
    const queued = this.store.nextQueued(threadKey);
    if (!queued) return;

    this.drainingThreads.add(threadKey);
    try {
      let item = this.store.markDispatching(queued.id);
      if (!item) return;
      this.emit();

      // Start the Git baseline and provider dispatch together. Baseline capture
      // is only for best-effort per-turn Changes metadata; it must never delay
      // turn/start. Persist it later only while the task is still active.
      const baselinePromise = this.dependencies.createBaseline && item.cwd
        ? this.dependencies.createBaseline(item).catch(() => null)
        : null;
      if (baselinePromise) {
        void baselinePromise.then((baseTree) => {
          if (!baseTree || this.stopped) return;
          const current = this.store.get(item.id);
          if (!current || !["dispatching", "running", "waiting_for_input"].includes(current.status)) return;
          this.store.setBaseTree(item.id, baseTree);
          this.emit();
        });
      }

      const result = await this.dependencies.execute(item);
      if (!result.runId) throw new Error("Agent provider accepted the task without returning a run id.");
      this.activeThreads.add(threadKey);
      this.store.markRunning(item.id, result.runId);
      this.emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setStatus(queued.id, "failed", { error: message });
      this.emit();
    } finally {
      this.drainingThreads.delete(threadKey);
    }
  }

  private emit(snapshot = this.store.snapshot()) {
    const event = { type: "queue:snapshot" as const, snapshot };
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

function migrateQueueProviderConstraint(db: DatabaseSync) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'queue_items'").get() as { sql?: string } | undefined;
  if (!row?.sql?.includes("CHECK (provider IN")) return;
  db.exec(`
    ALTER TABLE queue_items RENAME TO queue_items_legacy;
    CREATE TABLE queue_items (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
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
    INSERT INTO queue_items SELECT * FROM queue_items_legacy;
    DROP TABLE queue_items_legacy;
    CREATE INDEX IF NOT EXISTS queue_items_thread_order ON queue_items(thread_key, created_at, id);
    CREATE INDEX IF NOT EXISTS queue_items_active_run ON queue_items(provider, thread_id, run_id, status);
  `);
}

function validateEnqueue(input: AgentQueueEnqueueInput) {
  if (!/^queued-[A-Za-z0-9._:-]+$/.test(input.id) || input.id.length > 160) throw new Error("Invalid queue id.");
  if (!isAgentProviderId(input.provider)) throw new Error("Unsupported queue provider.");
  if (input.threadKey !== `${input.provider}:${input.threadId}`) throw new Error("Queue thread identity mismatch.");
  if (!input.threadId || input.threadId.length > 200) throw new Error("A valid thread id is required.");
  if (!input.text.trim() || input.text.length > 100_000) throw new Error("Queue text must be between 1 and 100000 characters.");
  if (!path.isAbsolute(input.cwd)) throw new Error("Queue cwd must be an absolute path.");
}
