export const DEFAULT_WARM_THREAD_LIMIT = 10;

type GatewayLike = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

/** MRU-ordered warm thread ids (most recent at the end). */
export class WarmThreadPool {
  private order: string[] = [];
  private resumeSettings = new Map<string, string>();

  matchesResume(threadId: string, params: unknown) {
    return this.has(threadId) && this.resumeSettings.get(threadId) === resumeFingerprint(params);
  }

  rememberResume(threadId: string, params: unknown) {
    this.resumeSettings.set(threadId, resumeFingerprint(params));
  }

  forgetResume(threadId: string) {
    this.resumeSettings.delete(threadId);
  }

  invalidateResume(threadId: string, overrides: Record<string, unknown>) {
    const saved = this.resumeSettings.get(threadId);
    if (!saved) return;
    const settings = JSON.parse(saved) as Record<string, unknown>;
    for (const key of ["model", "serviceTier", "cwd", "approvalPolicy", "approvalsReviewer"]) {
      if (overrides[key] !== undefined && resumeFingerprint({ value: overrides[key] }) !== resumeFingerprint({ value: settings[key] })) {
        this.resumeSettings.delete(threadId);
        return;
      }
    }
    if (overrides.sandboxPolicy !== undefined) this.resumeSettings.delete(threadId);
  }

  constructor(private readonly limit = DEFAULT_WARM_THREAD_LIMIT) {}

  has(threadId: string) {
    return this.order.includes(threadId);
  }

  ids() {
    return [...this.order];
  }

  clear() {
    this.order = [];
    this.resumeSettings.clear();
  }

  remove(threadId: string) {
    this.order = this.order.filter((id) => id !== threadId);
    this.resumeSettings.delete(threadId);
  }

  /** Mark thread as most-recently used. Returns ids that should be unloaded. */
  touch(threadId: string): string[] {
    if (!threadId) return [];
    this.order = this.order.filter((id) => id !== threadId);
    this.order.push(threadId);
    if (this.order.length <= this.limit) return [];
    const overflow = this.order.length - this.limit;
    const evict = this.order.slice(0, overflow);
    this.order = this.order.slice(overflow);
    for (const id of evict) this.resumeSettings.delete(id);
    return evict;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resumeFingerprint(params: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    const record = asRecord(value);
    return record ? Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])])) : value;
  };
  const settings = { ...(asRecord(params) || {}) };
  for (const key of ["threadId", "excludeTurns", "forceResume", "reuseIfUnchanged"]) delete settings[key];
  return JSON.stringify(normalize(settings));
}

function threadIdFromParams(params: unknown): string | null {
  const record = asRecord(params);
  const threadId = record?.threadId;
  return typeof threadId === "string" && threadId ? threadId : null;
}

function threadIdFromResult(result: unknown): string | null {
  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  const id = thread?.id;
  return typeof id === "string" && id ? id : null;
}

async function listLoadedThreadIds(gateway: GatewayLike): Promise<Set<string>> {
  const loaded = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = asRecord(
      await gateway.request("thread/loaded/list", cursor ? { cursor } : {})
    );
    const data = result?.data;
    if (Array.isArray(data)) {
      for (const id of data) {
        if (typeof id === "string" && id) loaded.add(id);
      }
    }
    const next = result?.nextCursor;
    if (typeof next !== "string" || !next) break;
    cursor = next;
  }

  return loaded;
}

