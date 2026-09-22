import assert from "node:assert/strict";
import {
  buildSessionTitlePrompt,
  extractTitleSource,
  fallbackSessionTitle,
  isUntitledSessionTitle,
  sanitizeSessionTitle
} from "../server/sessionTitle";

assert.equal(sanitizeSessionTitle('  "修复登录重定向"  '), "修复登录重定向");
assert.equal(sanitizeSessionTitle("Title: Fix login redirect"), "Fix login redirect");
assert.equal(sanitizeSessionTitle("标题：会话命名测试\nextra"), "会话命名测试");
assert.equal(sanitizeSessionTitle("   "), null);
assert.equal(sanitizeSessionTitle("x".repeat(50))?.length, 40);

assert.equal(fallbackSessionTitle("Help me fix the login bug. Then deploy."), "Help me fix the login bug");
assert.equal(fallbackSessionTitle("   "), null);

assert.equal(isUntitledSessionTitle(""), true);
assert.equal(isUntitledSessionTitle("codex_web_cursor", "/tmp/codex_web_cursor"), true);
assert.equal(isUntitledSessionTitle("Fix login", "/tmp/codex_web_cursor"), false);

const source = extractTitleSource([
  { event: "user_text", text: "  rename sessions  " },
  { event: "assistant_text", text: "Sure, I can help." },
  { event: "result", text: "done" }
]);
assert.deepEqual(source, { userText: "rename sessions", assistantText: "Sure, I can help." });

const prompt = buildSessionTitlePrompt("rename sessions", "Sure, I can help.");
assert.match(prompt, /reply with the title only/i);
assert.match(prompt, /User:\nrename sessions/);
assert.match(prompt, /Assistant:\nSure, I can help\./);

console.log("sessionTitle.test.ts: ok");
