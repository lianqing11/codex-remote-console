/** Coalesce status probes across HTTP/WS clients; never cache failed probes. */
export function snapshotCache<T>(load: () => Promise<T>, ttlMs = 5000) {
  let value: T | undefined;
  let expires = 0;
  let generation = 0;
  let pending: { generation: number; promise: Promise<T> } | null = null;
  return {
    invalidate() { generation++; expires = 0; },
    get(): Promise<T> {
      if (value !== undefined && Date.now() < expires) return Promise.resolve(value);
      if (pending?.generation === generation) return pending.promise;
      const revision = generation;
      const promise = load().then(next => {
        if (revision === generation) { value = next; expires = Date.now() + ttlMs; }
        return next;
      }).finally(() => { if (pending?.promise === promise) pending = null; });
      pending = { generation: revision, promise };
      return promise;
    }
  };
}
