import path from "node:path";

export const SESSION_TITLE_MAX_CHARS = 40;
export const SESSION_TITLE_FALLBACK_CHARS = 28;
export const SESSION_TITLE_SUGGEST_TIMEOUT_MS = 45_000;
export const SESSION_TITLE_INPUT_MAX_CHARS = 1_200;

type TitleSourceItem = {
  event?: string;
  text?: string;
};

function truncateInput(value: string, limit = SESSION_TITLE_INPUT_MAX_CHARS) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function sessionTitleTimeoutMs() {
  const configured = Number(process.env.CODEX_WEB_SESSION_TITLE_TIMEOUT_MS || SESSION_TITLE_SUGGEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : SESSION_TITLE_SUGGEST_TIMEOUT_MS;
}

export function directoryBasename(cwd: string) {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

export function isUntitledSessionTitle(title: string | null | undefined, cwd = "") {
  const name = (title || "").trim();
  if (!name) return true;
  if (!cwd) return false;
  return name === directoryBasename(cwd);
}

export function fallbackSessionTitle(userText: string, maxChars = SESSION_TITLE_FALLBACK_CHARS) {
  const text = userText.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const segment = text.split(/[.?!\n。？！]/)[0] || text;
  const title = segment.slice(0, maxChars).trim();
  return title || null;
}

export function sanitizeSessionTitle(raw: string, maxChars = SESSION_TITLE_MAX_CHARS) {
  let text = String(raw || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
  text = text.replace(/^(title|标题|会话名|session\s*title)\s*[:：\-–—]\s*/i, "").trim();
  text = text.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > maxChars) text = text.slice(0, maxChars).trim();
  return text || null;
}

export function extractTitleSource(transcript: TitleSourceItem[]) {
  const userText =
    transcript.find((item) => item.event === "user_text" && String(item.text || "").trim())?.text?.trim() || "";
  const assistantText =
    transcript.find(
      (item) =>
        (item.event === "assistant_text" || item.event === "result") && String(item.text || "").trim()
    )?.text?.trim() || "";
  return { userText, assistantText };
}

export function buildSessionTitlePrompt(userText: string, assistantText = "") {
  const user = truncateInput(userText);
  const assistant = truncateInput(assistantText);
  const lines = [
    "Write a short chat session title for the conversation below.",
    "Rules: reply with the title only; no quotes; no explanation; no markdown; one line;",
    "prefer about 8-16 Chinese characters or 3-8 English words.",
    "",
    "User:",
    user
  ];
  if (assistant) {
    lines.push("", "Assistant:", assistant);
  }
  return lines.join("\n");
}
