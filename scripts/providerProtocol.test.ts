import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pageSource = readFileSync("app/page.tsx", "utf8");
const threadModelSource = readFileSync("app/threadModel.ts", "utf8");
const typeSource = readFileSync("server/types.ts", "utf8");
const cursorSource = readFileSync("server/providers/cursor.ts", "utf8");
const claudeSource = readFileSync("server/providers/claude.ts", "utf8");
const serverSource = readFileSync("server/index.ts", "utf8");

assert.match(typeSource, /export const AGENT_PROVIDER_IDS = \["codex", "cursor", "claude"\]/);
assert.match(typeSource, /export type AgentProviderId = \(typeof AGENT_PROVIDER_IDS\)\[number\]/);
assert.match(typeSource, /export type AgentProviderName = AgentProviderId/);
assert.match(typeSource, /export type AgentCapabilities = \{/);
for (const capability of [
  "models",
  "planMode",
  "askMode",
  "approvals",
  "steering",
  "images",
  "fork",
  "compact",
  "plugins",
  "skills",
  "mcpStatus",
  "memory",
  "serviceTier",
  "reasoningEffort",
  "rename",
  "archive",
  "diff"
]) {
  assert.match(typeSource, new RegExp(`${capability}: boolean`));
}
assert.match(cursorSource, /provider: "cursor"/);
assert.match(claudeSource, /provider: "claude"/);
assert.match(claudeSource, /thread\/start/);
assert.match(claudeSource, /--session-id/);
assert.match(claudeSource, /--permission-mode/);
assert.match(serverSource, /new ClaudeProvider/);
assert.match(serverSource, /handleProviderRequest/);
assert.match(cursorSource, /account\/usage\/read/);
assert.match(cursorSource, /account\/usage\/read/);
assert.match(cursorSource, /planMode: true/);
assert.match(cursorSource, /askMode: true/);
assert.match(cursorSource, /approvals: false/);
assert.match(cursorSource, /fork: false/);
assert.match(cursorSource, /plugins: false/);
assert.match(threadModelSource, /export function threadKey/);
assert.match(threadModelSource, /return `\$\{inferredProvider\}:\$\{nativeThreadId\(thread\)\}`/);
assert.match(threadModelSource, /export function nativeThreadId/);
assert.match(threadModelSource, /id\.slice\(delimiter \+ 1\)/);
assert.match(serverSource, /cursorCompletionNotification\(event\)/);
assert.match(serverSource, /cursorFeishuSource/);
assert.ok(
  serverSource.indexOf("const unsubscribeCursor = subscribeStreamProvider") <
    serverSource.indexOf('wss.on("connection"'),
  "Cursor Feishu notifications must be subscribed once at server scope, not once per browser connection."
);
assert.ok(
  serverSource.indexOf("const unsubscribeClaude = subscribeStreamProvider") <
    serverSource.indexOf('wss.on("connection"'),
  "Claude Feishu notifications must be subscribed once at server scope, not once per browser connection."
);
assert.match(serverSource, /event\.request\.method === "item\/tool\/requestUserInput"/);
const planInputNotifyIndex = serverSource.indexOf("void notifyUserInputRequested(event.request");
assert.ok(planInputNotifyIndex > serverSource.indexOf("gateway.subscribe((event) =>"));
assert.ok(
  planInputNotifyIndex < serverSource.indexOf('wss.on("connection"'),
  "Plan input Feishu notifications must run once at server scope, not once per browser connection."
);
assert.equal(
  serverSource.match(/void notifyUserInputRequested\(event\.request/g)?.length,
  1,
  "Plan input must have exactly one server-side notification call."
);

console.log("provider protocol static checks passed");
