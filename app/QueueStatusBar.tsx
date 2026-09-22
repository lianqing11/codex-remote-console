"use client";

import { memo, useState } from "react";
import { ChevronDown, CircleAlert, ListTree, LoaderCircle, RotateCcw, X } from "lucide-react";
import { queueBarHasActions, queueStatusLabel, type QueueThreadSummary, type QueuedPrompt } from "./queueModel";

type QueueStatusBarProps = {
  summary: QueueThreadSummary;
  busyAction: string | null;
  onRetry: (item: QueuedPrompt) => Promise<void>;
  onRemove: (item: QueuedPrompt) => Promise<void>;
};

function compactPrompt(text: string, limit = 120) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function railCopy(summary: QueueThreadSummary) {
  const { attentionCount, queuedCount, waitingForInput } = summary;
  const paused = Boolean(summary.threadState?.paused);
  if (waitingForInput) {
    return {
      title: "Waiting for your input",
      detail: queuedCount ? `${queuedCount} task${queuedCount === 1 ? "" : "s"} behind it` : "Confirmation required to continue",
      tone: "attention"
    };
  }
  if (paused) {
    const parts = [
      attentionCount ? `${attentionCount} need review` : "",
      queuedCount ? `${queuedCount} saved` : ""
    ].filter(Boolean);
    return { title: "Queue needs review", detail: parts.join(" · ") || summary.threadState?.reason || "Retry a saved task to continue", tone: "attention" };
  }
  if (attentionCount) {
    return { title: "Queue needs review", detail: `${attentionCount} task${attentionCount === 1 ? "" : "s"} need a decision`, tone: "attention" };
  }
  return { title: `${queuedCount} queued`, detail: "Will start on the next send", tone: "queued" };
}

function QueueIcon({ tone }: { tone: string }) {
  if (tone === "attention") return <CircleAlert aria-hidden="true" size={17} />;
  return <ListTree aria-hidden="true" size={17} />;
}

export const QueueStatusBar = memo(function QueueStatusBar({
  summary,
  busyAction,
  onRetry,
  onRemove
}: QueueStatusBarProps) {
  const [expanded, setExpanded] = useState(false);
  if (!queueBarHasActions(summary)) return null;

  const copy = railCopy(summary);

  return (
    <section className={`queueStatusBar tone-${copy.tone}`} aria-label="Server queue" aria-live="polite">
      <div className="queueStatusSummary">
        <button
          aria-expanded={expanded}
          aria-label="Server queue details"
          className="queueStatusToggle"
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >
          <QueueIcon tone={copy.tone} />
          <span>
            <strong>{copy.title}</strong>
            <small>{copy.detail}</small>
          </span>
          <span className="queueCount">{summary.items.length}</span>
          <ChevronDown aria-hidden="true" className={expanded ? "expanded" : ""} size={16} />
        </button>
      </div>

      {expanded ? (
        <div className="queueStatusItems">
          {summary.threadState?.reason ? <p className="queuePauseReason">{summary.threadState.reason}</p> : null}
          {summary.items.map((item, index) => {
            const retryable = item.status === "failed" || item.status === "needs_review";
            const removable = retryable || item.status === "queued";
            return (
              <article className={`queueStatusItem status-${item.status}`} key={item.id}>
                <span className="queuePosition">{index + 1}</span>
                <span className="queueItemCopy">
                  <strong title={item.text}>{compactPrompt(item.text)}</strong>
                  <small>
                    <span className="queueItemState">{queueStatusLabel(item.status)}</span>
                    {item.lastError ? <span title={item.lastError}>{compactPrompt(item.lastError, 150)}</span> : null}
                  </small>
                </span>
                {retryable || removable ? (
                  <span className="queueItemActions">
                    {retryable ? (
                      <button
                        aria-label={`Retry queued task ${index + 1}`}
                        disabled={Boolean(busyAction)}
                        type="button"
                        onClick={() => void onRetry(item)}
                      >
                        {busyAction === `retry:${item.id}` ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={14} /> : <RotateCcw aria-hidden="true" size={14} />}
                        Retry
                      </button>
                    ) : null}
                    {removable ? (
                      <button
                        aria-label={`Remove queued task ${index + 1}`}
                        disabled={Boolean(busyAction)}
                        type="button"
                        onClick={() => void onRemove(item)}
                      >
                        {busyAction === `remove:${item.id}` ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={14} /> : <X aria-hidden="true" size={14} />}
                        Remove
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
});
