import assert from "node:assert/strict";
import {
  buildChatName,
  buildCompletionMarkdown,
  buildCompletionMarkdownMessages,
  buildUserInputMarkdownMessages,
  buildUserInputQuestionMarkdown,
  extractSummary,
  formatCompletedAt,
  isSubagentThread,
  notifyTurnCompleted,
  notifyUserInputRequested,
  parseUserInputRequest,
  splitSummary,
  statusText,
  type FeishuDelivery,
  type FeishuNotifyConfig
} from "../server/feishuNotify";
import type { JsonRpcRequest } from "../server/types";

const config: FeishuNotifyConfig = {
  enabled: true,
  userOpenId: "ou_test_owner",
  cli: "lark-cli",
  statePath: "/tmp/feishu-notify-test-unused.json",
  chunkMaxBytes: 10_000
};

function userInputRequest(suffix: string, overrides: Record<string, unknown> = {}): JsonRpcRequest {
  return {
    id: `request-${suffix}`,
    method: "item/tool/requestUserInput",
    params: {
      threadId: `thread-${suffix}`,
      turnId: `turn-${suffix}`,
      itemId: `item-${suffix}`,
      questions: [
        {
          id: "route",
          header: "发布方式",
          question: "请选择发布方式 🚀",
          isOther: true,
          isSecret: false,
          options: [
            { label: "安全切换", description: "等待队列空闲后切换。" },
            { label: "仅候选", description: "只验证候选构建。" }
          ]
        },
        {
          id: "secret",
          header: "敏感输入",
          question: "请填写临时凭据。",
          isOther: false,
          isSecret: true,
          options: null,
          answer: "TOP_SECRET_MUST_NOT_APPEAR"
        }
      ],
      ...overrides
    }
  };
}

