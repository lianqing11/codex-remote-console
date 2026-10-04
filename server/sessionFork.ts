import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { canonicalClaudeTurns, type ClaudeQueuedTurn } from "../app/claudeTurnIdentity";
import type { AgentProviderId } from "./types";

/** Also used for enqueue/start: an idle check and snapshot form one operation. */
export class SessionLocks {
  private pending = new Map<string, Promise<unknown>>();
  async run<T>(key: string, action: () => Promise<T> | T): Promise<T> {
    const before = this.pending.get(key) || Promise.resolve();
    const next = before.catch(() => {}).then(action);
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}

type ForkRow = { request_id: string; provider: AgentProviderId; source_id: string; turn_id: string | null; target_id: string | null; created_at: number; inherited_runtime: string | null; snapshot_json: string | null; archived: number };
type Request = (provider: AgentProviderId, method: string, params: Record<string, unknown>) => Promise<any>;

export class SessionForks {
  readonly locks = new SessionLocks();
  private db: DatabaseSync;
  constructor(file = path.join(process.env.CODEX_WEB_FORK_STATE_DIR || path.join(process.cwd(), ".codex_web"), "forks.sqlite")) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS forks (
      request_id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_id TEXT NOT NULL,
      turn_id TEXT, target_id TEXT, created_at REAL NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS forks_target ON forks(provider,target_id);`);
    const columns = this.db.prepare("PRAGMA table_info(forks)").all() as { name: string }[];
    if (!columns.some(column => column.name === "inherited_runtime")) this.db.exec("ALTER TABLE forks ADD COLUMN inherited_runtime TEXT");
    if (!columns.some(column => column.name === "snapshot_json")) this.db.exec("ALTER TABLE forks ADD COLUMN snapshot_json TEXT");
    if (!columns.some(column => column.name === "archived")) this.db.exec("ALTER TABLE forks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  archived(provider: AgentProviderId, id: string, archived: boolean) {
    this.db.prepare("UPDATE forks SET archived=? WHERE provider=? AND target_id=?").run(archived ? 1 : 0, provider, id);
  }
  async list(provider: AgentProviderId, input: Record<string, any>, result: any, request: Request) {
    // Codex omits a native fork with no newly submitted user message from thread/list.
    // The journal keeps such deliberately idle branches discoverable across restarts.
    if (provider !== "codex" || input.cursor || !Array.isArray(result?.data)) return this.enrich(provider, result);
    const known = new Set(result.data.map((thread: any) => thread.id));
    const rows = this.db.prepare("SELECT * FROM forks WHERE provider=? AND target_id IS NOT NULL AND archived=? ORDER BY created_at DESC LIMIT 100").all(provider, input.archived ? 1 : 0) as ForkRow[];
    const missing = await Promise.all(rows.filter(row => !known.has(row.target_id)).map(async row => {
      try {
        const read = await request(provider, "thread/read", { threadId: row.target_id, includeTurns: false });
        const saved = row.snapshot_json ? JSON.parse(row.snapshot_json) : {};
        const thread = { ...saved, ...read.thread, name: read.thread.name || saved.name, preview: read.thread.preview || saved.preview, empty: false };
        const nativeArchived = typeof thread.path === "string" && /[/\\]archived_sessions[/\\]/.test(thread.path);
        if (nativeArchived !== Boolean(input.archived)) return null;
        const roots = Array.isArray(input.cwd) ? input.cwd : input.cwd ? [input.cwd] : [];
        if (roots.length && !roots.includes(thread.cwd)) return null;
        if (input.searchTerm && !`${thread.name || ""} ${thread.preview || ""}`.toLowerCase().includes(String(input.searchTerm).toLowerCase())) return null;
        return thread;
      } catch { return null; }
    }));
    return this.enrich(provider, { ...result, data: [...result.data, ...missing.filter(Boolean)] });
  }
  applied(provider: AgentProviderId, id: string) {
    this.db.prepare("UPDATE forks SET inherited_runtime=NULL WHERE provider=? AND target_id=?").run(provider, id);
  }
  close() { this.db.close(); }
  enrich(provider: AgentProviderId, response: any): any {
    if (!response || typeof response !== "object") return response;
    const decorate = (thread: any) => {
      if (!thread || typeof thread !== "object") return thread;
      const id = thread.nativeId || thread.sessionId || thread.id;
      if (typeof id !== "string") return thread;
      const row = this.db.prepare("SELECT * FROM forks WHERE provider=? AND target_id=?").get(provider, id) as ForkRow | undefined;
      return row ? { ...thread, forkedFromId: row.source_id, forkedAtTurnId: row.turn_id, forkedAt: row.created_at, empty: false, ...(row.inherited_runtime ? { runtime: { ...thread.runtime, ...JSON.parse(row.inherited_runtime) } } : {}) } : thread;
    };
    const next = { ...response };
    for (const key of ["thread", "session"]) if (next[key]) next[key] = decorate(next[key]);
    for (const key of ["data", "sessions", "threads"]) if (Array.isArray(next[key])) next[key] = next[key].map(decorate);
    return next;
  }
  async fork(provider: AgentProviderId, input: Record<string, unknown>, request: Request, busy: (key: string) => boolean, queueRuns: (key: string) => ClaudeQueuedTurn[] = () => []) {
    const sourceId = String(input.threadId || input.sessionId || "");
    const requestId = String(input.forkRequestId || "");
    const turnId = input.lastTurnId == null ? null : String(input.lastTurnId);
    if (!/^[\w:-]{1,200}$/.test(sourceId) || !/^[\w:-]{8,200}$/.test(requestId)) throw new Error("A valid source session and fork request ID are required.");
    if (input.ephemeral || input.beforeTurnId || input.path) throw new Error("Use the persistent fork interface with an optional lastTurnId.");
    if (turnId && provider === "cursor") throw new Error("Historical turn forks are not supported by Cursor.");
    return this.locks.run(`${provider}:${sourceId}`, async () => {
      const prior = this.db.prepare("SELECT * FROM forks WHERE request_id=?").get(requestId) as ForkRow | undefined;
      if (prior && (prior.provider !== provider || prior.source_id !== sourceId || prior.turn_id !== turnId)) throw new Error("Fork request ID was already used for a different source.");
      if (prior?.target_id) return this.enrich(provider, await request(provider, "thread/read", { threadId: prior.target_id, sessionId: prior.target_id, includeTurns: true }));
      if (prior) throw new Error("This fork was interrupted before its result was saved. Check sessions before creating another fork.");
      if (busy(`${provider}:${sourceId}`)) throw new Error("Wait for this session's tasks and pending input to finish before forking.");
      const source = await request(provider, "thread/read", { threadId: sourceId, sessionId: sourceId, includeTurns: true });
      const thread = source.thread || source.session || source;
      const status = typeof thread.status === "object" ? thread.status.type : thread.status;
      if (["active", "running", "inProgress", "waiting_for_input"].includes(status)) throw new Error("Wait for the active session to finish before forking.");
      const turns: any[] = Array.isArray(thread.turns) ? thread.turns : [];
      const transcript = source.transcript || thread.transcript || [];
      if (!turns.some(t => t.items?.length) && !transcript.length) throw new Error("An empty session cannot be forked.");
      // The browser names Claude turns by console run ID where known; map back to the transcript turn.
      const turnIds = provider === "claude" ? canonicalClaudeTurns(turns, queueRuns(`${provider}:${sourceId}`)).map(t => t.id) : turns.map(t => t.id);
      const turn = turnId ? turns[turnIds.indexOf(turnId)] : null;
      if (turnId && (typeof turn?.status === "string" ? turn.status : turn?.status?.type) !== "completed") throw new Error("Select a completed turn in this session.");
      const sourceVersion = provider === "codex" && thread.path ? await stat(thread.path) : null;
      const createdAt = Date.now() / 1000;
      this.db.prepare("INSERT INTO forks (request_id,provider,source_id,turn_id,target_id,created_at) VALUES (?,?,?,?,NULL,?)").run(requestId, provider, sourceId, turnId, createdAt);
      let result: any;
      try {
        const title = `${thread.name || thread.title || thread.preview?.slice(0, 80) || "Session"} · fork`;
        result = await request(provider, "thread/fork", {
          threadId: sourceId, sessionId: sourceId, ...(turn ? { lastTurnId: turn.id } : {}),
          title, ephemeral: false, excludeTurns: false, deferGoalContinuation: true,
          // Never inherit the browser's unrelated global settings.
          ...(provider === "codex" ? {
            ...thread.runtime?.forkSettings,
            cwd: thread.cwd,
            ...(thread.runtime?.model ? { model: thread.runtime.model } : {}),
            ...(thread.runtime?.serviceTier ? { serviceTier: thread.runtime.serviceTier } : {}),
            config: { ...thread.runtime?.forkSettings?.config, ...(thread.runtime?.reasoningEffort ? { model_reasoning_effort: thread.runtime.reasoningEffort } : {}) }
          } : {})
        });
        const child = result.thread || result.session || result;
        const id = child.id || child.sessionId;
        if (!id || id === sourceId) throw new Error("Fork did not return an independent session ID.");
        if (sourceVersion) {
          const after = await stat(thread.path).catch(() => null);
          if (!after || sourceVersion.size !== after.size || sourceVersion.mtimeMs !== after.mtimeMs) {
            // This child was created by this request and has never been exposed or run.
            await request(provider, "thread/archive", { threadId: id });
            throw Object.assign(new Error("Codex source changed during fork. Retry when it is idle."), { forkSafeToRetry: true });
          }
        }
        // Commit before any optional naming/read operation or browser acknowledgement.
        this.db.prepare("UPDATE forks SET target_id=?,inherited_runtime=? WHERE request_id=?").run(id, thread.runtime ? JSON.stringify(thread.runtime) : null, requestId);
        if (provider === "codex") {
          await request(provider, "thread/name/set", { threadId: id, name: title }).catch(() => {});
          child.name = title;
          child.runtime = thread.runtime;
        }
        const { turns: _turns, transcript: _transcript, ...metadata } = child;
        this.db.prepare("UPDATE forks SET snapshot_json=? WHERE request_id=?").run(JSON.stringify(metadata), requestId);
      } catch (error) {
        // A failed native operation can have materialized a session. Keep the journal
        // reservation; retries must never silently create a second native session.
        if ((error as { forkSafeToRetry?: boolean })?.forkSafeToRetry) this.db.prepare("DELETE FROM forks WHERE request_id=? AND target_id IS NULL").run(requestId);
        throw error;
      }
      return this.enrich(provider, result);
    });
  }
}
