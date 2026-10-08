import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaudeProvider,
  claudeStreamEvents,
  parseClaudeModelCatalog,
  parseClaudeTranscript,
  projectSlug
} from "../server/providers/claude";
import type { AgentNormalizedEvent, AgentServerRequestEvent } from "../server/types";
import { clipCodexHistory, clipOutput } from "../server/historyOutput";
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
assert.deepEqual(parsed.turns[0].items.slice(1).map((item) => [item.type, item.text ?? item.status]), [
  ["agentMessage", "Looking"],
  ["toolCall", "completed"],
  ["agentMessage", " done"]
]);
// Tool calls keep their input visible after the result arrives.
assert.equal(parsed.turns[0].items[2].command, "ls");
assert.equal(parsed.turns[0].items[2].output, "ok");

// History keeps the head and tail of long tool output; live streaming is unaffected.
const longOutput = `${"a".repeat(5_000)}${"z".repeat(5_000)}`;
const clipped = clipOutput(longOutput);
assert.ok(clipped.startsWith("a".repeat(3_000)) && clipped.endsWith("z".repeat(1_000)));
assert.match(clipped, /6000 characters omitted from history/);
assert.equal(clipOutput("short"), "short");
const codexHistory = clipCodexHistory({ thread: { turns: [{ items: [{ type: "commandExecution", aggregatedOutput: longOutput, command: "x" }] }] } }) as {
  thread: { turns: Array<{ items: Array<{ aggregatedOutput: string; command: string }> }> };
};
assert.equal(codexHistory.thread.turns[0].items[0].aggregatedOutput, clipped);
assert.equal(codexHistory.thread.turns[0].items[0].command, "x");

// Claude Code writes one JSONL row per content block; ids must match the live stream.
const split = parseClaudeTranscript([
  JSON.stringify({ type: "user", uuid: "turn-1", message: { role: "user", content: "Check" } }),
  JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [{ type: "thinking", thinking: "" }] } }),
  JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [{ type: "text", text: "Checking." }] } }),
  JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] } }),
  JSON.stringify({ type: "assistant", message: { id: "msg-2", content: [{ type: "text", text: "Final answer." }] } })
].join("\n"));
assert.deepEqual(split.turns[0].items.slice(1).map((item) => item.id), ["msg-1-1", "tool-1", "msg-2-0"]);