async function main() {
  assert.equal(buildChatName("修复飞书通知"), "Codex · 修复飞书通知");
  assert.equal(buildChatName("   "), "Codex · Untitled");
  assert.ok(buildChatName("x".repeat(80)).length <= 60);

  assert.equal(statusText("completed"), "completed");
  assert.equal(statusText({ type: "completed" }), "completed");
  assert.equal(statusText(null), "completed");

  assert.equal(
    extractSummary([
      { type: "userMessage", text: "hi" },
      { type: "agentMessage", text: "first" },
      { type: "agentMessage", text: "final answer" }
    ]),
    "final answer"
  );
  assert.equal(extractSummary([{ type: "userMessage", text: "hi" }]), "(无助手总结)");
  assert.equal(extractSummary([{ type: "agentMessage", text: "abcdefghij" }]), "abcdefghij");
  assert.equal(extractSummary([{ type: "plan", text: "plan only" }]), "plan only");
  assert.equal(
    extractSummary([{ type: "agentMessage", content: [{ text: "from content" }] } as never]),
    "from content"
  );

  const longSummary = `第一段包含中文、emoji 🚀 和一个很长的路径 /tmp/${"segment/".repeat(20)}\n\n${"完整输出 ".repeat(30)}`;
  const summaryChunks = splitSummary(longSummary, 72);
  assert.ok(summaryChunks.length > 1);
  assert.equal(summaryChunks.join(""), longSummary);
  assert.ok(summaryChunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 72));

  const markdown = buildCompletionMarkdown({
    chatName: "Codex · demo",
    completedAt: 1_753_507_200,
    cwd: "/tmp/demo",
    sessionName: "demo",
    status: { type: "completed" },
    summary: "done"
  });
  assert.match(markdown, /✅ \*\*Codex 回合完成\*\*/);
  assert.match(markdown, /\*\*群名\*\*：Codex · demo/);
  assert.match(markdown, /\*\*目录\*\*：`\/tmp\/demo`/);
  assert.match(markdown, /\*\*Session\*\*：demo/);
  assert.match(markdown, /\*\*状态\*\*：completed/);
  assert.match(markdown, /done/);
  assert.equal(formatCompletedAt(1_753_507_200).length >= 19, true);

  const markdownMessages = buildCompletionMarkdownMessages(
    {
      chatName: "Codex · demo",
      completedAt: 1_753_507_200,
      cwd: "/tmp/demo",
      sessionName: "demo",
      status: { type: "completed" },
      summary: longSummary
    },
    72
  );
  assert.equal(markdownMessages.length, summaryChunks.length);
  assert.match(markdownMessages[0], /总结（1\//);
  assert.match(markdownMessages[1], /总结续页（2\//);
  assert.ok(markdownMessages.some((message) => message.includes("segment/")));
  assert.ok(markdownMessages.at(-1)?.includes("完整输出"));

  assert.equal(isSubagentThread(undefined), false);
  assert.equal(isSubagentThread({ cwd: "/tmp" }), false);
  assert.equal(
    isSubagentThread({
      parentThreadId: "parent-1",
      source: { subAgent: { thread_spawn: { parent_thread_id: "parent-1" } } },
      agentNickname: "Harvey"
    }),
    true
  );
  assert.equal(
    isSubagentThread({
      forkedFromId: "parent-1",
      agentRole: "explore"
    }),
    true
  );
  assert.equal(
    isSubagentThread({
      forkedFromId: "parent-1",
      name: "user side fork"
    }),
    false
  );

  const parsed = parseUserInputRequest(userInputRequest("format"));
  assert.ok(parsed);
  assert.equal(parsed.questions.length, 2);
  const questionMarkdown = buildUserInputQuestionMarkdown(parsed.questions);
  assert.match(questionMarkdown, /### 1\. 发布方式/);
  assert.match(questionMarkdown, /\*\*1\. 安全切换\*\* — 等待队列空闲后切换。/);
  assert.match(questionMarkdown, /也可以在 Console 中输入其他答案/);
  assert.match(questionMarkdown, /仅在 Console 中填写/);
  assert.doesNotMatch(questionMarkdown, /TOP_SECRET_MUST_NOT_APPEAR/);
  assert.equal(parseUserInputRequest({ ...userInputRequest("wrong"), method: "item/fileChange/requestApproval" }), null);
  assert.equal(parseUserInputRequest(userInputRequest("missing", { itemId: "" })), null);
  assert.equal(parseUserInputRequest(userInputRequest("empty-options", {
    questions: [{
      id: "empty",
      header: "Empty",
      question: "This malformed choice has no options.",
      isOther: false,
      isSecret: false,
      options: []
    }]
  })), null);

  const longRequest = userInputRequest("long", {
    questions: [
      {
        id: "long",
        header: "长问题",
        question: `/tmp/${"deep-path/".repeat(30)} 🚀`,
        isOther: false,
        isSecret: false,
        options: [{ label: "完整保留", description: "超长说明".repeat(80) }]
      }
    ]
  });
  const longDetails = parseUserInputRequest(longRequest);
  assert.ok(longDetails);
  const longQuestionMarkdown = buildUserInputQuestionMarkdown(longDetails.questions);
  assert.equal(splitSummary(longQuestionMarkdown, 72).join(""), longQuestionMarkdown);
  const userInputMessages = buildUserInputMarkdownMessages({
    chatName: "Codex · long",
    requestedAt: 1_753_507_200,
    cwd: "/tmp/demo",
    sessionName: "long",
    questions: longDetails.questions
  }, 72);
  assert.ok(userInputMessages.length > 1);
  assert.match(userInputMessages[0], /Codex Plan 等待你的选择/);
  assert.match(userInputMessages[0], /问题（1\//);
  assert.match(userInputMessages[1], /Plan 选择续页（2\//);
  assert.ok(userInputMessages.some((message) => message.includes("deep-path/")));
  assert.ok(userInputMessages.at(-1)?.includes("飞书消息用于知会"));

  const lookupThread = async () => ({
    cwd: "/tmp/plan-project",
    name: "Plan notification test",
    preview: "",
    turns: []
  });

  let ignoredDeliveries = 0;
  const countIgnored: FeishuDelivery = async () => {
    ignoredDeliveries += 1;
  };
  await notifyUserInputRequested(
    { id: "approval", method: "item/fileChange/requestApproval", params: { threadId: "thread" } },
    { config, lookupThread, deliver: countIgnored }
  );
  await notifyUserInputRequested(userInputRequest("disabled"), {
    config: { ...config, enabled: false },
    lookupThread,
    deliver: countIgnored
  });
  await notifyUserInputRequested(userInputRequest("invalid", { turnId: "" }), {
    config,
    lookupThread,
    deliver: countIgnored
  });
  await notifyUserInputRequested(userInputRequest("subagent"), {
    config,
    lookupThread: async () => ({
      cwd: "/tmp",
      parentThreadId: "parent",
      agentRole: "explore"
    }),
    deliver: countIgnored
  });
  assert.equal(ignoredDeliveries, 0);

  const concurrentDeliveries: Parameters<FeishuDelivery>[0][] = [];
  const concurrentRequest = userInputRequest("concurrent");
  await Promise.all([
    notifyUserInputRequested(concurrentRequest, {
      config,
      lookupThread,
      deliver: async (delivery) => {
        concurrentDeliveries.push(delivery);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }),
    notifyUserInputRequested(concurrentRequest, {
      config,
      lookupThread,
      deliver: async (delivery) => {
        concurrentDeliveries.push(delivery);
      }
    })
  ]);
  assert.equal(concurrentDeliveries.length, 1);
  assert.match(concurrentDeliveries[0].markdown, /Plan notification test/);
  assert.match(concurrentDeliveries[0].markdown, /安全切换/);
  assert.doesNotMatch(concurrentDeliveries[0].markdown, /TOP_SECRET_MUST_NOT_APPEAR/);

  let retryAttempts = 0;
  let retrySuccesses = 0;
  const retryRequest = userInputRequest("retry");
  const retryDelivery: FeishuDelivery = async () => {
    retryAttempts += 1;
    if (retryAttempts === 1) throw new Error("synthetic delivery failure");
    retrySuccesses += 1;
  };
  await notifyUserInputRequested(retryRequest, { config, lookupThread, deliver: retryDelivery });
  await notifyUserInputRequested(retryRequest, { config, lookupThread, deliver: retryDelivery });
  assert.equal(retryAttempts, 2);
  assert.equal(retrySuccesses, 1);

  const inputKeys: string[] = [];
  const completionKeys: string[] = [];
  const sharedTurnRequest = userInputRequest("distinct", { turnId: "shared-turn" });
  await notifyUserInputRequested(sharedTurnRequest, {
    config,
    lookupThread,
    deliver: async (delivery) => {
      inputKeys.push(delivery.idempotencyKey);
    }
  });
  await notifyTurnCompleted({
    method: "turn/completed",
    params: {
      threadId: "thread-distinct",
      turn: {
        id: "shared-turn",
        status: "completed",
        items: [{ type: "agentMessage", text: "done" }]
      }
    }
  }, {
    config,
    lookupThread,
    deliver: async (delivery) => {
      completionKeys.push(delivery.idempotencyKey);
    }
  });
  assert.equal(inputKeys.length, 1);
  assert.equal(completionKeys.length, 1);
  assert.notEqual(inputKeys[0], completionKeys[0]);

  const multipartDeliveries: Parameters<FeishuDelivery>[0][] = [];
  await notifyUserInputRequested(longRequest, {
    config: { ...config, chunkMaxBytes: 72 },
    lookupThread,
    deliver: async (delivery) => {
      multipartDeliveries.push(delivery);
    }
  });
  assert.ok(multipartDeliveries.length > 1);
  assert.equal(new Set(multipartDeliveries.map((delivery) => delivery.idempotencyKey)).size, multipartDeliveries.length);
  assert.deepEqual(
    multipartDeliveries.map((delivery) => delivery.part),
    Array.from({ length: multipartDeliveries.length }, (_, index) => index + 1)
  );
  assert.ok(multipartDeliveries.every((delivery) => delivery.parts === multipartDeliveries.length));

  console.log("feishuNotify.test.ts: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
