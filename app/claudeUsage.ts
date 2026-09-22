function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ClaudeUsageWindow = {
  usedPercent: number;
  resetsAt: number;
};

export type StandardClaudeRateLimit = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  session: ClaudeUsageWindow;
  weekly: ClaudeUsageWindow | null;
};

function windowFrom(raw: unknown, fallbackResetsAt?: number | null): ClaudeUsageWindow | null {
  const row = asRecord(raw);
  const utilization = finiteNumber(row?.utilization);
  const resetsAt = finiteNumber(row?.resetsAt) ?? fallbackResetsAt ?? null;
  if (utilization === null || resetsAt === null) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, utilization * 100)),
    resetsAt
  };
}

/** Read Claude Code session (5h) and weekly windows from a stream or snapshot payload. */
export function standardClaudeRateLimit(value: unknown): StandardClaudeRateLimit | null {
  const payload = asRecord(value);
  if (!payload) return null;
  const info = asRecord(payload.rate_limit_info) || payload;
  const windows = asRecord(info.unifiedWindows);
  const session = windowFrom(windows?.five_hour, finiteNumber(info.resetsAt));
  if (!session) return null;
  return {
    usedPercent: session.usedPercent,
    windowDurationMins: 300,
    resetsAt: session.resetsAt,
    session,
    weekly: windowFrom(windows?.seven_day)
  };
}

export function formatClaudeResetRelative(resetsAt: number, nowMs = Date.now()) {
  const mins = Math.max(0, Math.round((resetsAt * 1_000 - nowMs) / 60_000));
  if (mins <= 0) return "now";
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours >= 48) return formatClaudeWeekReset(resetsAt);
  if (hours <= 0) return `in ${rest} min`;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

export function formatClaudeWeekReset(resetsAt: number) {
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return "unknown";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const minutes = date.getMinutes();
  const hour24 = date.getHours();
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${weekday} ${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function formatClaudeUsageLabel(rateLimit: StandardClaudeRateLimit) {
  const session = `${trimPercent(rateLimit.session.usedPercent)}% used`;
  const weekly = rateLimit.weekly ? `${trimPercent(rateLimit.weekly.usedPercent)}% used` : "n/a";
  return `5h ${session} · Week ${weekly}`;
}

function trimPercent(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
