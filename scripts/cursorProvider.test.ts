import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CursorProvider, parseCursorModels, stripAnsiAndControls } from "../server/providers/cursor";
import type { AgentNormalizedEvent } from "../server/types";

type Harness = {
  root: string;
  bin: string;
  project: string;
  state: string;
  logPath: string;
  signalPath: string;
};

function fileMode(fileMode: number) {
  return fileMode & 0o777;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function readLog(logPath: string) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      args: string[];
      cwd: string;
      nestedCursor?: string | null;
      cursorAgent?: string | null;
    });
}

async function runArgs(harness: Harness) {
  await waitFor(async () => (await readLog(harness.logPath)).some((entry) => entry.args.includes("--resume")), "cursor run invocation");
  const log = await readLog(harness.logPath);
  return [...log].reverse().find((entry) => entry.args.includes("--resume"))!.args;
}

async function createHarness(prefix: string): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const state = path.join(root, "state");
  const logPath = path.join(root, "cursor-agent.log");
  const signalPath = path.join(root, "signals.log");
  await mkdir(bin);
  await mkdir(project);
  await writeFile(logPath, "");
  await writeFile(signalPath, "");

  const fakeCursor = path.join(bin, "cursor-agent");
  await writeFile(
    fakeCursor,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.CURSOR_FAKE_LOG;
const signalPath = process.env.CURSOR_FAKE_SIGNAL_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify({
  args,
  cwd: process.cwd(),
  nestedCursor: process.env.CURSOR_CONVERSATION_ID || null,
  cursorAgent: process.env.CURSOR_AGENT || null
}) + "\\n");

function line(value) {
  console.log(JSON.stringify(value));
}

if (args.includes("--list-models")) {
  const mode = process.env.CURSOR_FAKE_MODELS || "ok";
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "nonzero") {
    console.error("\\u001b[31mmodel list failed\\u0007\\u001b[0m");
    process.exit(7);
  }
  if (mode === "empty") process.exit(0);
  if (mode === "json") {
    console.log(JSON.stringify({ models: [{ id: "gpt-json", name: "GPT JSON" }] }));
    process.exit(0);
  }
  console.log("Loading models");
  console.log("\\u001b[32mgpt-5.5 - GPT 5.5\\u001b[0m");
  console.log("auto - Auto");
  process.exit(0);
}

