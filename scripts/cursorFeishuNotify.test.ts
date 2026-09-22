import assert from "node:assert/strict";
import {
  cursorCompletionNotification,
  cursorFeishuSource,
  cursorThreadMeta,
  ensureCursorSessionTitle
} from "../server/cursorFeishuNotify";
import {
  buildChatName,
  buildCompletionMarkdown,
  notifyTurnCompleted,
  type FeishuNotifyConfig
} from "../server/feishuNotify";
import type { AgentNormalizedEvent } from "../server/types";

function statusEvent(status: "running" | "completed" | "failed" | "cancelled", runId = "run-1") {
  return {
    type: "agent:event",
    provider: "cursor",
    sessionId: "cursor-session-1",
    runId,
    event: "status",
    status
  } satisfies AgentNormalizedEvent;
}

assert.equal(cursorCompletionNotification(statusEvent("running")), null);
assert.equal(
  cursorCompletionNotification({
    type: "agent:event",
    provider: "cursor",
    sessionId: "cursor-session-1",
    runId: "run-1",
    event: "result",
    result: { text: "done" }
  }),
  null
);

const completed = cursorCompletionNotification(statusEvent("completed"), 1_800_000_000)!;
assert.equal(completed.method, "turn/completed");
assert.deepEqual(completed.params, {
  provider: "cursor",
  threadId: "cursor-session-1",
  turn: {
    id: "run-1",
    status: "completed",
    completedAt: 1_800_000_000,
    items: []
  }
});

const failed = cursorCompletionNotification({
  ...statusEvent("failed", "run-failed"),
  message: "cursor-agent exited 9"
})!;
assert.match(JSON.stringify(failed.params), /cursor-agent exited 9/);
assert.equal((failed.params as any).turn.status, "failed");
assert.equal((cursorCompletionNotification(statusEvent("cancelled", "run-cancelled"))!.params as any).turn.status, "cancelled");

const meta = cursorThreadMeta({
  thread: { cwd: "/tmp/cursor-project", title: "Cursor verification" },
  session: { preview: "preview" },
  turns: [{ id: "run-1", status: "completed", userMessage: "verify", agentMessage: "CURSOR_OK" }],
  transcript: []
});
assert.equal(meta.cwd, "/tmp/cursor-project");
assert.equal(meta.name, "Cursor verification");
assert.equal(meta.turns?.[0]?.items?.[1]?.type, "agentMessage");
assert.equal(meta.turns?.[0]?.items?.[1]?.text, "CURSOR_OK");

const transcriptFallback = cursorThreadMeta({
  thread: { cwd: "/tmp/cursor-project", title: "Fallback" },
  turns: [{ id: "run-fallback", status: "completed", userMessage: "", agentMessage: "" }],
  transcript: [
    { event: "user_text", runId: "run-fallback", text: "prompt" },
    { event: "result", runId: "run-fallback", text: "RESULT_ONLY" }
  ]
});
assert.equal(transcriptFallback.turns?.[0]?.items?.[1]?.text, "RESULT_ONLY");

assert.equal(buildChatName("Demo", "Cursor Agent"), "Cursor Agent · Demo");
assert.match(
  buildCompletionMarkdown({
    sourceLabel: "Cursor Agent",
    chatName: "Cursor Agent · Demo",
    cwd: "/tmp/demo",
    sessionName: "Demo",
    status: "failed",
    summary: "failure"
  }),
  /❌ \*\*Cursor Agent 回合失败\*\*/
);

