"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Copy, FileDiff, FileText, GitFork, ListTree, Terminal } from "lucide-react";
import dynamic from "next/dynamic";
import SafeMarkdown from "./SafeMarkdown";
import { getJson } from "./apiClient";
import { AGENT_PROVIDER_LABELS, type ProviderId } from "./sessionRuntime";
import { uploadedImagePreviewFromPath } from "./uploads";
import {
  assistantMessagePhase,
  formatTime,
  isAssistantMessageItem,
  isUserMessageItem,
  partitionTurnItems,
  statusLabel,
  type DisplayTurn,
  type ThreadItem
} from "./threadModel";

export const ProjectDiffPanel = dynamic(() => import("./CodeDiff").then(module => module.ProjectDiffPanel), { loading: () => <p className="muted">Loading changes…</p> });
const DiffViewer = dynamic(() => import("./CodeDiff").then(module => module.DiffViewer), { loading: () => <p className="muted">Loading diff…</p> });

export type GatewayDiagnostic = {
  code: string;
  title: string;
  detail: string;
  retrying: boolean;
  occurredAt: number;
};

export type ProjectDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  tooLarge?: boolean;
};

export type ProjectDiff = {
  root: string;
  branch: string | null;
  status: string;
  diff: string;
  files: ProjectDiffFile[];
  additions: number;
  deletions: number;
  hasChanges: boolean;
  baseTree?: string | null;
  currentTree?: string | null;
  truncated?: boolean;
};

export type FilePreview = {
  root: string;
  path: string;
  source: "workingTree" | "tree";
  tree: string | null;
  exists: boolean;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
};

function providerName(provider: ProviderId) {
  return AGENT_PROVIDER_LABELS[provider] || provider;
}

function compactText(text: string, limit = 120) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function itemText(item: ThreadItem) {
  if (isUserMessageItem(item)) {
    return userMessageParts(item).text;
  }

  if (isAssistantMessageItem(item) || item.type === "plan") return item.text || "";
  if (item.type === "reasoning") {
    const content = (item.content || []).filter((part): part is string => typeof part === "string");
    return [...(item.summary || []), ...content].join("\n");
  }
  if (item.type === "commandExecution") return outputText(item);
  if (item.type === "toolCall") return String(item.output || item.summary || "");
  if (item.type === "fileChange") return item.output || JSON.stringify(item.changes || [], null, 2);
  if (item.type === "diff") return item.text || "";
  return JSON.stringify(item, null, 2);
}

function itemVersion(item: ThreadItem) {
  if (isAssistantMessageItem(item) || item.type === "plan" || item.type === "diff") {
    return `${item.id}:${item.type}:${item.phase || ""}:${item.text?.length || 0}`;
  }
  if (item.type === "reasoning") {
    return `${item.id}:reasoning:${(item.summary || []).join("").length}:${(item.content || []).join("").length}`;
  }
  if (item.type === "commandExecution") {
    return `${item.id}:command:${item.aggregatedOutput?.length || 0}:${item.exitCode ?? ""}`;
  }
  if (item.type === "fileChange") {
    return `${item.id}:file:${item.output?.length || 0}:${item.changes?.length || 0}`;
  }
  return `${item.id}:${item.type}`;
}

export function userMessageParts(item: ThreadItem) {
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String(part.text || "")
        : part && typeof part === "object" && "path" in part
          ? "type" in part && part.type === "localImage" && uploadedImagePreviewFromPath(String(part.path || ""))
            ? ""
            : String(part.path || "")
          : ""
    )
    .filter(Boolean)
    .join("\n");
  return {
    text: text || String(item.text || "").trim(),
    images: content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if ("url" in part) return String(part.url || "");
        if ("type" in part && part.type === "localImage" && "path" in part) {
          return uploadedImagePreviewFromPath(String(part.path || "")) || "";
        }
        return "";
      })
      .filter(Boolean)
  };
}

function outputText(item: ThreadItem) {
  return item.aggregatedOutput || item.output || "";
}

function MarkdownBody({ text, expanded, streaming }: { text: string; expanded?: boolean; streaming?: boolean }) {
  return <SafeMarkdown expanded={expanded} streaming={streaming} text={text} />;
}