const stream = claudeStreamEvents({
  type: "content_block_delta",
  delta: { type: "text_delta", text: "hi" }
}, "run-1");
assert.equal(stream[0].event, "assistant_text");
assert.equal(stream[0]?.text, "hi");
const streamState = { messageId: "", blocks: new Map<string, number>(), tools: new Map() };
claudeStreamEvents({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } }, "run-1", streamState);
claudeStreamEvents({ type: "assistant", message: { id: "msg-1", content: [{ type: "thinking", thinking: "" }] } }, "run-1", streamState);
const liveDelta = claudeStreamEvents({
  type: "stream_event",
  event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Check" } }
}, "run-1", streamState);
const toolState = { messageId: "", blocks: new Map<string, number>(), tools: new Map() };
const toolStart = claudeStreamEvents({ type: "assistant", message: { id: "msg-t", content: [{ type: "tool_use", id: "tool-9", name: "Read", input: { file_path: "/tmp/a.txt" } }] } }, "run-1", toolState);
assert.deepEqual([toolStart[0].toolName, toolStart[0].command], ["Read", "/tmp/a.txt"]);
const toolDone = claudeStreamEvents({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-9", content: "text" }] } }, "run-1", toolState);
assert.deepEqual([toolDone[0].event, toolDone[0].toolName, toolDone[0].command, toolDone[0].summary], ["tool_completed", "Read", "/tmp/a.txt", "text"]);
const liveBlock = claudeStreamEvents({ type: "assistant", message: { id: "msg-1", content: [{ type: "text", text: "Checking." }] } }, "run-1", streamState);
assert.deepEqual([liveDelta[0].itemId, liveDelta[0].delta], ["msg-1-1", true]);
assert.deepEqual([liveBlock[0].itemId, liveBlock[0].text, liveBlock[0].delta], ["msg-1-1", "Checking.", false]);
assert.equal(claudeStreamEvents({
  type: "assistant",
  parent_tool_use_id: "task-1",
  message: { id: "sub-1", content: [{ type: "text", text: "subagent note" }] }
}, "run-1").length, 0);
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
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd(), claudeAiMcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS, consolePassword: process.env.CODEX_WEB_PASSWORD }) + "\\n");
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
if (args.includes("-p") && process.env.CLAUDE_FAKE_ASK === "1") {
  const responses = {};
  const input = require("node:readline").createInterface({ input: process.stdin });
  input.on("line", (raw) => {
    const message = JSON.parse(raw);
    if (message.type === "user") {
      line({ type: "control_request", request_id: "deny-1", request: { subtype: "can_use_tool", tool_name: "Write", input: {} } });
      line({ type: "control_request", request_id: "ask-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", input: {
        questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }]
      } } });
    }
    if (message.type !== "control_response") return;
    responses[message.response.request_id] = message.response.response;
    if (Object.keys(responses).length < 2) return;
    line({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(responses) }] } });
    line({ type: "result", subtype: "success", result: "done" });
  });
  input.on("close", () => process.exit(0));
  return;
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
    env: { ...process.env, CLAUDE_FAKE_LOG: logPath, CODEX_WEB_PASSWORD: "console-secret" }
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
  const unsubscribe = provider.subscribe((event) => { if (event.type === "agent:event") events.push(event); });
  const turn = await provider.handle("turn/start", {
    threadId: created.thread.id,
    input: [{ type: "text", text: "say hi", text_elements: [] }],
    mode: "plan",
    model: "opus",
    effort: "high"
  }) as { turn: { id: string } };
  assert.ok(turn.turn.id);
  await waitFor(() => events.some((event) => event.event === "status" && event.status === "completed"), "claude turn complete");

  const log = (await readFile(logPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string; claudeAiMcp?: string; consolePassword?: string });
  const run = log.find((entry) => entry.args.includes("-p"));
  assert.ok(run);
  assert.equal(run.consolePassword, undefined, "console secrets stay out of agent processes");
  assert.ok(run.args.includes("--session-id"));
  assert.ok(run.args.includes("--permission-mode"));
  assert.ok(run.args.includes("plan"));
  assert.ok(run.args.includes("--effort"));
  assert.equal(run.cwd, project);
  assert.equal(run.claudeAiMcp, "false");

  for (const [requestedMode, expectedMode] of [
    [undefined, "plan"],
    ["agent", "agent"],
    [undefined, "agent"],
    ["plan", "plan"],
    ["default", "agent"]
  ] as const) {
    const next = await provider.handle("turn/start", {
      threadId: created.thread.id,
      prompt: "Implement this plan now.",
      ...(requestedMode === undefined ? {} : { mode: requestedMode })
    }) as { turn: { id: string } };
    await waitFor(() => events.some((event) => event.runId === next.turn.id && event.event === "status" && event.status === "completed"), `mode ${String(requestedMode)} turn complete`);
    const invocations = (await readFile(logPath, "utf8")).trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { args: string[] }).filter((entry) => entry.args.includes("-p"));
    const invocation = invocations.at(-1)!;
    assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], expectedMode === "plan" ? "plan" : "acceptEdits");
    assert.equal(invocation.args[invocation.args.indexOf("--resume") + 1], created.thread.id, "mode changes resume the same session");
    assert.equal(invocation.args.includes("--session-id"), false);
    const hydrated = await provider.handle("thread/read", { threadId: created.thread.id }) as { thread: { id: string; mode: string } };
    assert.equal(hydrated.thread.id, created.thread.id);
    assert.equal(hydrated.thread.mode, expectedMode, "read returns the resolved mode");
    const saved = JSON.parse(await readFile(path.join(state, "index.json"), "utf8")) as { sessions: Array<{ id: string; mode: string }> };
    assert.equal(saved.sessions.find((session) => session.id === created.thread.id)?.mode, expectedMode, "resolved mode is durable");
  }
  unsubscribe();

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
  // Parsed transcripts are cached by mtime/size; an appended turn must still appear.
  await appendFile(path.join(jsonlDir, `${created.thread.id}.jsonl`), `${JSON.stringify({
    type: "user",
    uuid: "turn-read-2",
    message: { role: "user", content: "again" }
  })}\n`);
  const reread = await provider.handle("thread/read", { threadId: created.thread.id }) as unknown as { thread: { turns: unknown[] } };
  assert.equal(reread.thread.turns.length, 2);

  const hanging = new ClaudeProvider({
    command: fake,
    configDir: config,
    stateDir: path.join(root, "state-hang"),
    env: { ...process.env, CLAUDE_FAKE_LOG: logPath, CLAUDE_FAKE_HANG: "1" }
  });
  const hangingThread = await hanging.handle("thread/start", { cwd: project }) as { thread: { id: string } };
  const hangEvents: AgentNormalizedEvent[] = [];
  hanging.subscribe((event) => { if (event.type === "agent:event") hangEvents.push(event); });
  await hanging.handle("turn/start", { threadId: hangingThread.thread.id, prompt: "hang" });
  await hanging.handle("turn/interrupt", { threadId: hangingThread.thread.id });
  await waitFor(() => hangEvents.some((event) => event.event === "status" && event.status === "cancelled"), "claude interrupt");
  hanging.stop();

  // AskUserQuestion reaches the browser as requestUserInput; the answer goes back over stdin.
  const asking = new ClaudeProvider({
    command: fake,
    configDir: config,
    stateDir: path.join(root, "state-ask"),
    env: { ...process.env, CLAUDE_FAKE_ASK: "1" }
  });
  const askThread = await asking.handle("thread/start", { cwd: project }) as { thread: { id: string } };
  const askEvents: Array<AgentNormalizedEvent | AgentServerRequestEvent> = [];
  asking.subscribe((event) => askEvents.push(event));
  const askTurn = await asking.handle("turn/start", { threadId: askThread.thread.id, prompt: "ask me" }) as { turn: { id: string } };
  await waitFor(() => asking.pendingRequests().length === 1, "claude question");
  const [question] = asking.pendingRequests();
  assert.equal(question.method, "item/tool/requestUserInput");
  assert.deepEqual(question.params, {
    threadId: askThread.thread.id, turnId: askTurn.turn.id, itemId: "toolu_ask",
    questions: [{ id: "Which color?", header: "Color", question: "Which color?", isOther: true, isSecret: false,
      options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }]
  });
  asking.respond(question.id, { answers: { "Which color?": { answers: ["Blue"] } } });
  await waitFor(() => askEvents.some((event) => event.type === "agent:event" && event.event === "status" && event.status === "completed"), "answered claude turn");
  const reply = askEvents.find((event) => event.type === "agent:event" && event.event === "assistant_text");
  assert.deepEqual(JSON.parse(reply && "text" in reply ? reply.text : "{}"), {
    "deny-1": { behavior: "deny", message: "Write needs approval, which this console does not grant." },
    "ask-1": { behavior: "allow", updatedInput: { questions: [{ question: "Which color?", header: "Color", multiSelect: false,
      options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }], answers: { "Which color?": "Blue" } } }
  });
  assert.ok(askEvents.some((event) => event.type === "agent:serverRequestResolved" && event.requestId === question.id));
  assert.equal(asking.pendingRequests().length, 0);
  assert.throws(() => asking.respond(question.id, { answers: {} }), /no longer waiting/);
  asking.stop();
  provider.stop();

  console.log("claude provider tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
