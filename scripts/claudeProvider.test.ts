import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaudeProvider,
  claudeStreamEvents,
  parseClaudeModelCatalog,
  parseClaudeTranscript,
  projectSlug
} from "../server/providers/claude";
import type { AgentNormalizedEvent } from "../server/types";
import {
  formatClaudeResetRelative,
  formatClaudeUsageLabel,
  formatClaudeWeekReset,
  standardClaudeRateLimit
} from "../app/claudeUsage";

assert.equal(projectSlug("/tmp/my project"), "-tmp-my-project");

const parsed = parseClaudeTranscript([
  JSON.stringify({ type: "user", cwd: "/tmp/work", uuid: "turn-1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "List files" } }),
  JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: " done" }] } })
].join("\n"));
assert.equal(parsed.cwd, "/tmp/work");
assert.equal(parsed.turns.length, 1);
assert.equal(parsed.turns[0].items[0].type, "userMessage");
assert.equal(parsed.turns[0].items[1].type, "agentMessage");
assert.equal(parsed.turns[0].items[1].text, "Looking done");
assert.equal(parsed.turns[0].items[2].type, "toolCall");
assert.equal(parsed.turns[0].items[2].status, "completed");

const stream = claudeStreamEvents({
  type: "content_block_delta",
  delta: { type: "text_delta", text: "hi" }
}, "run-1");
assert.equal(stream[0].event, "assistant_text");
assert.equal(stream[0]?.text, "hi");
assert.equal(claudeStreamEvents({ type: "result", result: "ok" }, "run-1").length, 0);
assert.equal(claudeStreamEvents({ type: "result", is_error: true, result: "403" }, "run-1")[0].event, "error");
assert.equal(claudeStreamEvents({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "plan" } }
}, "run-1").length, 0);
assert.equal(claudeStreamEvents({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "pong" } }
}, "run-1")[0]?.text, "pong");
assert.equal(claudeStreamEvents({
  type: "rate_limit_event",
  rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 10 } } }
}, "run-1")[0]?.event, "rate_limits");
assert.equal(claudeStreamEvents({
  type: "result",
  usage: { input_tokens: 2, output_tokens: 4 }
}, "run-1")[0]?.event, "token_usage");
const catalog = parseClaudeModelCatalog({
  catalog: {
    config: {
      models: [
        { id: "claude-sonnet-5", name: "Sonnet 5", description: "Everyday", thinking: { type: "effort", effort_options: [{ id: "high" }, { id: "max" }] } },
        { id: "claude-fable-5-1", name: "Fable 5.1", thinking: { type: "effort", effort_options: [{ id: "high" }] } },
        { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", thinking: { type: "none" } }
      ]
    }
  }
});
assert.deepEqual(catalog.map((model) => model.id), ["claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"]);
assert.ok(catalog[0].supportedReasoningEfforts?.some((item) => item.reasoningEffort === "max"));
assert.equal(catalog[2].supportedReasoningEfforts?.length, 0);
const claudeLimit = standardClaudeRateLimit({
  unifiedWindows: {
    five_hour: { utilization: 0.03, resetsAt: 1789798200 },
    seven_day: { utilization: 0, resetsAt: 1790078400 }
  }
});
assert.equal(claudeLimit?.usedPercent, 3);
assert.equal(claudeLimit?.session.usedPercent, 3);
assert.equal(claudeLimit?.weekly?.usedPercent, 0);
assert.equal(claudeLimit?.weekly?.resetsAt, 1790078400);
assert.equal(formatClaudeResetRelative(1_000, 0), "in 17 min");
assert.equal(formatClaudeResetRelative(10_000, 0), "in 2h 47m");
assert.match(formatClaudeWeekReset(1790078400), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2} (AM|PM)$/);
assert.equal(formatClaudeUsageLabel(claudeLimit!), "5h 3% used · Week 0% used");
assert.equal(claudeStreamEvents({
  type: "assistant",
  is_api_error_message: true,
  error: "authentication_failed",
  message: { content: [{ type: "text", text: "Failed to authenticate" }] }
}, "run-1")[0].event, "error");

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "claude-provider-"));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const state = path.join(root, "state");
  const config = path.join(root, "claude-home");
  const logPath = path.join(root, "claude.log");
  await mkdir(bin);
  await mkdir(project);
  await writeFile(logPath, "");
  const fake = path.join(bin, "claude");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.CLAUDE_FAKE_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args.includes("--version")) {
  console.log("2.1.0");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("logged in");
  process.exit(0);
}
function line(value) {
  console.log(JSON.stringify(value));
}
if (args.includes("-p")) {
  const hang = process.env.CLAUDE_FAKE_HANG === "1";
  line({ type: "assistant", message: { content: [{ type: "text", text: "hello from claude" }] } });
  line({ type: "result", subtype: "success", result: "hello from claude" });
  if (hang) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );
  await chmod(fake, 0o755);

  const provider = new ClaudeProvider({
    command: fake,
    configDir: config,
    stateDir: state,
    env: { ...process.env, CLAUDE_FAKE_LOG: logPath }
  });

  const snapshot = await provider.getSnapshot();
  assert.equal(snapshot.provider, "claude");
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.capabilities.planMode, true);
  assert.equal(snapshot.capabilities.askMode, false);
  assert.equal(snapshot.capabilities.reasoningEffort, true);
  const models = await provider.handle("model/list", {}) as { data: Array<{ id: string }> };
  assert.ok(models.data.some((model) => model.id === "claude-fable-5-1"));
  assert.ok(models.data.some((model) => model.id === "claude-opus-5"));
  assert.ok(models.data.some((model) => model.id === "claude-haiku-4-5-20251001"));

  const created = await provider.handle("thread/start", { cwd: project, model: "sonnet", mode: "plan" }) as { thread: { id: string; mode: string } };
  assert.ok(created.thread.id);
  assert.equal(created.thread.mode, "plan");

  const events: AgentNormalizedEvent[] = [];
  const unsubscribe = provider.subscribe((event) => events.push(event));
  const turn = await provider.handle("turn/start", {
    threadId: created.thread.id,
    input: [{ type: "text", text: "say hi", text_elements: [] }],
    mode: "plan",
    model: "opus",
    effort: "high"
  }) as { turn: { id: string } };
  assert.ok(turn.turn.id);
  await waitFor(() => events.some((event) => event.event === "status" && event.status === "completed"), "claude turn complete");
  unsubscribe();

  const log = (await readFile(logPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  const run = log.find((entry) => entry.args.includes("-p"));
  assert.ok(run);
  assert.ok(run.args.includes("--session-id"));
  assert.ok(run.args.includes("--permission-mode"));
  assert.ok(run.args.includes("plan"));
  assert.ok(run.args.includes("--effort"));
  assert.equal(run.cwd, project);

  const jsonlDir = path.join(config, "projects", projectSlug(project));
  await mkdir(jsonlDir, { recursive: true });
  await writeFile(path.join(jsonlDir, `${created.thread.id}.jsonl`), `${JSON.stringify({
    type: "user",
    cwd: project,
    uuid: "turn-read",
    message: { role: "user", content: "say hi" }
  })}\n${JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello from claude" }] }
  })}\n`);

  const read = await provider.handle("thread/read", { threadId: created.thread.id }) as unknown as { thread: { turns: Array<{ items: Array<{ type: string }> }> } };
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].items[0].type, "userMessage");

  const hanging = new ClaudeProvider({
    command: fake,
    configDir: config,
    stateDir: path.join(root, "state-hang"),
    env: { ...process.env, CLAUDE_FAKE_LOG: logPath, CLAUDE_FAKE_HANG: "1" }
  });
  const hangingThread = await hanging.handle("thread/start", { cwd: project }) as { thread: { id: string } };
  const hangEvents: AgentNormalizedEvent[] = [];
  hanging.subscribe((event) => hangEvents.push(event));
  await hanging.handle("turn/start", { threadId: hangingThread.thread.id, prompt: "hang" });
  await hanging.handle("turn/interrupt", { threadId: hangingThread.thread.id });
  await waitFor(() => hangEvents.some((event) => event.event === "status" && event.status === "cancelled"), "claude interrupt");
  hanging.stop();
  provider.stop();

  console.log("claude provider tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
