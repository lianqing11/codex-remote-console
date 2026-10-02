import { BarChart3 } from "lucide-react";
import { formatClaudeResetRelative, formatClaudeUsageLabel, formatClaudeWeekReset, type StandardClaudeRateLimit } from "./claudeUsage";
import { formatCodexPercent, formatCodexResetFull, formatCodexResetShort, remainingCodexPercent } from "./codexUsage";
import { formatCursorUsageTitle, formatCursorUsedPercent, type CursorUsageSnapshot } from "./cursorUsage";

export function UsagePill({
  label,
  rateLimit,
  windowTitle
}: {
  label: string;
  rateLimit: { usedPercent: number; resetsAt: number } | null;
  windowTitle: string;
}) {
  if (!rateLimit) return null;
  const remainingPercent = remainingCodexPercent(rateLimit.usedPercent);
  const percent = formatCodexPercent(remainingPercent);
  const resetShort = formatCodexResetShort(rateLimit.resetsAt);
  const resetFull = formatCodexResetFull(rateLimit.resetsAt);

  return (
    <div
      className="codexUsagePill"
      role="status"
      aria-live="polite"
      title={`${windowTitle} · ${percent}% remaining · resets ${resetFull}`}
    >
      <BarChart3 aria-hidden="true" size={15} />
      <span className="codexUsageCopy">
        <strong><span className="codexUsageProvider">{label}</span> {percent}%</strong>
        <small className="codexUsageRemaining">remaining</small>
        <small className="codexUsageReset">Reset {resetShort}</small>
      </span>
      <span className="codexUsageMeter" aria-hidden="true">
        <span style={{ width: `${remainingPercent}%` }} />
      </span>
    </div>
  );
}

export function ClaudeUsagePill({ rateLimit }: { rateLimit: StandardClaudeRateLimit | null }) {
  if (!rateLimit) return null;
  const weekly = rateLimit.weekly;
  const title = [
    formatClaudeUsageLabel(rateLimit),
    `5h ${formatClaudeResetRelative(rateLimit.session.resetsAt)}`,
    weekly ? `Week ${formatClaudeWeekReset(weekly.resetsAt)}` : ""
  ].filter(Boolean).join(" · ");

  return (
    <div className="claudeUsagePill" role="status" aria-live="polite" title={title}>
      <span className="splitUsageCopy">
        <strong>5h {formatCodexPercent(rateLimit.session.usedPercent)}%</strong>
        <small className="codexUsageReset">{formatClaudeResetRelative(rateLimit.session.resetsAt)}</small>
        <strong>Week {formatCodexPercent(weekly?.usedPercent ?? 0)}%</strong>
        {weekly ? <small className="codexUsageReset">{formatClaudeWeekReset(weekly.resetsAt)}</small> : null}
      </span>
    </div>
  );
}

export function CursorUsagePill({ usage }: { usage: CursorUsageSnapshot | null }) {
  if (!usage) return null;
  return (
    <div className="cursorUsagePill" role="status" aria-live="polite" title={formatCursorUsageTitle(usage)}>
      <span className="splitUsageCopy">
        <strong>Models {formatCursorUsedPercent(usage.cursorModels.usedPercent)}%</strong>
        <strong>API {formatCursorUsedPercent(usage.otherModels.usedPercent)}%</strong>
        <small className="codexUsageReset">Reset {formatCodexResetShort(usage.resetsAt)}</small>
      </span>
    </div>
  );
}