if (args.includes("--version")) {
  if (process.env.CURSOR_FAKE_VERSION === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  console.log("cursor-agent 1.2.3");
  process.exit(0);
}

if (args[0] === "create-chat") {
  const createMode = process.env.CURSOR_FAKE_CREATE || "ok";
  if (createMode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (createMode === "slow") {
    setTimeout(() => {
      console.log(process.env.CURSOR_FAKE_CREATE_ID || "native-chat-1");
      process.exit(0);
    }, 90);
    return;
  }
  console.log(process.env.CURSOR_FAKE_CREATE_ID || "native-chat-1");
  process.exit(0);
}

const modeIndex = args.indexOf("--mode");
const askMode = modeIndex >= 0 && args[modeIndex + 1] === "ask" && !args.includes("--resume");
if (askMode) {
  const titleMode = process.env.CURSOR_FAKE_TITLE || '  "Suggested Title"  ';
  if (titleMode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (titleMode === "fail") {
    console.error("title suggest failed");
    process.exit(2);
  }
  if (titleMode === "empty") {
    console.log("   ");
    process.exit(0);
  }
  console.log(titleMode);
  process.exit(0);
}

const runMode = process.env.CURSOR_FAKE_RUN || "stream";
if (runMode === "stderr-exit") {
  const noisy = "\\u001b[31m" + "x".repeat(13050) + "\\u0007\\u001b[0m";
  console.error(noisy);
  process.exit(9);
}
if (runMode === "no-result-exit") {
  line({ type: "assistant", message: { content: [{ type: "text", text: "NO_RESULT" }] } });
  process.exit(0);
}

process.on("SIGINT", () => {
  if (signalPath) fs.appendFileSync(signalPath, "SIGINT\\n");
  setTimeout(() => process.exit(130), 20);
});

line({ type: "system", subtype: "init", session_id: "native-chat-1", model: "gpt-5.5", cwd: process.cwd(), permissionMode: "default" });

if (runMode === "hang") {
  setInterval(() => {}, 1000);
  return;
}

if (runMode === "slow-success") {
  setTimeout(() => {
    line({ type: "assistant", message: { content: [{ type: "text", text: "SLOW_OK" }] } });
    line({ type: "result", subtype: "success", duration_ms: 12, result: "SLOW_OK", session_id: "native-chat-1", request_id: "req-slow" });
    process.exit(0);
  }, 350);
  return;
}

if (runMode === "burst") {
  for (let index = 0; index < 120; index += 1) {
    line({ type: "assistant", message: { content: [{ type: "text", text: "chunk-" + index + " " }] } });
  }
  line({ type: "result", subtype: "success", duration_ms: 12, result: "burst complete", session_id: "native-chat-1", request_id: "req-burst" });
  process.exit(0);
}

line({ type: "thinking", delta: "hidden" });
line({ type: "assistant", message: { content: [{ type: "text", text: "CURSOR_" }] } });
line({ type: "assistant", message: { content: [{ type: "text", text: "STREAM_OK" }] } });
line({ type: "assistant", message: { content: [{ type: "text", text: "CURSOR_STREAM_OK" }] } });
console.log("{malformed");
line({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { globToolCall: { args: { pattern: "**/*.ts" }, toolCallId: "tool-1", startedAtMs: 1 } } });
line({ type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { globToolCall: { result: { success: { files: ["a.ts"] } }, toolCallId: "tool-1" } } });
line({ type: "result", subtype: "success", duration_ms: 12, duration_api_ms: 4, is_error: false, result: "CURSOR_STREAM_OK", session_id: "native-chat-1", request_id: "req-1" });
process.exit(0);
`
  );
  await chmod(fakeCursor, 0o755);

  process.env.CODING_AGENT_CONSOLE_STATE_DIR = state;
  process.env.CURSOR_FAKE_LOG = logPath;
  process.env.CURSOR_FAKE_SIGNAL_LOG = signalPath;
  process.env.CURSOR_FAKE_MODELS = "ok";
  process.env.CURSOR_FAKE_RUN = "stream";
  process.env.CURSOR_FAKE_CREATE_ID = "native-chat-1";
  delete process.env.CURSOR_FAKE_TITLE;
  delete process.env.CURSOR_FAKE_CREATE;
  delete process.env.CURSOR_FAKE_VERSION;
  delete process.env.CODEX_WEB_SESSION_TITLE_TIMEOUT_MS;
  delete process.env.CODEX_WEB_CURSOR_CREATE_TIMEOUT_MS;
  delete process.env.CODEX_WEB_CURSOR_LIST_MODELS_TIMEOUT_MS;
  delete process.env.CODEX_WEB_CURSOR_VERSION_TIMEOUT_MS;
  delete process.env.CURSOR_CONVERSATION_ID;
  delete process.env.CURSOR_AGENT;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;

  return { root, bin, project, state, logPath, signalPath };
}

async function createSession(provider: CursorProvider, project: string, title = "Demo") {
  return (await provider.handle("session/create", { cwd: project, title, model: "auto" })) as any;
}

async function testModelParsingStripsControls() {
  const parsed = parseCursorModels("Loading models...\nAvailable models\n\u001b[32mgpt-5.5 - GPT 5.5\u001b[0m\n- claude-4 - Claude 4\nTip: choose auto\n");
  assert.deepEqual(parsed, [
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "claude-4", name: "Claude 4" }
  ]);
  assert.equal(stripAnsiAndControls("\u001b[31mhi\u0007"), "hi");
}

async function testSnapshotExposesCursorCapabilities() {
  const harness = await createHarness("cursor-capability-test");
  const provider = new CursorProvider();
  const [snapshot, concurrentSnapshot] = await Promise.all([provider.getSnapshot(), provider.getSnapshot()]);
  assert.equal(snapshot.provider, "cursor");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.version, "cursor-agent 1.2.3");
  assert.deepEqual(snapshot.models, [
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "auto", name: "Auto" }
  ]);
  assert.equal(snapshot.capabilities.planMode, true);
  assert.equal(snapshot.capabilities.askMode, true);
  assert.equal(snapshot.capabilities.approvals, false);
  assert.equal(snapshot.capabilities.fork, false);
  assert.equal(snapshot.capabilities.plugins, false);
  assert.equal(snapshot.capabilities.images, true);
  assert.deepEqual(concurrentSnapshot.models, snapshot.models);
  const log = await readLog(harness.logPath);
  assert.equal(log.filter((entry) => entry.args.includes("--list-models")).length, 1);
  assert.ok(harness.root);
}

async function testFirstPromptAssignsImmediateFallbackTitle() {
  const harness = await createHarness("cursor-immediate-title-test");
  const provider = new CursorProvider();
  await provider.getSnapshot();
  const created = (await provider.handle("session/create", { cwd: harness.project, model: "auto" })) as any;
  await provider.handle("run/start", {
    sessionId: created.session.sessionId,
    prompt: "Help me fix the login redirect bug. Then deploy."
  });
  const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
  assert.equal(read.session.title, "Help me fix the login redire");
  const log = await readLog(harness.logPath);
  assert.equal(log.some((entry) => entry.args.includes("--mode") && entry.args.includes("ask") && !entry.args.includes("--resume")), false);
}

async function testCreateSessionDefaultsToEmptyTitle() {
  const harness = await createHarness("cursor-empty-title-test");
  const provider = new CursorProvider();
  const created = (await provider.handle("session/create", { cwd: harness.project, model: "auto" })) as any;
  assert.equal(created.session.title, "");
  assert.equal(created.session.name, "");
  assert.equal(created.thread.title, "");
}

async function testCreateSessionHasDedicatedTimeoutAndUsefulError() {
  const harness = await createHarness("cursor-create-timeout-test");
  process.env.CURSOR_FAKE_CREATE = "slow";
  process.env.CODEX_WEB_CURSOR_CREATE_TIMEOUT_MS = "500";
  const provider = new CursorProvider();
  const created = (await provider.handle("session/create", { cwd: harness.project, model: "auto" })) as any;
  assert.equal(created.session.nativeSessionId, "native-chat-1");

  const timeoutHarness = await createHarness("cursor-create-timeout-error-test");
  process.env.CURSOR_FAKE_CREATE = "hang";
  process.env.CODEX_WEB_CURSOR_CREATE_TIMEOUT_MS = "60";
  const timeoutProvider = new CursorProvider();
  await assert.rejects(
    () => timeoutProvider.handle("session/create", { cwd: timeoutHarness.project, model: "auto" }),
    /cursor-agent create-chat timed out after 60ms/i
  );
}

async function testSuggestTitleUsesAskModeWithoutResume() {
  const harness = await createHarness("cursor-suggest-title-test");
  const provider = new CursorProvider();
  const events: AgentNormalizedEvent[] = [];
  provider.subscribe((event) => events.push(event));
  const created = await createSession(provider, harness.project);
  const started = (await provider.handle("run/start", {
    sessionId: created.session.sessionId,
    prompt: "Help me fix the login redirect bug",
    model: "gpt-5.5"
  })) as any;
  await waitFor(
    () => events.some((event) => event.event === "status" && event.status === "completed" && event.runId === started.runId),
    "completed before suggest-title"
  );

  const before = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
  process.env.CURSOR_FAKE_TITLE = 'Title: "修复登录重定向"';
  const suggested = (await provider.handle("session/suggest-title", { sessionId: created.session.sessionId })) as any;
  assert.equal(suggested.title, "修复登录重定向");

  const after = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
  assert.equal(after.session.title, before.session.title);
  assert.equal(after.transcript.length, before.transcript.length);

  const log = await readLog(harness.logPath);
  const suggestInvocation = [...log].reverse().find((entry) => entry.args.includes("--mode") && entry.args.includes("ask"));
  assert.ok(suggestInvocation);
  assert.equal(suggestInvocation.args.includes("--resume"), false);
  assert.deepEqual(suggestInvocation.args.slice(0, 8), [
    "--print",
    "--output-format",
    "text",
    "--mode",
    "ask",
    "--trust",
    "--workspace",
    harness.project
  ]);
  assert.ok(suggestInvocation.args.includes("--model"));
  assert.ok(suggestInvocation.args.includes("gpt-5.5"));
}

async function testSuggestTitleFailsOnEmptyOrTimeout() {
  const harness = await createHarness("cursor-suggest-title-fail-test");
  const provider = new CursorProvider();
  const events: AgentNormalizedEvent[] = [];
  provider.subscribe((event) => events.push(event));
  const created = await createSession(provider, harness.project);
  const started = (await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "hello" })) as any;
  await waitFor(
    () => events.some((event) => event.event === "status" && event.status === "completed" && event.runId === started.runId),
    "completed before empty title"
  );

  process.env.CURSOR_FAKE_TITLE = "empty";
  await assert.rejects(
    () => provider.handle("thread/title/suggest", { threadId: created.thread.id }),
    /empty title/i
  );

  process.env.CODEX_WEB_SESSION_TITLE_TIMEOUT_MS = "150";
  process.env.CURSOR_FAKE_TITLE = "hang";
  await assert.rejects(
    () => provider.handle("session/suggest-title", { sessionId: created.session.sessionId }),
    /.+/
  );
  delete process.env.CODEX_WEB_SESSION_TITLE_TIMEOUT_MS;
}

async function testCreateStartResumePartialAndToolEvents() {
  const harness = await createHarness("cursor-stream-test");
  const provider = new CursorProvider();
  const events: AgentNormalizedEvent[] = [];
  provider.subscribe((event) => events.push(event));

  const created = await createSession(provider, harness.project);
  assert.equal(created.session.nativeSessionId, "native-chat-1");
  assert.equal(created.session.key, "cursor:native-chat-1");
  assert.equal(created.session.status, "idle");

  const started = (await provider.handle("run/start", {
    sessionId: created.session.sessionId,
    prompt: "Do it",
    model: "gpt-5.5"
  })) as any;

  await waitFor(() => events.some((event) => event.event === "status" && event.status === "completed" && event.runId === started.runId), "completed status");
  const log = await readLog(harness.logPath);
  const runInvocation = log.find((entry) => entry.args.includes("--resume"));
  assert.ok(runInvocation);
  assert.deepEqual(runInvocation.args.slice(0, 6), ["--print", "--output-format", "stream-json", "--stream-partial-output", "--workspace", harness.project]);
  assert.ok(runInvocation.args.includes("--resume"));
  assert.ok(runInvocation.args.includes("native-chat-1"));
  assert.ok(runInvocation.args.includes("--model"));
  assert.ok(events.some((event) => event.event === "assistant_text" && event.text === "CURSOR_"));
  assert.ok(events.some((event) => event.event === "assistant_text" && event.text === "STREAM_OK"));
  assert.ok(!events.some((event) => event.event === "assistant_text" && event.text === "CURSOR_STREAM_OK"));
  assert.ok(events.some((event) => event.event === "tool_started" && event.toolCallId === "call-1" && event.toolName === "Glob"));
  assert.ok(events.some((event) => event.event === "tool_completed" && event.toolCallId === "call-1" && event.summary?.includes("a.ts")));
}

async function testAgentModeUsesUnsandboxedAllowlistArgs() {
  const harness = await createHarness("cursor-agent-args-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  await provider.handle("run/start", {
    sessionId: created.session.sessionId,
    prompt: "agent args",
    model: "gpt-5.5"
  });
  const args = await runArgs(harness);
  assert.equal(args.includes("--force"), false);
  assert.ok(args.includes("--trust"));
  const sandboxIndex = args.indexOf("--sandbox");
  assert.notEqual(sandboxIndex, -1);
  assert.equal(args[sandboxIndex + 1], "disabled");
}

async function testPlanModeUsesTrustWithoutForceOrSandbox() {
  const harness = await createHarness("cursor-plan-args-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  await provider.handle("turn/start", {
    threadId: created.thread.id,
    prompt: "Plan it",
    mode: "plan",
    model: "auto"
  });
  const args = await runArgs(harness);
  assert.ok(args.includes("--trust"));
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("plan"));
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--sandbox"), false);
  await waitFor(async () => {
    const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
    return read.incomplete === false;
  }, "plan mode completion");
  const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
  assert.equal(read.session.mode, "plan");
  await assert.rejects(
    () => provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "Switch to agent", mode: "agent" }),
    /mode is fixed for this native session/
  );
}

async function testAskModeUsesTrustWithoutForceOrSandbox() {
  const harness = await createHarness("cursor-ask-args-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  await provider.handle("turn/start", {
    threadId: created.thread.id,
    prompt: "Ask it",
    mode: "ask",
    model: "auto"
  });
  const args = await runArgs(harness);
  assert.ok(args.includes("--trust"));
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("ask"));
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--sandbox"), false);
}

async function testSameSessionRejectsConcurrentRun() {
  const harness = await createHarness("cursor-concurrent-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  process.env.CURSOR_FAKE_RUN = "hang";
  await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "first" });
  await assert.rejects(
    () => provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "second" }),
    /already has an active run/
  );
  await provider.handle("run/stop", { sessionId: created.session.sessionId });
  await waitFor(async () => {
    const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
    return read.incomplete === false && read.session.status === "cancelled";
  }, "cancelled after cleanup");
}

async function testStopSendsSigintAndClearsActiveRun() {
  const harness = await createHarness("cursor-stop-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  process.env.CURSOR_FAKE_RUN = "hang";
  const started = (await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "stop me" })) as any;
  await waitFor(async () => (await readLog(harness.logPath)).some((entry) => entry.args.at(-1) === "stop me"), "stop target process");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = (await provider.handle("run/stop", { sessionId: created.session.sessionId })) as any;
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.runId, started.runId);
  const stoppedSession = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
  assert.equal(stoppedSession.incomplete, false);
  assert.equal(stoppedSession.session.status, "cancelled");
  await waitFor(async () => {
    const signals = await readFile(harness.signalPath, "utf8");
    return signals.includes("SIGINT");
  }, "SIGINT signal");
  await waitFor(async () => {
    const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
    return read.incomplete === false && read.session.status === "cancelled";
  }, "no active run after stop");
}

async function testUnsubscribedSubscriberDoesNotTerminateRun() {
  const harness = await createHarness("cursor-unsubscribe-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  const events: AgentNormalizedEvent[] = [];
  const unsubscribe = provider.subscribe((event) => events.push(event));
  process.env.CURSOR_FAKE_RUN = "slow-success";
  await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "keep running" });
  await waitFor(() => events.some((event) => event.event === "status" && event.status === "running"), "running event");
  unsubscribe();
  await waitFor(async () => {
    const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
    return read.incomplete === false && read.session.status === "completed";
  }, "completed after unsubscribe");
}

async function testReloadPreservesTranscriptRenameAndArchiveState() {
  const harness = await createHarness("cursor-reload-test");
  const provider = new CursorProvider();
  const events: AgentNormalizedEvent[] = [];
  provider.subscribe((event) => events.push(event));
  const created = await createSession(provider, harness.project);
  const started = (await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "persist me", model: "gpt-5.5" })) as any;
  await waitFor(() => events.some((event) => event.event === "status" && event.status === "completed" && event.runId === started.runId), "completed before reload");

  const reloaded = new CursorProvider();
  const renamed = (await reloaded.handle("thread/name", { threadId: created.thread.id, name: "Renamed Cursor Session" })) as any;
  assert.equal(renamed.thread.title, "Renamed Cursor Session");
  const read = (await reloaded.handle("thread/read", { threadId: created.thread.id })) as any;
  assert.ok(read.turns.some((turn: any) => turn.id === started.runId && turn.userMessage === "persist me" && turn.toolCall.length));

  await reloaded.handle("thread/archive", { threadId: created.thread.id });
  const listed = (await reloaded.handle("thread/list", {})) as any;
  assert.equal(listed.threads.some((thread: any) => thread.id === created.thread.id), false);
  await reloaded.handle("session/unarchive", { sessionId: created.session.sessionId });
  const restored = (await reloaded.handle("session/list", {})) as any;
  assert.equal(restored.data.some((session: any) => session.sessionId === created.session.sessionId), true);
}

async function testRunningSessionBecomesFailedAfterRestart() {
  const harness = await createHarness("cursor-restart-test");
  const stateDir = path.join(harness.state, "cursor");
  const sessionsDir = path.join(stateDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const index = {
    sessions: [{
      sessionId: "native-chat-1",
      nativeSessionId: "native-chat-1",
      cwd: harness.project,
      title: "Was Running",
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "auto",
      status: "running"
    }]
  };
  await writeFile(path.join(stateDir, "index.json"), JSON.stringify(index), { mode: 0o600 });
  await writeFile(path.join(sessionsDir, "native-chat-1.json"), JSON.stringify({
    transcript: [
      { event: "user_text", text: "keep going", mode: "agent", runId: "run-1", at: 1 },
      { event: "status", status: "running", runId: "run-1", at: 2 },
      { event: "tool_started", toolName: "Await", runId: "run-1", at: 3 }
    ]
  }), { mode: 0o600 });

  const provider = new CursorProvider();
  const read = (await provider.handle("session/read", { sessionId: "native-chat-1" })) as any;
  assert.equal(read.session.status, "failed-after-restart");
  assert.equal(read.session.lastError, "Run was marked failed after server restart.");
  assert.ok(read.session.updatedAt < 1e12, "legacy millisecond timestamps must be stored as seconds");
  assert.equal(read.turns[0].status, "failed-after-restart");
  assert.equal(read.incomplete, false);
}

async function testStopCancelsOrphanedSessionWithoutLiveProcess() {
  const harness = await createHarness("cursor-orphan-stop-test");
  const stateDir = path.join(harness.state, "cursor");
  const sessionsDir = path.join(stateDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(stateDir, "index.json"), JSON.stringify({
    sessions: [{
      sessionId: "orphan-chat",
      nativeSessionId: "orphan-chat",
      cwd: harness.project,
      title: "Stuck Auto",
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "auto",
      status: "failed-after-restart",
      lastError: "Run was marked failed after server restart."
    }]
  }), { mode: 0o600 });
  await writeFile(path.join(sessionsDir, "orphan-chat.json"), JSON.stringify({
    transcript: [
      { event: "user_text", text: "run vertical", mode: "agent", runId: "run-9", at: 1 },
      { event: "status", status: "running", runId: "run-9", at: 2 }
    ]
  }), { mode: 0o600 });

  const provider = new CursorProvider();
  const stopped = (await provider.handle("run/stop", { sessionId: "orphan-chat" })) as any;
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.turn.status, "cancelled");
  const read = (await provider.handle("session/read", { sessionId: "orphan-chat" })) as any;
  assert.equal(read.session.status, "cancelled");
  assert.equal(read.incomplete, false);
  assert.equal(read.turns[0].status, "cancelled");
}

async function testModelListFallbacksDoNotThrowDuringBootstrap() {
  for (const mode of ["empty", "nonzero", "hang"] as const) {
    const harness = await createHarness(`cursor-model-${mode}-test`);
    process.env.CURSOR_FAKE_MODELS = mode;
    if (mode === "hang") process.env.CODEX_WEB_CURSOR_LIST_MODELS_TIMEOUT_MS = "150";
    const provider = new CursorProvider();
    const snapshot = await provider.getSnapshot();
    assert.deepEqual(snapshot.models, [{ id: "auto", name: "Auto" }]);
    assert.equal(snapshot.provider, "cursor");
    assert.equal(snapshot.available, true);
    if (mode === "empty") {
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.authenticated, true);
    } else {
      assert.equal(snapshot.status, "degraded");
      assert.equal(snapshot.authenticated, false);
      assert.match(snapshot.diagnostic || "", /model list unavailable/);
    }
    assert.ok(harness.root);
  }
}

async function testVersionTimeoutDoesNotDisableWorkingCli() {
  const harness = await createHarness("cursor-version-timeout-test");
  process.env.CURSOR_FAKE_VERSION = "hang";
  process.env.CODEX_WEB_CURSOR_VERSION_TIMEOUT_MS = "150";
  const provider = new CursorProvider();
  const snapshot = await provider.getSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.version, "unavailable");
  assert.match(snapshot.diagnostic || "", /version unavailable/);
  assert.deepEqual(snapshot.models, [
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "auto", name: "Auto" }
  ]);
  assert.ok(harness.root);
}

async function testDegradedModelListStillRunsRequestedModel() {
  const harness = await createHarness("cursor-model-degraded-run-test");
  process.env.CURSOR_FAKE_MODELS = "hang";
  process.env.CODEX_WEB_CURSOR_LIST_MODELS_TIMEOUT_MS = "150";
  const provider = new CursorProvider();
  const snapshot = await provider.getSnapshot();
  assert.deepEqual(snapshot.models, [{ id: "auto", name: "Auto" }]);
  assert.match(snapshot.diagnostic || "", /model list unavailable/);

  const created = await createSession(provider, harness.project);
  await provider.handle("run/start", {
    sessionId: created.session.sessionId,
    prompt: "use grok",
    model: "cursor-grok-4.6-high-fast"
  });
  const args = await runArgs(harness);
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("cursor-grok-4.6-high-fast"));
}

async function testUnknownModelIsRejectedWhenCatalogIsReliable() {
  const harness = await createHarness("cursor-model-unknown-test");
  const provider = new CursorProvider();
  await provider.getSnapshot();
  const created = await createSession(provider, harness.project);
  await assert.rejects(
    () => provider.handle("run/start", {
      sessionId: created.session.sessionId,
      prompt: "nope",
      model: "not-a-real-model"
    }),
    /Cursor model is not available: not-a-real-model/
  );
}

async function testNestedCursorEnvIsStrippedFromChildProcesses() {
  const harness = await createHarness("cursor-nested-env-test");
  process.env.CURSOR_CONVERSATION_ID = "should-not-leak";
  process.env.CURSOR_AGENT = "1";
  const provider = new CursorProvider();
  await provider.getSnapshot();
  const log = await readLog(harness.logPath);
  const listInvocation = log.find((entry) => entry.args.includes("--list-models"));
  assert.ok(listInvocation);
  assert.equal(listInvocation.nestedCursor, null);
  assert.equal(listInvocation.cursorAgent, null);
  delete process.env.CURSOR_CONVERSATION_ID;
  delete process.env.CURSOR_AGENT;
  assert.ok(harness.root);
}

async function testNonZeroExitStoresSanitizedTruncatedFailure() {
  const harness = await createHarness("cursor-stderr-test");
  const provider = new CursorProvider();
  const events: AgentNormalizedEvent[] = [];
  provider.subscribe((event) => events.push(event));
  const created = await createSession(provider, harness.project);
  process.env.CURSOR_FAKE_RUN = "stderr-exit";
  const started = (await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "fail" })) as any;
  await waitFor(() => events.some((event) => event.event === "status" && event.runId === started.runId && event.status === "failed"), "failed status");
  const read = (await provider.handle("session/read", { sessionId: created.session.sessionId })) as any;
  assert.equal(read.session.status, "failed");
  assert.equal(read.session.lastError.includes("\u001b"), false);
  assert.equal(read.session.lastError.includes("\u0007"), false);
  assert.ok(read.session.lastError.length <= 12_000);
}

async function testStateFilesArePrivateAndAtomicTempsAreCleanedUp() {
  const harness = await createHarness("cursor-state-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  const stateDir = path.join(harness.state, "cursor");
  const storePath = path.join(stateDir, "index.json");
  const sessionPath = path.join(stateDir, "sessions", `${created.session.nativeSessionId}.json`);
  assert.equal(fileMode((await stat(stateDir)).mode), 0o700);
  assert.equal(fileMode((await stat(path.join(stateDir, "sessions"))).mode), 0o700);
  assert.equal(fileMode((await stat(storePath)).mode), 0o600);
  assert.equal(fileMode((await stat(sessionPath)).mode), 0o600);
  const stateFiles = await readdir(stateDir);
  const sessionFiles = await readdir(path.join(stateDir, "sessions"));
  assert.equal([...stateFiles, ...sessionFiles].some((file) => file.includes(".tmp")), false);
}

async function testBurstTranscriptPersistsInOrder() {
  const harness = await createHarness("cursor-burst-test");
  const provider = new CursorProvider();
  const events: AgentNormalizedEvent[] = [];
  provider.subscribe((event) => events.push(event));
  const created = await createSession(provider, harness.project);
  process.env.CURSOR_FAKE_RUN = "burst";
  const started = (await provider.handle("run/start", { sessionId: created.session.sessionId, prompt: "burst" })) as any;
  await waitFor(
    () => events.some((event) => event.event === "status" && event.runId === started.runId && event.status === "completed"),
    "burst completion"
  );
  const reloaded = new CursorProvider();
  const read = (await reloaded.handle("session/read", { sessionId: created.session.sessionId })) as any;
  const assistantItems = read.transcript.filter((item: any) => item.event === "assistant_text");
  assert.equal(assistantItems.length, 120);
  assert.equal(assistantItems[0].text, "chunk-0 ");
  assert.equal(assistantItems.at(-1).text, "chunk-119 ");
  assert.equal(read.transcript.at(-1).status, "completed");
}

async function testImagesAreWrittenAndReferencedWithAtPath() {
  const harness = await createHarness("cursor-image-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await provider.handle("turn/start", {
    threadId: created.thread.id,
    input: [
      { type: "text", text: "Look at this", text_elements: [] },
      { type: "image", url: png, name: "shot.png" }
    ]
  });
  const args = await runArgs(harness);
  const prompt = args.at(-1) || "";
  assert.match(prompt, /^Look at this\n@/);
  assert.match(prompt, /shot-[A-Za-z0-9]+\.png$/);
  const imagePath = prompt.split("\n")[1].slice(1);
  const imageStat = await stat(imagePath);
  assert.equal(imageStat.isFile(), true);
  assert.equal(fileMode(imageStat.mode), 0o600);
  const addDirIndex = args.indexOf("--add-dir");
  assert.notEqual(addDirIndex, -1);
  assert.equal(args[addDirIndex + 1], path.dirname(imagePath));
}

async function testImageOnlyTurnIsAllowed() {
  const harness = await createHarness("cursor-image-only-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await provider.handle("run/start", {
    sessionId: created.session.sessionId,
    input: [{ type: "image", url: png, name: "only.png" }]
  });
  const args = await runArgs(harness);
  const prompt = args.at(-1) || "";
  assert.match(prompt, /^@/);
  assert.match(prompt, /\.png$/);
}

async function testServerFilesAreReferencedWithoutReencoding() {
  const harness = await createHarness("cursor-server-file-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  const filePath = path.join(harness.project, "notes.txt");
  await writeFile(filePath, "uploaded content\n");
  await provider.handle("turn/start", {
    threadId: created.thread.id,
    input: [
      { type: "text", text: "Read this file", text_elements: [] },
      { type: "mention", name: "notes.txt", path: filePath }
    ]
  });
  const args = await runArgs(harness);
  assert.equal(args.at(-1), `Read this file\n@${filePath}`);
  const addDirIndex = args.indexOf("--add-dir");
  assert.notEqual(addDirIndex, -1);
  assert.equal(args[addDirIndex + 1], path.dirname(filePath));
}

async function testInvalidImageAttachmentIsRejected() {
  const harness = await createHarness("cursor-image-invalid-test");
  const provider = new CursorProvider();
  const created = await createSession(provider, harness.project);
  await assert.rejects(
    () => provider.handle("run/start", {
      sessionId: created.session.sessionId,
      input: [{ type: "image", url: "https://example.com/x.png" }]
    }),
    /data URLs/
  );
  await assert.rejects(
    () => provider.handle("run/start", {
      sessionId: created.session.sessionId,
      prompt: ""
    }),
    /non-empty prompt or file/
  );
}

const tests: Array<[string, () => Promise<void>]> = [
  ["parses model output while stripping controls", testModelParsingStripsControls],
  ["snapshot exposes cursor capabilities", testSnapshotExposesCursorCapabilities],
  ["create session defaults to empty title", testCreateSessionDefaultsToEmptyTitle],
  ["first prompt assigns an immediate fallback title", testFirstPromptAssignsImmediateFallbackTitle],
  ["create session has a dedicated timeout and useful error", testCreateSessionHasDedicatedTimeoutAndUsefulError],
  ["suggest-title uses ask mode without resume", testSuggestTitleUsesAskModeWithoutResume],
  ["suggest-title fails on empty or timeout", testSuggestTitleFailsOnEmptyOrTimeout],
  ["create/start/resume emits partial assistant and tool events", testCreateStartResumePartialAndToolEvents],
  ["agent mode uses unsandboxed allowlist args", testAgentModeUsesUnsandboxedAllowlistArgs],
  ["plan mode uses trust without force or sandbox", testPlanModeUsesTrustWithoutForceOrSandbox],
  ["ask mode uses trust without force or sandbox", testAskModeUsesTrustWithoutForceOrSandbox],
  ["same session rejects concurrent run", testSameSessionRejectsConcurrentRun],
  ["stop sends SIGINT and clears active run", testStopSendsSigintAndClearsActiveRun],
  ["unsubscribed subscriber does not terminate run", testUnsubscribedSubscriberDoesNotTerminateRun],
  ["reload preserves transcript rename and archive state", testReloadPreservesTranscriptRenameAndArchiveState],
  ["running session becomes failed-after-restart", testRunningSessionBecomesFailedAfterRestart],
  ["stop cancels an orphaned session without a live process", testStopCancelsOrphanedSessionWithoutLiveProcess],
  ["model list fallbacks do not throw during bootstrap", testModelListFallbacksDoNotThrowDuringBootstrap],
  ["version timeout does not disable a working CLI", testVersionTimeoutDoesNotDisableWorkingCli],
  ["degraded model list still runs the requested model", testDegradedModelListStillRunsRequestedModel],
  ["unknown model is rejected when the catalog is reliable", testUnknownModelIsRejectedWhenCatalogIsReliable],
  ["nested cursor env is stripped from child processes", testNestedCursorEnvIsStrippedFromChildProcesses],
  ["non-zero exit stores sanitized truncated failure", testNonZeroExitStoresSanitizedTruncatedFailure],
  ["state files are private and atomic temps are cleaned up", testStateFilesArePrivateAndAtomicTempsAreCleanedUp],
  ["burst transcript persists in order", testBurstTranscriptPersistsInOrder],
  ["images are written privately and referenced with @path", testImagesAreWrittenAndReferencedWithAtPath],
  ["image-only turn is allowed", testImageOnlyTurnIsAllowed],
  ["server files are referenced without re-encoding", testServerFilesAreReferencedWithoutReencoding],
  ["invalid image attachment is rejected", testInvalidImageAttachmentIsRejected]
];

async function main() {
  for (const [name, run] of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
  console.log("cursor provider tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
