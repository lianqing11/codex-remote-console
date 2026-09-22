import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentNormalizedEvent, JsonRpcNotification, JsonRpcRequest } from "./types";

const terminalStreamStatuses = new Set(["completed", "failed", "cancelled", "failed-after-restart"]);

export function streamCompletionNotification(
  event: AgentNormalizedEvent,
  completedAt = Math.floor(Date.now() / 1000)
): JsonRpcNotification | null {
  if (event.event !== "status" || !terminalStreamStatuses.has(event.status) || !event.runId) return null;
  return {
    method: "turn/completed",
    params: {
      provider: event.provider,
      threadId: event.sessionId,
      turn: {
        id: event.runId,
        status: event.status,
        completedAt,
        items: event.message
          ? [{ id: `${event.runId}-status`, type: "agentMessage", text: event.message }]
          : []
      }
    }
  };
}

const execFileAsync = promisify(execFile);

type ChatBinding = {
  chatId: string;
  chatName: string;
  updatedAt: number;
};

type FeishuState = {
  chats: Record<string, ChatBinding>;
};

type TurnItem = {
  id?: string;
  type?: string;
  text?: string;
  content?: unknown[];
};

type TurnLike = {
  id?: string;
  status?: unknown;
  completedAt?: number | null;
  items?: TurnItem[];
};

export type UserInputOption = {
  label: string;
  description: string;
};

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
};

export type UserInputRequestDetails = {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
};

export type FeishuNotifyConfig = {
  enabled: boolean;
  userOpenId: string;
  cli: string;
  statePath: string;
  chunkMaxBytes: number;
};

export type FeishuNotifySource = {
  id: string;
  label: string;
};

export type FeishuDelivery = (input: {
  config: FeishuNotifyConfig;
  stateThreadId: string;
  chatName: string;
  markdown: string;
  idempotencyKey: string;
  part: number;
  parts: number;
}) => Promise<void>;

const defaultChunkMaxBytes = 10_000;
const naturalChunkBreak = /[\s,.;:!?，。；：！？、]/u;
const notifiedTurns = new Set<string>();
const notifiedUserInputs = new Set<string>();
const chatLocks = new Map<string, Promise<ChatBinding>>();

function envFlag(name: string) {
  const value = (process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function loadFeishuNotifyConfig(): FeishuNotifyConfig {
  const chunkMaxBytes = Number(
    process.env.CODEX_WEB_FEISHU_CHUNK_MAX_BYTES ||
      process.env.CODEX_WEB_FEISHU_SUMMARY_MAX ||
      defaultChunkMaxBytes
  );
  return {
    enabled: envFlag("CODEX_WEB_FEISHU_NOTIFY"),
    userOpenId: (process.env.CODEX_WEB_FEISHU_USER_OPEN_ID || "").trim(),
    cli: (process.env.CODEX_WEB_FEISHU_CLI || "lark-cli").trim() || "lark-cli",
    statePath:
      (process.env.CODEX_WEB_FEISHU_STATE_PATH || "").trim() ||
      path.join(process.cwd(), ".codex_web", "feishu-chats.json"),
    chunkMaxBytes:
      Number.isFinite(chunkMaxBytes) && chunkMaxBytes >= 256
        ? Math.floor(chunkMaxBytes)
        : defaultChunkMaxBytes
  };
}

export function buildChatName(sessionName: string, sourceLabel = "Codex") {
  const base = `${sourceLabel} · ${sessionName.trim() || "Untitled"}`;
  return base.length <= 60 ? base : `${base.slice(0, 59)}…`;
}

export function formatCompletedAt(completedAt?: number | null) {
  const seconds = completedAt && completedAt > 0 ? completedAt : Math.floor(Date.now() / 1000);
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function statusText(status: unknown) {
  if (typeof status === "string" && status.trim()) return status.trim();
  if (status && typeof status === "object" && "type" in status) {
    const type = (status as { type?: unknown }).type;
    if (typeof type === "string" && type.trim()) return type.trim();
  }
  return "completed";
}

export function completionTitle(sourceLabel: string, status: unknown) {
  const normalized = statusText(status).toLowerCase();
  if (normalized === "cancelled" || normalized === "canceled") {
    return `⏹️ **${sourceLabel} 回合已取消**`;
  }
  if (normalized === "failed" || normalized === "failed-after-restart" || normalized === "error") {
    return `❌ **${sourceLabel} 回合失败**`;
  }
  return `✅ **${sourceLabel} 回合完成**`;
}

function itemPlainText(item: TurnItem | undefined) {
  if (!item) return "";
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  if (Array.isArray(item.content)) {
    const parts = item.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("\n").trim();
  }
  return "";
}

export function extractSummary(items: TurnItem[] | undefined) {
  if (!items?.length) return "(无助手总结)";

  const preferredTypes = ["agentMessage", "plan"];
  for (const type of preferredTypes) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.type !== type) continue;
      const text = itemPlainText(item);
      if (!text) continue;
      return text;
    }
  }

  return "(无助手总结)";
}

