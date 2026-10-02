import assert from "node:assert/strict";
import { snapshotCache } from "../server/snapshotCache";

async function main() {
  const realNow = Date.now;
  let now = 1000, loads = 0;
  Date.now = () => now;
  try {
    const cache = snapshotCache(async () => ++loads);
    assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), [1, 1, 1]);
    now += 4999;
    assert.equal(await cache.get(), 1);
    now++;
    assert.equal(await cache.get(), 2);
    cache.invalidate();
    assert.equal(await cache.get(), 3);
    let finish!: (value: number) => void;
    const pending = snapshotCache(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = pending.get();
    const oldFinish = finish;
    pending.invalidate();
    const second = pending.get();
    oldFinish(10); finish(20);
    assert.equal(await first, 10);
    assert.equal(await second, 20);
    assert.equal(await pending.get(), 20);
    let attempts = 0;
    const failures = snapshotCache(async () => { if (++attempts === 1) throw new Error("probe failure"); return "recovered"; });
    await assert.rejects(failures.get(), /probe failure/);
    assert.equal(await failures.get(), "recovered");
  } finally { Date.now = realNow; }
  console.log("snapshotCache.test.ts: ok");
}
void main();