const config: FeishuNotifyConfig = {
  enabled: true,
  userOpenId: "ou_test",
  cli: "unused",
  statePath: "/tmp/unused-feishu-state.json",
  chunkMaxBytes: 10_000
};
async function main() {
  const originalLog = console.log;
  console.log = () => {};
  const deliveries: Array<{
    stateThreadId: string;
    chatName: string;
    markdown: string;
    idempotencyKey: string;
    part: number;
    parts: number;
  }> = [];
  const notification = cursorCompletionNotification(statusEvent("completed", "run-dedupe"), 1_800_000_001)!;
  const options = {
    config,
    source: cursorFeishuSource,
    lookupThread: async () => meta,
    deliver: async (input: {
      stateThreadId: string;
      chatName: string;
      markdown: string;
      idempotencyKey: string;
      part: number;
      parts: number;
    }) => {
      deliveries.push(input);
    }
  };

  await Promise.all([
    notifyTurnCompleted(notification, options),
    notifyTurnCompleted(notification, options)
  ]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].stateThreadId, "cursor:cursor-session-1");
  assert.equal(deliveries[0].chatName, "Cursor Agent · Cursor verification");
  assert.match(deliveries[0].markdown, /CURSOR_OK/);
  assert.equal(deliveries[0].part, 1);
  assert.equal(deliveries[0].parts, 1);
  assert.ok(deliveries[0].idempotencyKey.length <= 50);

  const longDeliveries: typeof deliveries = [];
  const longSummary = `CURSOR_LONG_START ${"完整内容 🚀 ".repeat(80)} CURSOR_LONG_END`;
  const longNotification = cursorCompletionNotification(statusEvent("completed", "run-long"), 1_800_000_003)!;
  await notifyTurnCompleted(longNotification, {
    ...options,
    config: { ...config, chunkMaxBytes: 120 },
    lookupThread: async () => ({
      ...meta,
      turns: [{ id: "run-long", items: [{ type: "agentMessage", text: longSummary }] }]
    }),
    deliver: async (input) => {
      longDeliveries.push(input);
    }
  });
  assert.ok(longDeliveries.length > 1);
  assert.deepEqual(longDeliveries.map((item) => item.part), longDeliveries.map((_, index) => index + 1));
  assert.ok(longDeliveries.every((item) => item.parts === longDeliveries.length));
  assert.equal(new Set(longDeliveries.map((item) => item.idempotencyKey)).size, longDeliveries.length);
  assert.match(longDeliveries[0].markdown, /CURSOR_LONG_START/);
  assert.match(longDeliveries.at(-1)?.markdown || "", /CURSOR_LONG_END/);

  let attempts = 0;
  const retryNotification = cursorCompletionNotification(statusEvent("failed", "run-retry"), 1_800_000_002)!;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await notifyTurnCompleted(retryNotification, {
      ...options,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic failure");
      }
    });
    await notifyTurnCompleted(retryNotification, {
      ...options,
      deliver: async () => {
        attempts += 1;
      }
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(attempts, 2);

  let renamedTitle = "";
  const ensureCalls: string[] = [];
  const ensured = await ensureCursorSessionTitle(
    {
      async handle(method: string) {
        ensureCalls.push(method);
        if (method === "session/read") {
          return {
            session: { cwd: "/tmp/cursor-project", title: "", name: "" },
            transcript: [
              { event: "user_text", text: "Help me fix the login redirect bug" },
              { event: "assistant_text", text: "Sure." }
            ]
          };
        }
        if (method === "session/rename") {
          renamedTitle = "Help me fix the login redire";
          return { session: { title: renamedTitle } };
        }
        throw new Error(`unexpected method ${method}`);
      }
    },
    "cursor-session-title"
  );
  assert.equal(ensured, "Help me fix the login redire");
  assert.equal(renamedTitle, "Help me fix the login redire");
  assert.deepEqual(ensureCalls, ["session/read", "session/rename"]);

  const skipped = await ensureCursorSessionTitle(
    {
      async handle(method: string) {
        if (method === "session/read") {
          return { session: { cwd: "/tmp/cursor-project", title: "Already Named" }, transcript: [] };
        }
        throw new Error(`unexpected method ${method}`);
      }
    },
    "cursor-session-named"
  );
  assert.equal(skipped, "Already Named");

  const fallbackEnsured = await ensureCursorSessionTitle(
    {
      async handle(method: string, params?: unknown) {
        if (method === "session/read") {
          return {
            session: { cwd: "/tmp/cursor-project", title: "cursor-project" },
            transcript: [{ event: "user_text", text: "Help me fix the login redirect bug. Thanks." }]
          };
        }
        if (method === "session/rename") {
          assert.equal((params as { title?: string }).title, "Help me fix the login redire");
          return { session: { title: (params as { title?: string }).title } };
        }
        throw new Error(`unexpected method ${method}`);
      }
    },
    "cursor-session-fallback"
  );
  assert.equal(fallbackEnsured, "Help me fix the login redire");

  console.log = originalLog;
  console.log("cursor Feishu notification tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
