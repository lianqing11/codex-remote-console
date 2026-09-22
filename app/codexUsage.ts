export type StandardCodexRateLimit = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Select only the standard Codex quota bucket from a read response or update notification. */
export function standardCodexRateLimit(value: unknown): StandardCodexRateLimit | null {
  const payload = asRecord(value);
  if (!payload) return null;

  const buckets = asRecord(payload.rateLimitsByLimitId);
  const mappedCodex = asRecord(buckets?.codex);
  const legacy = asRecord(payload.rateLimits);
  const bucket = mappedCodex || (legacy?.limitId === "codex" ? legacy : null);
  if (!bucket) return null;

  const primary = asRecord(bucket.primary);
  const usedPercent = finiteNumber(primary?.usedPercent);
  const windowDurationMins = finiteNumber(primary?.windowDurationMins);
  const resetsAt = finiteNumber(primary?.resetsAt);
  if (usedPercent === null || windowDurationMins === null || resetsAt === null) return null;

  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowDurationMins,
    resetsAt
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCodexResetShort(resetsAt: number) {
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${monthNames[date.getUTCMonth()]} ${date.getUTCDate()}, ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())} UTC`;
}

export function formatCodexResetFull(resetsAt: number) {
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())} ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())} UTC`;
}

export function remainingCodexPercent(usedPercent: number) {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

export function formatCodexPercent(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
