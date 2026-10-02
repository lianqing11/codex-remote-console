import assert from "node:assert/strict";
import { parseSessionLocation, sessionHref } from "../app/sessionNavigation";
import { formatTokenUsage, tokenUsageSummary } from "../app/tokenUsage";
import { readSessionDraft, saveSessionDraft } from "../app/sessionDrafts";

const location = { provider: "claude" as const, session: "a/b?&=中文", view: "files" as const };
assert.deepEqual(parseSessionLocation(sessionHref(location)), location);
assert.equal(parseSessionLocation("?provider=invalid&session=a"), null);
assert.equal(parseSessionLocation("?provider=codex&view=invalid")?.view, "chat");
assert.equal(parseSessionLocation("?provider=cursor")?.session, "");
const usage = { tokenUsage: { total: { inputTokens: 3000000, totalTokens: 3500000 }, last: { inputTokens: 120000, cachedInputTokens: 90000 }, modelContextWindow: 1000000 } };
assert.equal(tokenUsageSummary(usage).lastInput, 120000);
assert.ok(!formatTokenUsage(usage).includes("%"), "cumulative usage must not be presented as context occupancy");
assert.equal(tokenUsageSummary({ tokenUsage: { total: { inputTokens: 3000000 } } }).lastInput, null);
assert.equal(readSessionDraft("server"), "");
saveSessionDraft("server", "SSR safe");
const data = new Map<string, string>();
Object.assign(globalThis, { window: { sessionStorage: {
  getItem: (key: string) => data.get(key) || null,
  setItem: (key: string, value: string) => data.set(key, value),
  removeItem: (key: string) => data.delete(key)
} } });
saveSessionDraft("codex:a", "草稿");
saveSessionDraft("claude:a", "separate");
assert.equal(readSessionDraft("codex:a"), "草稿");
assert.equal(readSessionDraft("claude:a"), "separate");
saveSessionDraft("codex:a", "");
assert.equal(readSessionDraft("codex:a"), "");
Object.defineProperty((globalThis as any).window, "sessionStorage", { get() { throw new Error("Storage blocked"); } });
assert.doesNotThrow(() => saveSessionDraft("x", "y"));
assert.equal(readSessionDraft("x"), "");
console.log("session experience tests passed");
