"use client";

import { useEffect, useState } from "react";
import type { QueuedPrompt } from "./queueModel";

export function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function RunProgress({ item, active }: { item: QueuedPrompt | undefined; active: boolean }) {
  const [now, setNow] = useState(Date.now);
  const busy = Boolean(item && ["queued", "dispatching", "running", "waiting_for_input"].includes(item.status));
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy, item?.id]);
  if (!item) return active ? <div className="runProgress isRunning" role="status">Agent is running · Timing unavailable for this run</div> : null;
  const t = item.timings || {};
  if (!t.acceptedAt) return busy ? <div className="runProgress isRunning" role="status">{item.status === "waiting_for_input" ? "Waiting for your input" : item.status === "queued" ? "Saved in queue" : "Agent is running"} · Detailed timing unavailable for this run</div> : null;
  if (!busy && !t.completedAt) return null;
  const phase = item.status === "waiting_for_input" ? "Waiting for your input"
    : item.status === "queued" ? "Saved in queue"
    : t.firstOutputAt || t.firstToolAt ? "Agent is working"
    : t.startedAt ? "Waiting for first output"
    : t.startRequestedAt ? "Starting agent"
    : t.resumeAt ? "Restoring session" : "Preparing task";
  const phaseStart = item.status === "waiting_for_input" ? item.updatedAt * 1000 : Math.max(t.firstToolAt || 0, t.firstOutputAt || 0, t.startedAt || 0, t.startRequestedAt || 0, t.resumeAt || 0, t.dispatchAt || 0, t.acceptedAt);
  const stages = [
    ["Queued", t.acceptedAt, t.dispatchAt],
    ["Restore session", t.resumeAt, t.resumedAt],
    ["Start agent", t.startRequestedAt, t.startedAt],
    ["First output after start", t.startedAt, t.firstOutputAt],
    ["First tool after start", t.startedAt, t.firstToolAt],
    ["Total", t.acceptedAt, t.completedAt]
  ] as const;
  return (
    <details className={`runProgress ${busy ? "isRunning" : ""} ${item.status === "failed" ? "isProblem" : ""}`}>
      <summary>
        <span role="status">{busy ? phase : `Last task ${item.status}`}</span>
        {phaseStart && busy ? <time aria-live="off">{elapsedLabel(now - phaseStart)}</time> : t.acceptedAt && t.completedAt ? <time>{elapsedLabel(t.completedAt - t.acceptedAt)}</time> : null}
        <small>Timing</small>
      </summary>
      <dl>{stages.map(([label, start, end]) => start !== undefined && end !== undefined ? (
        <div key={label}><dt>{label}</dt><dd>{Math.max(0, (end - start) / 1000).toFixed(2)}s</dd></div>
      ) : null)}</dl>
      {busy && !t.firstOutputAt && !t.firstToolAt ? <p>The task is saved. You can leave this page and return later.</p> : null}
    </details>
  );
}
