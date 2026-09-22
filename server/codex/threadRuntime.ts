import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isInsideRoot } from "../pathGuard";

export type CodexThreadRuntime = {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  mode: string | null;
};

type CacheEntry = {
  size: number;
  mtimeMs: number;
  runtime: CodexThreadRuntime | null;
};

type RuntimeReadOptions = {
  allowedRoot?: string;
};

const DEFAULT_CODEX_SESSIONS_ROOT = resolve(
  process.env.CODEX_HOME || resolve(homedir(), ".codex"),
  "sessions"
);
const READ_CHUNK_BYTES = 128 * 1024;
const runtimeCache = new Map<string, CacheEntry>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtimeFromSettings(value: unknown): CodexThreadRuntime | null {
  const settings = record(value);
  if (!settings) return null;
  const collaborationMode = record(settings.collaboration_mode);
  const collaborationSettings = record(collaborationMode?.settings);
  const runtime = {
    model: optionalString(settings.model) || optionalString(collaborationSettings?.model),
    reasoningEffort:
      optionalString(settings.reasoning_effort)
      || optionalString(settings.effort)
      || optionalString(collaborationSettings?.reasoning_effort),
    serviceTier: optionalString(settings.service_tier),
    mode: optionalString(collaborationMode?.mode)
  } satisfies CodexThreadRuntime;

  return runtime.model || runtime.reasoningEffort || runtime.serviceTier || runtime.mode ? runtime : null;
}

/** Parse one rollout JSONL line when it carries per-turn runtime settings. */
export function codexThreadRuntimeFromLine(line: string): CodexThreadRuntime | null {
  if (!line.includes("thread_settings_applied") && !line.includes('"type":"turn_context"')) return null;
  try {
    const entry = record(JSON.parse(line));
    const payload = record(entry?.payload);
    if (!payload) return null;
    if (entry?.type === "event_msg" && payload.type === "thread_settings_applied") {
      return runtimeFromSettings(payload.thread_settings);
    }
    if (entry?.type === "turn_context") return runtimeFromSettings(payload);
  } catch {
    // A partial or malformed JSONL record is ignored; older records remain usable.
  }
  return null;
}

function pathAllowed(filePath: string, allowedRoot: string) {
  return isInsideRoot(allowedRoot, filePath);
}

/**
 * Read backwards until the most recent runtime record is found. This avoids
 * loading large rollout histories or tool outputs merely to render the sidebar.
 */
export async function readCodexThreadRuntime(
  rolloutPath: string,
  options: RuntimeReadOptions = {}
): Promise<CodexThreadRuntime | null> {
  const filePath = resolve(rolloutPath);
  const allowedRoot = options.allowedRoot || DEFAULT_CODEX_SESSIONS_ROOT;
  if (!pathAllowed(filePath, allowedRoot) || !filePath.endsWith(".jsonl")) return null;

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }
  if (!fileStat.isFile()) return null;

  const cached = runtimeCache.get(filePath);
  if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.runtime;
  }

  const handle = await open(filePath, "r");
  let end = fileStat.size;
  let leadingPartial = "";
  let runtime: CodexThreadRuntime | null = null;
  let turnContextFallback: CodexThreadRuntime | null = null;
  try {
    while (end > 0 && !runtime) {
      const start = Math.max(0, end - READ_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const segments = `${buffer.toString("utf8")}${leadingPartial}`.split("\n");
      leadingPartial = segments.shift() || "";
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const line = segments[index];
        const candidate = codexThreadRuntimeFromLine(line);
        if (!candidate) continue;
        if (line.includes("thread_settings_applied")) {
          runtime = candidate;
          break;
        }
        turnContextFallback ||= candidate;
      }
      end = start;
    }
    if (!runtime && leadingPartial) {
      const candidate = codexThreadRuntimeFromLine(leadingPartial);
      if (leadingPartial.includes("thread_settings_applied")) runtime = candidate;
      else turnContextFallback ||= candidate;
    }
    runtime ||= turnContextFallback;
  } finally {
    await handle.close();
  }

  runtimeCache.set(filePath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, runtime });
  return runtime;
}

async function enrichThread(thread: unknown) {
  const source = record(thread);
  if (!source) return thread;
  const rolloutPath = optionalString(source.path);
  if (!rolloutPath) return thread;
  const runtime = await readCodexThreadRuntime(rolloutPath);
  return runtime ? { ...source, runtime } : thread;
}

/** Add historical runtime truth to Codex thread/list and thread/read responses. */
export async function enrichCodexThreadRuntime(method: string, result: unknown): Promise<unknown> {
  const response = record(result);
  if (!response) return result;

  if (method === "thread/list" && Array.isArray(response.data)) {
    return { ...response, data: await Promise.all(response.data.map(enrichThread)) };
  }

  if (["thread/read", "thread/resume", "thread/start", "thread/fork"].includes(method) && response.thread) {
    return { ...response, thread: await enrichThread(response.thread) };
  }

  return result;
}