function changedFiles(item: ThreadItem) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes
    .map((change) => {
      if (!change || typeof change !== "object") return null;
      const record = change as Record<string, unknown>;
      const path = String(record.path || record.file || record.filename || record.absolutePath || "");
      if (!path) return null;
      return {
        path,
        kind: String(record.kind || record.type || record.status || "changed")
      };
    })
    .filter((change): change is { path: string; kind: string } => Boolean(change));
}

function diffFiles(diff: string) {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2] || match[1]);
}

function projectDiffFromItem(item: ThreadItem) {
  return item.projectDiff && typeof item.projectDiff === "object" ? (item.projectDiff as ProjectDiff) : null;
}

function diffStats(item: ThreadItem) {
  const projectDiff = projectDiffFromItem(item);
  if (projectDiff) {
    return {
      files: projectDiff.files.length,
      additions: projectDiff.additions,
      deletions: projectDiff.deletions,
      statuses: [...new Set(projectDiff.files.map((file) => file.status))]
    };
  }

  const text = itemText(item);
  return {
    files: diffFiles(text).length,
    additions: text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: text.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    statuses: []
  };
}

function compactTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toString();
}

function formatTokenUsage(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const params = value as Record<string, any>;
  const wrapper = params.tokenUsage ?? params.usage ?? params;
  const breakdown = wrapper?.total ?? wrapper?.last ?? wrapper;
  if (!breakdown || typeof breakdown !== "object") return "";
  const input = breakdown.inputTokens ?? breakdown.input_tokens ?? breakdown.promptTokens ?? breakdown.prompt_tokens;
  const output = breakdown.outputTokens ?? breakdown.output_tokens ?? breakdown.completionTokens ?? breakdown.completion_tokens;
  const total = breakdown.totalTokens ?? breakdown.total_tokens ?? breakdown.total;
  const cached = breakdown.cachedInputTokens ?? breakdown.cached_input_tokens;
  const reasoning = breakdown.reasoningOutputTokens ?? breakdown.reasoning_output_tokens;
  const window = wrapper?.modelContextWindow ?? params.modelContextWindow;
  const parts = [
    typeof input === "number" ? `in ${compactTokens(input)}${typeof cached === "number" && cached > 0 ? ` (${compactTokens(cached)} cached)` : ""}` : "",
    typeof output === "number" ? `out ${compactTokens(output)}${typeof reasoning === "number" && reasoning > 0 ? ` (${compactTokens(reasoning)} think)` : ""}` : "",
    typeof total === "number"
      ? `total ${compactTokens(total)}${typeof window === "number" && window > 0 ? ` / ${compactTokens(window)} (${Math.round((total / window) * 100)}%)` : ""}`
      : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function sameDisplayTurn(current: DisplayTurn, next: DisplayTurn) {
  return (
    current.id === next.id &&
    current.pending === next.pending &&
    current.startedAt === next.startedAt &&
    current.completedAt === next.completedAt &&
    current.updatedAt === next.updatedAt &&
    statusLabel(current.status) === statusLabel(next.status) &&
    current.items.length === next.items.length &&
    current.items.every((item, index) => item === next.items[index])
  );
}

export const TurnPanel = memo(function TurnPanel({
  active,
  defaultOpen,
  diagnostic,
  onOpenDiff, onForkTurn, forkDisabledReason,
  provider,
  turn
}: {
  active: boolean;
  defaultOpen: boolean;
  diagnostic: GatewayDiagnostic | null;
  onOpenDiff?: (diff: ProjectDiff) => void;
  onForkTurn?: (turnId: string) => void;
  forkDisabledReason?: string;
  provider: ProviderId;
  turn: DisplayTurn;
}) {
  const [open, setOpen] = useState(defaultOpen || active);
  const [waitedLong, setWaitedLong] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const turnStatus = statusLabel(turn.status);
  const normalizedTurnStatus = turnStatus.replace(/[^a-z]/gi, "").toLowerCase();
  const turnLive = active || Boolean(turn.pending);
  const turnCompleted = ["completed", "success", "succeeded"].includes(normalizedTurnStatus);
  const sections = partitionTurnItems(turn.items, turnLive, turnCompleted);
  const { userItem, workItems, finalItems, diffItems } = sections;
  const finalSectionLabel = finalItems.length > 0 && finalItems.every((item) => item.type === "plan")
    ? "Plan result"
    : "Final answer";
  const hasCodexOutput = open && (workItems.length > 0 || finalItems.length > 0);
  const pendingAccepted = Boolean(turn.pending) && ["inprogress", "running"].includes(normalizedTurnStatus);
  const streamedVersion = open && (active || turn.pending) ? turn.items.map(itemVersion).join("|") : "";
  const title = userItem
    ? compactText(itemText(userItem), 120) || "User message"
    : turn.pending
      ? "Sending to agent"
      : active
        ? "Running turn"
        : "Agent turn";
  const time = turn.completedAt || turn.updatedAt || turn.startedAt || 0;
  const status = diagnostic ? "connection error" : turn.pending ? pendingAccepted ? "initializing" : "sending" : active ? "streaming" : turnStatus;
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  useEffect(() => {
    if (!open || (!active && !turn.pending)) return;
    const el = bodyRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 96) el.scrollTop = el.scrollHeight;
  }, [active, open, streamedVersion, turn.pending]);

  useEffect(() => {
    if ((!active && !turn.pending) || hasCodexOutput || diagnostic) {
      setWaitedLong(false);
      return;
    }
    const timer = window.setTimeout(() => setWaitedLong(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [active, diagnostic, hasCodexOutput, turn.pending]);

  return (
    <details
      className={`turnPanel ${active || turn.pending ? "active" : ""} ${diagnostic ? "connectionError" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="turnSummaryMain">
          <strong>{title}</strong>
          {time ? <small>{formatTime(time)}</small> : null}
        </span>
        <span className="turnSummaryMeta">
          <span className={diagnostic ? "errorBadge" : active || turn.pending ? "liveBadge" : ""}>{status}</span>
          {diffItems.length ? <span>{diffItems.length} change{diffItems.length === 1 ? "" : "s"}</span> : null}
          {onForkTurn && turnCompleted && !turn.pending ? (
            <button
              aria-disabled={Boolean(forkDisabledReason)}
              aria-label="Fork from this turn"
              className="forkTurnButton"
              title={forkDisabledReason || "Start a new session from this turn"}
              type="button"
              // The header toggles the turn; forking must not collapse it. Blocked forks still explain why on tap.
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); onForkTurn(turn.id); }}
            >
              <GitFork aria-hidden="true" size={12} />
              Fork
            </button>
          ) : null}
        </span>
      </summary>
      {open ? (
        <div className="turnBody" ref={bodyRef}>
          {userItem ? <MessageItem item={userItem} key={userItem.id} provider={provider} /> : null}
          {workItems.length ? (
            <TurnWorkLog
              active={active || Boolean(turn.pending)}
              hasFinalAnswer={finalItems.length > 0}
              items={workItems}
              provider={provider}
            />
          ) : null}
          {diagnostic ? (
            <div className="turnDiagnostic" role="alert">
              <strong>{diagnostic.title}</strong>
              <span>{diagnostic.detail}</span>
            </div>
          ) : (active || turn.pending) && !hasCodexOutput ? (
            <div className="streamPlaceholder">
              <span className="pulseDot" />
              {turn.pending
                ? pendingAccepted
                  ? waitedLong
                    ? "The task is accepted. Waiting for the first agent output."
                    : "Agent accepted. Initializing…"
                  : waitedLong
                    ? "Waiting for task acceptance. Connection details are available in Runtime."
                    : "Sending to agent…"
                : waitedLong
                  ? "Waiting for the first agent output. You can keep browsing."
                  : "Waiting for first output…"}
            </div>
          ) : null}
          <TurnCodeChanges items={diffItems} />
          {finalItems.length ? (
            <section className="turnFinalAnswer" aria-label={finalSectionLabel}>
              {finalItems.map((item, index) => (
                <MessageItem
                  item={item}
                  key={item.id}
                  presentation="final"
                  provider={provider}
                  streaming={(active || Boolean(turn.pending)) && index === finalItems.length - 1}
                />
              ))}
            </section>
          ) : null}
        </div>
      ) : null}
    </details>
  );
},
(current, next) =>
  current.active === next.active &&
  current.forkDisabledReason === next.forkDisabledReason &&
  Boolean(current.onForkTurn) === Boolean(next.onForkTurn) &&
  current.defaultOpen === next.defaultOpen &&
  current.diagnostic === next.diagnostic &&
  current.onOpenDiff === next.onOpenDiff &&
  current.provider === next.provider &&
  sameDisplayTurn(current.turn, next.turn));

function workLogCounts(items: ThreadItem[]) {
  let updates = 0;
  let reasoning = 0;
  let actions = 0;
  for (const item of items) {
    if (isAssistantMessageItem(item) || item.type === "plan") updates += 1;
    else if (item.type === "reasoning") reasoning += 1;
    else actions += 1;
  }
  return [
    updates ? `${updates} update${updates === 1 ? "" : "s"}` : "",
    actions ? `${actions} action${actions === 1 ? "" : "s"}` : "",
    reasoning ? `${reasoning} reasoning` : ""
  ].filter(Boolean);
}

const workLogPageSize = 60;

function TurnWorkLog({
  active,
  hasFinalAnswer,
  items,
  provider
}: {
  active: boolean;
  hasFinalAnswer: boolean;
  items: ThreadItem[];
  provider: ProviderId;
}) {
  const [open, setOpen] = useState(active || !hasFinalAnswer);
  // Long agent turns have hundreds of steps; render the latest ones first.
  const [shown, setShown] = useState(workLogPageSize);
  const hidden = Math.max(0, items.length - shown);
  const wasActiveRef = useRef(active);
  const counts = workLogCounts(items);

  useEffect(() => {
    if (active) setOpen(true);
    else if (wasActiveRef.current && hasFinalAnswer) setOpen(false);
    wasActiveRef.current = active;
  }, [active, hasFinalAnswer]);

  return (
    <details
      className={`turnWorkLog ${active ? "active" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="turnWorkLogTitle">
          <ListTree aria-hidden="true" size={14} />
          <strong>Work log</strong>
        </span>
        <span className="turnWorkLogCounts">{counts.join(" · ")}</span>
        {active ? <span className="turnWorkLogLive"><span className="pulseDot" />Live</span> : null}
        <ChevronRight aria-hidden="true" className="turnWorkLogChevron" size={14} />
      </summary>
      {open ? (
        <div className="turnWorkLogBody">
          {hidden ? (
            <button className="historyMoreButton" type="button" onClick={() => setShown((count) => count + workLogPageSize)}>
              Show {Math.min(workLogPageSize, hidden)} earlier steps · {hidden} hidden
            </button>
          ) : null}
          {items.slice(hidden).map((item, index) => (
            <MessageItem
              item={item}
              key={item.id}
              presentation={isAssistantMessageItem(item) ? "progress" : "default"}
              provider={provider}
              streaming={active && !hasFinalAnswer && hidden + index === items.length - 1}
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function TurnCodeChanges({ items }: { items: ThreadItem[] }) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(items[0]?.id || "");
  const [loadedDiffs, setLoadedDiffs] = useState<Record<string, ProjectDiff>>({});
  const selected = items.find((item) => item.id === selectedId) || items[0];
  const selectedProjectDiff = selected ? loadedDiffs[selected.id] || projectDiffFromItem(selected) : null;
  const queueItemId = typeof selected?.queueItemId === "string" ? selected.queueItemId : "";
  const patchId = open && queueItemId && selectedProjectDiff?.hasChanges && !selectedProjectDiff.diff ? selected.id : "";

  useEffect(() => {
    if (!items.length) {
      setSelectedId("");
      return;
    }
    if (!items.some((item) => item.id === selectedId)) setSelectedId(items[0].id);
  }, [items, selectedId]);

  useEffect(() => {
    if (!patchId) return;
    // Queue snapshots omit patch text; fetch it only when this panel is opened.
    void getJson<ProjectDiff>(`/api/queue/diff?id=${encodeURIComponent(queueItemId)}`)
      .then((diff) => setLoadedDiffs((current) => ({ ...current, [patchId]: diff })));
  }, [patchId, queueItemId]);

  if (!items.length || !selected) return null;

  const totals = items.reduce(
    (sum, item) => {
      const stats = diffStats(item);
      for (const status of stats.statuses) sum.statuses.add(status);
      sum.files += stats.files;
      sum.additions += stats.additions;
      sum.deletions += stats.deletions;
      return sum;
    },
    { files: 0, additions: 0, deletions: 0, statuses: new Set<string>() }
  );
  return (
    <section className={`turnCodeChanges ${open ? "expanded" : ""}`}>
      <button
        aria-expanded={open}
        className="turnCodeChangesSummary"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <strong>Code changes</strong>
        <code>{totals.files} file{totals.files === 1 ? "" : "s"}</code>
        <code>+{totals.additions} -{totals.deletions}</code>
        {[...totals.statuses].slice(0, 3).map((status) => (
          <small key={status}>{status}</small>
        ))}
      </button>
      {open ? (
        <div className="turnCodeChangesBody">
          {items.length > 1 ? (
            <div className="segmentedMini">
              {items.map((item, index) => {
                const stats = diffStats(item);
                return (
                  <button className={item.id === selected.id ? "active" : ""} key={item.id} type="button" onClick={() => setSelectedId(item.id)}>
                    Diff {index + 1} · {stats.files}
                  </button>
                );
              })}
            </div>
          ) : null}
          {selectedProjectDiff ? <ProjectDiffPanel compact data={selectedProjectDiff} /> : <DiffViewer diff={itemText(selected)} />}
        </div>
      ) : null}
    </section>
  );
}

const MessageItem = memo(function MessageItem({
  item,
  presentation = "default",
  provider,
  streaming = false
}: {
  item: ThreadItem;
  presentation?: "default" | "progress" | "final";
  provider: ProviderId;
  streaming?: boolean;
}) {
  const text = itemText(item);
  const [expanded, setExpanded] = useState(false);
  const toolStatus = item.type === "toolCall" ? String(item.status || "") : "";
  const isReply = isAssistantMessageItem(item) || item.type === "plan";
  const messagePhase = presentation === "final"
    ? "final"
    : presentation === "progress" || assistantMessagePhase(item) === "commentary"
      ? "commentary"
      : "default";
  const showExpanded = expanded || isReply;
  const label =
    isUserMessageItem(item)
      ? "You"
      : presentation === "final"
        ? item.type === "plan" ? "Plan" : "Final answer"
        : presentation === "progress"
          ? "Progress update"
          : isAssistantMessageItem(item)
            ? providerName(provider)
            : item.type === "commandExecution"
              ? "Command"
              : item.type === "toolCall"
                ? String(item.tool || "Tool")
                : item.type === "fileChange"
                  ? "File change"
                  : item.type === "diff"
                    ? "Diff"
                    : item.type;
  const output = text || (streaming ? "" : "…");
  const isLong = !isReply && output.length > 800;
  const preClass = showExpanded ? "expandedPre" : "";

  async function copy(value: string) {
    await navigator.clipboard?.writeText(value).catch(() => undefined);
  }

  if (isUserMessageItem(item)) {
    const parts = userMessageParts(item);
    return (
      <article className="message userMessage">
        <header>
          <span>You</span>
          {parts.images.length ? <code>{parts.images.length} image{parts.images.length === 1 ? "" : "s"}</code> : null}
          {parts.text ? (
            <button className="inlineIconButton" type="button" onClick={() => copy(parts.text)}>
              <Copy size={14} />
              Copy
            </button>
          ) : null}
        </header>
        {parts.text ? <pre>{parts.text}</pre> : null}
        {parts.images.length ? (
          <div className="messageImages">
            {parts.images.map((url, index) => (
              <img
                alt={`Attachment ${index + 1}`}
                height={220}
                key={`${url}-${index}`}
                loading="lazy"
                src={url}
                width={260}
              />
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  if (item.type === "plan" && item.planEntries?.length) {
    return (
      <article className={`message plan ${streaming ? "streamingMessage" : ""}`}>
        <header>
          <span>Plan</span>
          {streaming ? (
            <span className="messageLive">
              <span className="pulseDot" />
              Streaming
            </span>
          ) : null}
        </header>
        {item.explanation ? <p className="planExplanation">{item.explanation}</p> : null}
        <ol className="planList">
          {item.planEntries.map((entry, index) => (
            <li className={`planStep ${entry.status}`} key={`${entry.step}-${index}`}>
              <span>{entry.status}</span>
              <p>{entry.step}</p>
            </li>
          ))}
        </ol>
      </article>
    );
  }

  if (item.type === "commandExecution") {
    return (
      <details className={`message activityCard commandExecution ${streaming ? "streamingMessage" : ""}`} open={streaming || (typeof item.exitCode === "number" && item.exitCode !== 0) || undefined}>
        <summary>
          <span>
            <Terminal aria-hidden="true" size={14} />
            Command
          </span>
          {typeof item.exitCode === "number" ? (
            <code className={item.exitCode === 0 ? "exitOk" : "exitError"}>exit {item.exitCode}</code>
          ) : null}
          {streaming ? (
            <span className="messageLive">
              <span className="pulseDot" />
              Streaming
            </span>
          ) : null}
          {item.command ? <code>{item.command}</code> : null}
        </summary>
        <div className="activityBody">
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy aria-hidden="true" size={14} />
            Copy output
          </button>
          <pre className={preClass}>
            {output}
            {streaming ? <span className="streamCursor" /> : null}
          </pre>
        </div>
      </details>
    );
  }

  if (item.type === "fileChange" || item.type === "diff") {
    const projectDiff = item.type === "diff" && item.projectDiff && typeof item.projectDiff === "object" ? (item.projectDiff as ProjectDiff) : null;
    const files = projectDiff?.files?.length
      ? projectDiff.files.map((file) => file.path)
      : item.type === "diff"
        ? diffFiles(output)
        : changedFiles(item).map((change) => change.path);
    return (
      <article className={`message ${item.type} ${streaming ? "streamingMessage" : ""}`}>
        <header>
          <span>
            <FileDiff size={14} />
            {item.type === "diff" ? String(item.title || "Code changes") : "File change"}
          </span>
          <code>{files.length} file{files.length === 1 ? "" : "s"}</code>
          {projectDiff ? <code>+{projectDiff.additions} -{projectDiff.deletions}</code> : null}
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy size={14} />
            Copy
          </button>
        </header>
        {files.length ? (
          <div className="fileList">
            {files.slice(0, 8).map((file) => (
              <span key={file}>
                <FileText size={13} />
                {file}
              </span>
            ))}
            {files.length > 8 ? <small>+{files.length - 8} more</small> : null}
          </div>
        ) : null}
        {projectDiff ? <ProjectDiffPanel data={projectDiff} /> : item.type === "diff" ? <DiffViewer diff={output} /> : <pre className={preClass}>{output}</pre>}
        {isLong && item.type !== "diff" ? (
          <button className="textButton" type="button" onClick={() => setExpanded((current) => !current)}>
            {showExpanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </article>
    );
  }

  const renderMarkdown = isAssistantMessageItem(item) || item.type === "plan";

  if (item.type === "toolCall") {
    const failed = toolStatus === "failed" || toolStatus === "error";
    return (
      <details className={`message activityCard toolCall ${streaming ? "streamingMessage" : ""}`} open={streaming || failed || undefined}>
        <summary>
          <span>{label}</span>
          {toolStatus ? <code className={toolStatus === "completed" ? "exitOk" : failed ? "exitError" : undefined}>{toolStatus}</code> : null}
          {streaming ? <span className="messageLive"><span className="pulseDot" />Streaming</span> : null}
          {item.command ? <code>{item.command}</code> : null}
        </summary>
        <div className="activityBody">
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy aria-hidden="true" size={14} />
            Copy output
          </button>
          <pre className={`agentPre ${preClass}`}>
            {output}
            {streaming ? <span className="streamCursor" /> : null}
          </pre>
        </div>
      </details>
    );
  }

  return (
    <article
      className={`message ${item.type} ${messagePhase === "final" ? "finalAnswerMessage" : ""} ${messagePhase === "commentary" ? "commentaryMessage" : ""} ${streaming ? "streamingMessage" : ""}`}
      data-message-phase={messagePhase}
    >
      <header>
        <span>
          {messagePhase === "final" ? <CheckCircle2 aria-hidden="true" size={15} /> : null}
          {label}
        </span>
        {messagePhase === "final" || messagePhase === "commentary" ? <small>{providerName(provider)}</small> : null}
        {toolStatus ? (
          <code className={toolStatus === "completed" ? "exitOk" : toolStatus === "failed" ? "exitError" : undefined}>
            {toolStatus}
          </code>
        ) : null}
        {streaming ? (
          <span className="messageLive">
            <span className="pulseDot" />
            Streaming
          </span>
        ) : null}
        {item.command ? <code>{item.command}</code> : null}
        {renderMarkdown ? (
          <button className="inlineIconButton" type="button" onClick={() => copy(output)}>
            <Copy size={14} />
            Copy
          </button>
        ) : null}
      </header>
      {renderMarkdown ? (
        <MarkdownBody expanded={showExpanded} streaming={streaming} text={output} />
      ) : (
        <pre className={`agentPre ${preClass}`}>
          {output}
          {streaming ? <span className="streamCursor" /> : null}
        </pre>
      )}
      {isLong ? (
        <button className="textButton" type="button" onClick={() => setExpanded((current) => !current)}>
          {showExpanded ? "Collapse" : "Expand"}
        </button>
      ) : null}
    </article>
  );
});