async function evictThreads(gateway: GatewayLike, pool: WarmThreadPool, evictIds: string[]) {
  for (const threadId of evictIds) {
    try {
      await gateway.request("thread/unsubscribe", { threadId });
    } catch (error) {
      process.stderr.write(
        `[warm-thread-pool] unsubscribe ${threadId} failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    } finally {
      pool.remove(threadId);
    }
  }
}

async function settleWarmPool(gateway: GatewayLike, pool: WarmThreadPool, threadId: string) {
  const evictIds = pool.touch(threadId);
  if (evictIds.length) await evictThreads(gateway, pool, evictIds);
}

async function maybeTouchLoaded(gateway: GatewayLike, pool: WarmThreadPool, threadId: string) {
  if (pool.has(threadId)) {
    await settleWarmPool(gateway, pool, threadId);
    return;
  }
  const loaded = await listLoadedThreadIds(gateway);
  if (loaded.has(threadId)) await settleWarmPool(gateway, pool, threadId);
}

const ATTACH_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const DROP_METHODS = new Set(["thread/unsubscribe", "thread/archive", "thread/delete"]);

/**
 * Keep a bounded set of Codex threads resident in app-server memory.
 * Cold `thread/resume` is skipped when the thread is already loaded.
 */
export async function requestWithWarmPool(
  gateway: GatewayLike,
  pool: WarmThreadPool,
  method: string,
  params?: unknown
): Promise<unknown> {
  if (method === "thread/resume") {
    const threadId = threadIdFromParams(params);
    const record = asRecord(params);
    // Clients set forceResume when settings must be re-applied (e.g. permissions).
    const forceResume = record?.forceResume === true;

    // Queue-only fast path: settings must have been successfully applied in this
    // app-server lifetime. The caller needs no thread history or metadata.
    if (threadId && !forceResume && record?.reuseIfUnchanged === true && record.excludeTurns === true
      && pool.matchesResume(threadId, params)) {
      await settleWarmPool(gateway, pool, threadId);
      return { thread: { id: threadId } };
    }

    if (threadId && !forceResume && record?.reuseIfUnchanged !== true) {
      const loaded = pool.has(threadId) ? true : (await listLoadedThreadIds(gateway)).has(threadId);
      if (loaded) {
        const includeTurns = record?.excludeTurns !== true;
        const read = asRecord(await gateway.request("thread/read", { threadId, includeTurns }));
        await settleWarmPool(gateway, pool, threadId);
        const thread = read?.thread;
        return {
          thread,
          model: typeof record?.model === "string" ? record.model : "",
          modelProvider: asRecord(thread)?.modelProvider || "",
          serviceTier: record?.serviceTier ?? null,
          cwd: asRecord(thread)?.cwd,
          instructionSources: [],
          approvalPolicy: record?.approvalPolicy ?? null,
          approvalsReviewer: null,
          sandbox: record?.sandbox ?? null,
          reasoningEffort: null
        };
      }
    }
  }

  const forwardParams =
    method === "thread/resume"
      ? (() => {
          const next = { ...(asRecord(params) || {}) };
          delete next.forceResume;
          delete next.reuseIfUnchanged;
          return next;
        })()
      : params;

  // A failed resume may have partially changed settings upstream.
  if (method === "thread/resume") {
    const threadId = threadIdFromParams(params);
    if (threadId) pool.forgetResume(threadId);
  }
  const result = await gateway.request(method, forwardParams);

  if (method === "thread/resume") {
    const threadId = threadIdFromResult(result) || threadIdFromParams(params);
    if (threadId) pool.rememberResume(threadId, params);
  } else if (method === "turn/start") {
    // Turn overrides can change effective thread settings. Invalidate so the
    // next resume re-applies the full requested settings when they differ.
    const threadId = threadIdFromParams(params);
    const record = asRecord(params);
    if (threadId && record && Object.keys(record).some((key) => !["threadId", "input"].includes(key))) {
      pool.invalidateResume(threadId, record);
    }
  }

  if (ATTACH_METHODS.has(method)) {
    const threadId = threadIdFromResult(result) || threadIdFromParams(params);
    if (threadId) await settleWarmPool(gateway, pool, threadId);
  } else if (method === "turn/start") {
    const threadId = threadIdFromParams(params);
    if (threadId) await settleWarmPool(gateway, pool, threadId);
  } else if (method === "thread/read") {
    const threadId = threadIdFromParams(params) || threadIdFromResult(result);
    if (threadId) await maybeTouchLoaded(gateway, pool, threadId);
  } else if (DROP_METHODS.has(method)) {
    const threadId = threadIdFromParams(params);
    if (threadId) pool.remove(threadId);
  }

  return result;
}