/** Split on natural boundaries while preserving every character of the final answer. */
export function splitSummary(summary: string, maxBytes: number) {
  const text = summary.trim() ? summary : "(无助手总结)";
  const byteLimit = Math.max(4, Math.floor(maxBytes));
  if (Buffer.byteLength(text, "utf8") <= byteLimit) return [text];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let cursor = offset;
    let bytes = 0;
    let preferredBreak = -1;
    while (cursor < text.length) {
      const codePoint = text.codePointAt(cursor);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const nextBytes = Buffer.byteLength(character, "utf8");
      if (bytes + nextBytes > byteLimit) break;
      bytes += nextBytes;
      cursor += character.length;
      if (bytes >= byteLimit * 0.55 && naturalChunkBreak.test(character)) {
        preferredBreak = cursor;
      }
    }

    if (cursor === offset) {
      const codePoint = text.codePointAt(offset);
      cursor = offset + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
    }
    const end = preferredBreak > offset ? preferredBreak : cursor;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function isMissingSummary(summary: string) {
  return !summary || summary === "(无助手总结)";
}

export function buildCompletionMarkdown(input: {
  sourceLabel?: string;
  chatName: string;
  completedAt?: number | null;
  cwd: string;
  sessionName: string;
  status: unknown;
  summary: string;
  part?: number;
  parts?: number;
}) {
  const part = input.part || 1;
  const parts = input.parts || 1;
  const lines = [
    completionTitle(input.sourceLabel || "Codex", input.status),
    "",
    `- **群名**：${input.chatName}`,
    `- **时间**：${formatCompletedAt(input.completedAt)}`,
    `- **目录**：\`${input.cwd || "(unknown)"}\``,
    `- **Session**：${input.sessionName || "Untitled"}`,
    `- **状态**：${statusText(input.status)}`,
    "",
    parts > 1 ? `**总结（${part}/${parts}）**` : "**总结**",
    "",
    input.summary || "(无助手总结)"
  ];
  return lines.join("\n");
}

export function buildCompletionMarkdownMessages(
  input: Parameters<typeof buildCompletionMarkdown>[0],
  maxSummaryBytes: number
) {
  const chunks = splitSummary(input.summary, maxSummaryBytes);
  return chunks.map((summary, index) => {
    const part = index + 1;
    if (index === 0) {
      return buildCompletionMarkdown({ ...input, summary, part, parts: chunks.length });
    }
    return [
      `↪️ **${input.sourceLabel || "Codex"} 总结续页（${part}/${chunks.length}）**`,
      "",
      summary
    ].join("\n");
  });
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseUserInputRequest(request: JsonRpcRequest): UserInputRequestDetails | null {
  if (request.method !== "item/tool/requestUserInput") return null;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : null;
  if (!params) return null;

  const threadId = nonEmptyString(params.threadId);
  const turnId = nonEmptyString(params.turnId);
  const itemId = nonEmptyString(params.itemId);
  if (!threadId || !turnId || !itemId || !Array.isArray(params.questions) || !params.questions.length) {
    return null;
  }

  const questions: UserInputQuestion[] = [];
  for (const rawQuestion of params.questions) {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return null;
    const questionRecord = rawQuestion as Record<string, unknown>;
    const id = nonEmptyString(questionRecord.id);
    const header = nonEmptyString(questionRecord.header);
    const question = nonEmptyString(questionRecord.question);
    if (!id || !header || !question) return null;

    let options: UserInputOption[] | null = null;
    if (questionRecord.options !== null && questionRecord.options !== undefined) {
      if (!Array.isArray(questionRecord.options)) return null;
      if (!questionRecord.options.length) return null;
      options = [];
      for (const rawOption of questionRecord.options) {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return null;
        const optionRecord = rawOption as Record<string, unknown>;
        const label = nonEmptyString(optionRecord.label);
        if (!label || typeof optionRecord.description !== "string") return null;
        options.push({ label, description: optionRecord.description.trim() });
      }
    }

    questions.push({
      id,
      header,
      question,
      isOther: questionRecord.isOther === true,
      isSecret: questionRecord.isSecret === true,
      options
    });
  }

  return { threadId, turnId, itemId, questions };
}

export function buildUserInputQuestionMarkdown(questions: UserInputQuestion[]) {
  return questions
    .map((question, questionIndex) => {
      const lines = [
        `### ${questionIndex + 1}. ${question.header}`,
        "",
        question.question
      ];
      if (question.options?.length) {
        lines.push("");
        question.options.forEach((option, optionIndex) => {
          const description = option.description ? ` — ${option.description}` : "";
          lines.push(`- **${optionIndex + 1}. ${option.label}**${description}`);
        });
      }
      if (!question.options?.length) {
        lines.push("", "- 请在 Coding Agent Console 中填写答案。");
      } else if (question.isOther) {
        lines.push("", "- 也可以在 Console 中输入其他答案。");
      }
      if (question.isSecret) {
        lines.push("", "- 🔒 此题需要敏感输入，请仅在 Console 中填写。");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function buildUserInputMarkdown(input: {
  sourceLabel?: string;
  chatName: string;
  requestedAt?: number | null;
  cwd: string;
  sessionName: string;
  questionMarkdown: string;
  part?: number;
  parts?: number;
}) {
  const sourceLabel = input.sourceLabel || "Codex";
  const part = input.part || 1;
  const parts = input.parts || 1;
  const lines = [
    `🟠 **${sourceLabel} Plan 等待你的选择**`,
    "",
    `- **群名**：${input.chatName}`,
    `- **时间**：${formatCompletedAt(input.requestedAt)}`,
    `- **目录**：\`${input.cwd || "(unknown)"}\``,
    `- **Session**：${input.sessionName || "Untitled"}`,
    "- **操作**：请返回 Coding Agent Console 完成选择。",
    "",
    parts > 1 ? `**问题（${part}/${parts}）**` : "**问题**",
    "",
    input.questionMarkdown
  ];
  if (part === parts) {
    lines.push("", "选择仍在 Coding Agent Console 中提交，飞书消息用于知会。");
  }
  return lines.join("\n").trimEnd();
}

export function buildUserInputMarkdownMessages(input: {
  sourceLabel?: string;
  chatName: string;
  requestedAt?: number | null;
  cwd: string;
  sessionName: string;
  questions: UserInputQuestion[];
}, maxQuestionBytes: number) {
  const questionMarkdown = buildUserInputQuestionMarkdown(input.questions);
  const chunks = splitSummary(questionMarkdown, maxQuestionBytes);
  return chunks.map((chunk, index) => {
    const part = index + 1;
    if (index === 0) {
      return buildUserInputMarkdown({
        ...input,
        questionMarkdown: chunk,
        part,
        parts: chunks.length
      });
    }
    const lines = [
      `↪️ **${input.sourceLabel || "Codex"} Plan 选择续页（${part}/${chunks.length}）**`,
      "",
      chunk
    ];
    if (part === chunks.length) {
      lines.push("", "选择仍在 Coding Agent Console 中提交，飞书消息用于知会。");
    }
    return lines.join("\n").trimEnd();
  });
}

async function readState(statePath: string): Promise<FeishuState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as FeishuState;
    if (!parsed || typeof parsed !== "object" || !parsed.chats || typeof parsed.chats !== "object") {
      return { chats: {} };
    }
    return { chats: parsed.chats };
  } catch {
    return { chats: {} };
  }
}

async function writeState(statePath: string, state: FeishuState) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseCliJson(stdout: string) {
  const text = stdout.trim();
  if (!text) throw new Error("lark-cli returned empty output");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error(`lark-cli returned non-JSON output: ${text.slice(0, 240)}`);
  }
}

async function runCli(cli: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync(cli, args, {
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env
  });
  const payload = parseCliJson(stdout || stderr || "");
  if (payload.ok === false) {
    throw new Error(`lark-cli failed: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

function extractChatId(payload: Record<string, unknown>) {
  const stack: unknown[] = [payload];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === "string" && /^oc_[a-zA-Z0-9]+$/.test(current)) return current;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const value of Object.values(current as Record<string, unknown>)) stack.push(value);
  }
  throw new Error(`Unable to parse chat_id from lark-cli response: ${JSON.stringify(payload).slice(0, 500)}`);
}

async function createChat(config: FeishuNotifyConfig, chatName: string) {
  const payload = await runCli(config.cli, [
    "im",
    "+chat-create",
    "--as",
    "bot",
    "--name",
    chatName,
    "--users",
    config.userOpenId,
    "--type",
    "private",
    "--set-bot-manager",
    "--json"
  ]);
  return extractChatId(payload);
}

async function updateChatName(config: FeishuNotifyConfig, chatId: string, chatName: string) {
  await runCli(config.cli, ["im", "+chat-update", "--as", "bot", "--chat-id", chatId, "--name", chatName, "--json"]);
}

async function sendMarkdown(
  config: FeishuNotifyConfig,
  chatId: string,
  markdown: string,
  idempotencyKey: string
) {
  await runCli(config.cli, [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    chatId,
    "--markdown",
    markdown,
    "--idempotency-key",
    idempotencyKey,
    "--json"
  ]);
}

function messageIdempotencyKey(stateThreadId: string, turnId: string, part: number) {
  const digest = createHash("sha256")
    .update(`${stateThreadId}:${turnId}:${part}`)
    .digest("hex")
    .slice(0, 40);
  return `cwc-${digest}`;
}

function userInputMessageIdempotencyKey(
  stateThreadId: string,
  turnId: string,
  itemId: string,
  part: number
) {
  const digest = createHash("sha256")
    .update(`${stateThreadId}:input:${turnId}:${itemId}:${part}`)
    .digest("hex")
    .slice(0, 40);
  return `cwc-${digest}`;
}

async function ensureChat(config: FeishuNotifyConfig, threadId: string, chatName: string) {
  const existing = chatLocks.get(threadId);
  if (existing) return existing;

  const task = (async () => {
    const state = await readState(config.statePath);
    const bound = state.chats[threadId];
    if (bound?.chatId) {
      if (bound.chatName !== chatName) {
        try {
          await updateChatName(config, bound.chatId, chatName);
          bound.chatName = chatName;
          bound.updatedAt = Date.now();
          state.chats[threadId] = bound;
          await writeState(config.statePath, state);
        } catch (error) {
          console.warn(
            "[feishu-notify] failed to rename chat:",
            error instanceof Error ? error.message : error
          );
        }
      }
      return bound;
    }

    const chatId = await createChat(config, chatName);
    const next: ChatBinding = { chatId, chatName, updatedAt: Date.now() };
    state.chats[threadId] = next;
    await writeState(config.statePath, state);
    return next;
  })();

  chatLocks.set(threadId, task);
  try {
    return await task;
  } finally {
    chatLocks.delete(threadId);
  }
}

export type ThreadMeta = {
  cwd?: string;
  name?: string | null;
  preview?: string;
  turns?: TurnLike[];
  parentThreadId?: string | null;
  forkedFromId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  source?: unknown;
};

export type ThreadMetaLookup = (
  threadId: string,
  options?: { includeTurns?: boolean }
) => Promise<ThreadMeta>;

function claimDedupeKey(keys: Set<string>, key: string) {
  if (keys.has(key)) return false;
  if (keys.size >= 2000) {
    const oldest = keys.values().next().value;
    if (oldest) keys.delete(oldest);
  }
  keys.add(key);
  return true;
}

async function resolveThreadContext(threadId: string, lookupThread?: ThreadMetaLookup) {
  let cwd = "";
  let sessionName = "Untitled";
  let threadMeta: ThreadMeta | undefined;
  if (lookupThread) {
    try {
      threadMeta = await lookupThread(threadId);
      cwd = typeof threadMeta.cwd === "string" ? threadMeta.cwd : "";
      sessionName = (threadMeta.name || threadMeta.preview || "").trim() || "Untitled";
    } catch (error) {
      console.warn(
        "[feishu-notify] thread lookup failed:",
        error instanceof Error ? error.message : error
      );
    }
  }
  return { cwd, sessionName, threadMeta };
}

/** Multi-agent subagent forks get their own threadId; they must not open a new Feishu group. */
export function isSubagentThread(meta: ThreadMeta | null | undefined) {
  if (!meta) return false;
  const source = meta.source;
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (record.subAgent || record.subagent) return true;
  }
  const hasParent =
    (typeof meta.parentThreadId === "string" && meta.parentThreadId.trim() !== "") ||
    (typeof meta.forkedFromId === "string" && meta.forkedFromId.trim() !== "");
  if (!hasParent) return false;
  return Boolean(
    (typeof meta.agentNickname === "string" && meta.agentNickname.trim()) ||
      (typeof meta.agentRole === "string" && meta.agentRole.trim())
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnItemsFromMeta(turns: TurnLike[] | undefined, turnId: string) {
  if (!turns?.length) return [];
  const matched = turns.find((candidate) => candidate?.id === turnId) || turns[turns.length - 1];
  return matched?.items || [];
}

async function resolveTurnItems(
  turn: TurnLike,
  threadId: string,
  lookupThread?: ThreadMetaLookup,
  initialTurns?: TurnLike[]
) {
  const direct = turn.items || [];
  if (!isMissingSummary(extractSummary(direct))) {
    return direct;
  }

  const fromInitial = turnItemsFromMeta(initialTurns, turn.id || "");
  if (!isMissingSummary(extractSummary(fromInitial))) {
    return fromInitial;
  }

  if (!lookupThread) return direct;

  for (const delayMs of [400, 1200]) {
    await sleep(delayMs);
    try {
      const meta = await lookupThread(threadId, { includeTurns: true });
      const items = turnItemsFromMeta(meta.turns, turn.id || "");
      if (!isMissingSummary(extractSummary(items))) {
        return items;
      }
    } catch (error) {
      console.warn(
        "[feishu-notify] turn item lookup failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  return direct;
}

export async function notifyTurnCompleted(
  notification: JsonRpcNotification,
  options: {
    config?: FeishuNotifyConfig;
    lookupThread?: ThreadMetaLookup;
    source?: FeishuNotifySource;
    deliver?: FeishuDelivery;
  } = {}
) {
  const config = options.config || loadFeishuNotifyConfig();
  const source = options.source || { id: "codex", label: "Codex" };
  if (!config.enabled) return;
  if (!config.userOpenId) {
    console.warn("[feishu-notify] skipped: missing CODEX_WEB_FEISHU_USER_OPEN_ID");
    return;
  }

  const params = (notification.params || {}) as {
    threadId?: string;
    turn?: TurnLike;
  };
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  const turn = params.turn;
  if (!threadId || !turn?.id) return;

  const stateThreadId = source.id === "codex" ? threadId : `${source.id}:${threadId}`;
  const dedupeKey = `${stateThreadId}:${turn.id}`;
  if (!claimDedupeKey(notifiedTurns, dedupeKey)) return;

  const { cwd, sessionName, threadMeta } = await resolveThreadContext(threadId, options.lookupThread);
  const metaTurns = threadMeta?.turns;

  if (isSubagentThread(threadMeta)) {
    console.log(
      `[feishu-notify] skip subagent thread ${threadId}` +
        (threadMeta?.agentNickname ? ` (${threadMeta.agentNickname})` : "") +
        `; parent=${threadMeta?.parentThreadId || threadMeta?.forkedFromId || "?"}`
    );
    return;
  }

  const chatName = buildChatName(sessionName, source.label);
  const items = await resolveTurnItems(turn, threadId, options.lookupThread, metaTurns);
  const summary = extractSummary(items);
  if (isMissingSummary(summary)) {
    console.warn(
      `[feishu-notify] missing summary for ${threadId}:${turn.id}; notification items=${turn.items?.length || 0}`
    );
  }
  const markdownMessages = buildCompletionMarkdownMessages({
    sourceLabel: source.label,
    chatName,
    completedAt: turn.completedAt,
    cwd,
    sessionName,
    status: turn.status,
    summary
  }, config.chunkMaxBytes);

  try {
    const chat = options.deliver ? null : await ensureChat(config, stateThreadId, chatName);
    for (let index = 0; index < markdownMessages.length; index += 1) {
      const markdown = markdownMessages[index];
      const idempotencyKey = messageIdempotencyKey(stateThreadId, turn.id, index + 1);
      const delivery = {
        config,
        stateThreadId,
        chatName,
        markdown,
        idempotencyKey,
        part: index + 1,
        parts: markdownMessages.length
      };
      if (options.deliver) {
        await options.deliver(delivery);
      } else if (chat) {
        await sendMarkdown(config, chat.chatId, markdown, idempotencyKey);
      }
    }
    if (options.deliver) {
      console.log(
        `[feishu-notify] sent turn completion for ${source.id}:${threadId} (${markdownMessages.length} message${markdownMessages.length === 1 ? "" : "s"})`
      );
      return;
    }
    console.log(
      `[feishu-notify] sent turn completion for ${source.id}:${threadId} -> ${chat?.chatId} (${markdownMessages.length} message${markdownMessages.length === 1 ? "" : "s"})`
    );
  } catch (error) {
    notifiedTurns.delete(dedupeKey);
    console.warn(`[feishu-notify] failed (${source.id}):`, error instanceof Error ? error.message : error);
  }
}

export async function notifyUserInputRequested(
  request: JsonRpcRequest,
  options: {
    config?: FeishuNotifyConfig;
    lookupThread?: ThreadMetaLookup;
    source?: FeishuNotifySource;
    deliver?: FeishuDelivery;
  } = {}
) {
  const config = options.config || loadFeishuNotifyConfig();
  const source = options.source || { id: "codex", label: "Codex" };
  if (!config.enabled || request.method !== "item/tool/requestUserInput") return;
  if (!config.userOpenId) {
    console.warn("[feishu-notify] skipped: missing CODEX_WEB_FEISHU_USER_OPEN_ID");
    return;
  }

  const details = parseUserInputRequest(request);
  if (!details) {
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    console.warn(
      "[feishu-notify] skipped Plan input: invalid fields" +
        ` threadId=${Boolean(nonEmptyString(params.threadId))}` +
        ` turnId=${Boolean(nonEmptyString(params.turnId))}` +
        ` itemId=${Boolean(nonEmptyString(params.itemId))}` +
        ` questions=${Array.isArray(params.questions) ? params.questions.length : 0}`
    );
    return;
  }

  const stateThreadId = source.id === "codex" ? details.threadId : `${source.id}:${details.threadId}`;
  const dedupeKey = `input:${stateThreadId}:${details.turnId}:${details.itemId}`;
  if (!claimDedupeKey(notifiedUserInputs, dedupeKey)) return;

  const { cwd, sessionName, threadMeta } = await resolveThreadContext(details.threadId, options.lookupThread);
  if (isSubagentThread(threadMeta)) {
    console.log(
      `[feishu-notify] skip subagent Plan input ${details.threadId}` +
        (threadMeta?.agentNickname ? ` (${threadMeta.agentNickname})` : "") +
        `; parent=${threadMeta?.parentThreadId || threadMeta?.forkedFromId || "?"}`
    );
    return;
  }

  const chatName = buildChatName(sessionName, source.label);
  const markdownMessages = buildUserInputMarkdownMessages({
    sourceLabel: source.label,
    chatName,
    requestedAt: Math.floor(Date.now() / 1000),
    cwd,
    sessionName,
    questions: details.questions
  }, config.chunkMaxBytes);

  try {
    const chat = options.deliver ? null : await ensureChat(config, stateThreadId, chatName);
    for (let index = 0; index < markdownMessages.length; index += 1) {
      const markdown = markdownMessages[index];
      const idempotencyKey = userInputMessageIdempotencyKey(
        stateThreadId,
        details.turnId,
        details.itemId,
        index + 1
      );
      const delivery = {
        config,
        stateThreadId,
        chatName,
        markdown,
        idempotencyKey,
        part: index + 1,
        parts: markdownMessages.length
      };
      if (options.deliver) {
        await options.deliver(delivery);
      } else if (chat) {
        await sendMarkdown(config, chat.chatId, markdown, idempotencyKey);
      }
    }
    const destination = options.deliver ? "" : ` -> ${chat?.chatId}`;
    console.log(
      `[feishu-notify] sent Plan input for ${source.id}:${details.threadId}${destination}` +
        ` (${markdownMessages.length} message${markdownMessages.length === 1 ? "" : "s"})`
    );
  } catch (error) {
    notifiedUserInputs.delete(dedupeKey);
    console.warn(
      `[feishu-notify] Plan input failed (${source.id}):`,
      error instanceof Error ? error.message : error
    );
  }
}
