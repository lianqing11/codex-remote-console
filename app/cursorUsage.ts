import { formatCodexResetFull } from "./codexUsage";

export type CursorUsageBucket = {
  usedPercent: number;
  message: string | null;
};

export type CursorUsageSnapshot = {
  planName: string | null;
  remainingCents: number;
  includedSpendCents: number;
  limitCents: number;
  bonusSpendCents: number;
  usedPercent: number;
  resetsAt: number;
  displayMessage: string | null;
  cursorModels: CursorUsageBucket;
  otherModels: CursorUsageBucket;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function epochSeconds(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value / 1_000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+$/.test(value.trim())) return epochSeconds(Number(value));
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.round(parsed / 1_000);
  }
  return null;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

export function formatCursorUsd(cents: number) {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function formatCursorUsedPercent(value: number) {
  return String(Math.round(clampPercent(value)));
}

export function formatCursorUsageLabel(usage: CursorUsageSnapshot) {
  return `Models ${formatCursorUsedPercent(usage.cursorModels.usedPercent)}% used · API ${formatCursorUsedPercent(usage.otherModels.usedPercent)}% used`;
}

export function formatCursorUsageTitle(usage: CursorUsageSnapshot) {
  return [
    usage.planName,
    formatCursorUsageLabel(usage),
    usage.cursorModels.message,
    usage.otherModels.message,
    `resets ${formatCodexResetFull(usage.resetsAt)}`
  ].filter(Boolean).join(" · ");
}

export function parseCursorUsage(value: unknown, plan?: unknown): CursorUsageSnapshot | null {
  const payload = asRecord(value);
  if (!payload) return null;

  const planInfo = asRecord(asRecord(plan)?.planInfo) || asRecord(payload.planInfo);
  const planName = typeof (planInfo?.planName ?? payload.planName) === "string"
    ? String(planInfo?.planName ?? payload.planName)
    : null;
  const displayMessage = typeof payload.displayMessage === "string" ? payload.displayMessage : null;

  const remainingCents = finiteNumber(payload.remainingCents);
  const limitCents = finiteNumber(payload.limitCents);
  const snapshotResetsAt = epochSeconds(payload.resetsAt);
  if (remainingCents !== null && limitCents !== null && snapshotResetsAt !== null) {
    const includedSpendCents = finiteNumber(payload.includedSpendCents) ?? Math.max(0, limitCents - remainingCents);
    const bonusSpendCents = finiteNumber(payload.bonusSpendCents) ?? 0;
    const usedPercent = finiteNumber(payload.usedPercent)
      ?? (limitCents > 0 ? (includedSpendCents / limitCents) * 100 : 0);
    return {
      planName,
      remainingCents: Math.max(0, remainingCents),
      includedSpendCents,
      limitCents,
      bonusSpendCents,
      usedPercent: clampPercent(usedPercent),
      resetsAt: snapshotResetsAt,
      displayMessage,
      ...usageBuckets(payload, usedPercent)
    };
  }

  const planUsage = asRecord(payload.planUsage);
  if (!planUsage) return null;
  const limit = finiteNumber(planUsage.limit);
  const includedSpend = finiteNumber(planUsage.includedSpend) ?? 0;
  if (limit === null) return null;
  const remaining = finiteNumber(planUsage.remaining) ?? Math.max(0, limit - includedSpend);
  const bonusSpend = finiteNumber(planUsage.bonusSpend) ?? 0;
  const resetsAt = epochSeconds(payload.billingCycleEnd) ?? epochSeconds(planInfo?.billingCycleEnd);
  if (resetsAt === null) return null;
  const usedPercent = clampPercent(limit > 0 ? (includedSpend / limit) * 100 : 0);

  return {
    planName,
    remainingCents: Math.max(0, remaining),
    includedSpendCents: includedSpend,
    limitCents: limit,
    bonusSpendCents: bonusSpend,
    usedPercent,
    resetsAt,
    displayMessage,
    ...usageBuckets(payload, usedPercent)
  };
}

function usageBuckets(payload: Record<string, unknown>, fallbackUsedPercent: number) {
  const planUsage = asRecord(payload.planUsage);
  const cursorModels = bucketFrom(payload.cursorModels, finiteNumber(planUsage?.autoPercentUsed) ?? fallbackUsedPercent, payload.autoModelSelectedDisplayMessage);
  const otherModels = bucketFrom(payload.otherModels, finiteNumber(planUsage?.apiPercentUsed) ?? 0, payload.namedModelSelectedDisplayMessage);
  return { cursorModels, otherModels };
}

function bucketFrom(raw: unknown, fallbackPercent: number, fallbackMessage: unknown): CursorUsageBucket {
  const row = asRecord(raw);
  return {
    usedPercent: clampPercent(finiteNumber(row?.usedPercent) ?? fallbackPercent),
    message: typeof row?.message === "string"
      ? row.message
      : typeof fallbackMessage === "string" ? fallbackMessage : null
  };
}
