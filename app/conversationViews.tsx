"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Code2, Copy, FileDiff, FileText, ListTree, Terminal, X } from "lucide-react";
import { getJson } from "./apiClient";
import { formatBytes } from "./formatUtils";
import SafeMarkdown from "./SafeMarkdown";
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

type DiffLine = {
  kind: "add" | "delete" | "hunk" | "meta" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

type DiffSection = {
  file: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
};

function parseUnifiedDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = {
        file: fileMatch[2] || fileMatch[1],
        lines: [{ kind: "meta", text: line, oldLine: null, newLine: null }],
        additions: 0,
        deletions: 0
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = { file: "Diff", lines: [], additions: 0, deletions: 0 };
      sections.push(current);
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      current.lines.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }

    const kind: DiffLine["kind"] =
      line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "delete"
            : line.startsWith("index ") ||
                line.startsWith("new file") ||
                line.startsWith("deleted file") ||
                line.startsWith("rename ") ||
                line.startsWith("similarity ") ||
                line.startsWith("---") ||
                line.startsWith("+++")
              ? "meta"
              : "context";

    if (kind === "add") {
      current.additions += 1;
      current.lines.push({ kind, text: line, oldLine: null, newLine });
      newLine += 1;
    } else if (kind === "delete") {
      current.deletions += 1;
      current.lines.push({ kind, text: line, oldLine, newLine: null });
      oldLine += 1;
    } else if (kind === "context" && (line.startsWith(" ") || line === "")) {
      current.lines.push({ kind, text: line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      current.lines.push({ kind, text: line, oldLine: null, newLine: null });
    }
  }

  return sections;
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

function languageForPath(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "typescript";
  if (["py"].includes(ext)) return "python";
  if (["json", "jsonl"].includes(ext)) return "json";
  if (["md", "mdx"].includes(ext)) return "markdown";
  if (["sh", "bash", "zsh"].includes(ext)) return "shell";
  if (["css", "scss"].includes(ext)) return "css";
  return "text";
}

function codeTokens(line: string, language: string) {
  const patterns =
    language === "json"
      ? /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g
      : language === "markdown"
        ? /(`[^`]+`|^#{1,6}\s.*|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
        : /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|def|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|null|return|true|try|type|while|yield)\b|-?\b\d+(?:\.\d+)?\b)/g;
  const tokens: Array<{ text: string; kind: string }> = [];
  let lastIndex = 0;

  for (const match of line.matchAll(patterns)) {
    const text = match[0];
    const index = match.index || 0;
    if (index > lastIndex) tokens.push({ text: line.slice(lastIndex, index), kind: "plain" });
    const kind = /^["'`]/.test(text)
      ? language === "json" && /"\s*$/.test(text)
        ? "key"
        : "string"
      : /^(\/\/|#|\/\*)/.test(text)
        ? "comment"
        : /^-?\d/.test(text) || ["true", "false", "null"].includes(text)
          ? "number"
          : language === "markdown"
            ? "markup"
            : "keyword";
    tokens.push({ text, kind });
    lastIndex = index + text.length;
  }

  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), kind: "plain" });
  return tokens.length ? tokens : [{ text: line || " ", kind: "plain" }];
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
  onOpenDiff,
  provider,
  turn
}: {
  active: boolean;
  defaultOpen: boolean;
  diagnostic: GatewayDiagnostic | null;
  onOpenDiff?: (diff: ProjectDiff) => void;
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
                    ? "Cursor is still initializing… The task has already been accepted."
                    : "Agent accepted. Initializing…"
                  : waitedLong
                    ? "Still connecting… If this persists, check the proxy node and retry."
                    : "Sending to agent…"
                : waitedLong
                  ? "Still working… large sessions or slow upstream can take a while."
                  : "Agent is working…"}
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
          {items.map((item, index) => (
            <MessageItem
              item={item}
              key={item.id}
              presentation={isAssistantMessageItem(item) ? "progress" : "default"}
              provider={provider}
              streaming={active && !hasFinalAnswer && index === items.length - 1}
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
  const selected = items.find((item) => item.id === selectedId) || items[0];

  useEffect(() => {
    if (!items.length) {
      setSelectedId("");
      return;
    }
    if (!items.some((item) => item.id === selectedId)) setSelectedId(items[0].id);
  }, [items, selectedId]);

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
  const selectedProjectDiff = projectDiffFromItem(selected);

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

function HighlightedCode({ text, filePath, startLine = 1 }: { text: string; filePath: string; startLine?: number }) {
  const language = languageForPath(filePath);
  const lines = text.split("\n");
  return (
    <pre className="codePreviewBlock">
      {lines.map((line, index) => (
        <span className="codePreviewLine" key={`${index}-${line}`}>
          <span className="codeLineNo">{startLine + index}</span>
          <code>
            {codeTokens(line, language).map((token, tokenIndex) => (
              <span className={`tok tok-${token.kind}`} key={`${tokenIndex}-${token.text}`}>
                {token.text}
              </span>
            ))}
          </code>
        </span>
      ))}
    </pre>
  );
}

function DiffLineRow({ line, filePath }: { line: DiffLine; filePath: string }) {
  const code = line.kind === "add" || line.kind === "delete" || line.kind === "context" ? line.text.slice(1) : line.text;
  const prefix = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : line.kind === "context" ? " " : "";
  return (
    <span className={`diffLine diffLine-${line.kind}`}>
      <span className="diffOldNo">{line.oldLine ?? ""}</span>
      <span className="diffNewNo">{line.newLine ?? ""}</span>
      <span className="diffPrefix">{prefix}</span>
      <span className="diffCode">
        {line.kind === "hunk" || line.kind === "meta"
          ? line.text
          : codeTokens(code, languageForPath(filePath)).map((token, tokenIndex) => (
              <span className={`tok tok-${token.kind}`} key={`${tokenIndex}-${token.text}`}>
                {token.text}
              </span>
            ))}
      </span>
    </span>
  );
}

function DiffViewer({ diff, selectedFile }: { diff: string; selectedFile?: string | null }) {
  const sections = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const visibleSections = selectedFile ? sections.filter((section) => section.file === selectedFile) : sections;
  if (!diff) return <p className="muted">No diff returned.</p>;

  return (
    <div className="diffViewer">
      {visibleSections.map((section, sectionIndex) => (
        <section className="diffFile" key={`${section.file}-${sectionIndex}`}>
          <header>
            <FileText size={14} />
            <strong>{section.file}</strong>
            <small>+{section.additions} -{section.deletions}</small>
          </header>
          <pre>
            {section.lines.map((line, lineIndex) => (
              <DiffLineRow filePath={section.file} line={line} key={`${lineIndex}-${line.text}`} />
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function CodePreviewDrawer({
  diff,
  filePath,
  onClose
}: {
  diff: ProjectDiff;
  filePath: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"current" | "before" | "after">("current");
  const [previews, setPreviews] = useState<Partial<Record<"current" | "before" | "after", FilePreview>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const canCompare = Boolean(diff.baseTree && diff.currentTree);
  const active = previews[tab];

  const loadPreview = useCallback(
    async (nextTab: "current" | "before" | "after") => {
      setTab(nextTab);
      if (previews[nextTab]) {
        setError("");
        return;
      }
      setLoading(true);
      setError("");
      try {
        const query = `cwd=${encodeURIComponent(diff.root)}&path=${encodeURIComponent(filePath)}`;
        const tree = nextTab === "before" ? diff.baseTree : nextTab === "after" ? diff.currentTree : null;
        const preview = tree
          ? await getJson<FilePreview>(`/api/projects/file-at-tree?${query}&tree=${encodeURIComponent(tree)}`)
          : await getJson<FilePreview>(`/api/projects/file?${query}`);
        setPreviews((current) => ({ ...current, [nextTab]: preview }));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [diff.baseTree, diff.currentTree, diff.root, filePath, previews]
  );

  useEffect(() => {
    if (!previews.current) loadPreview("current");
  }, [loadPreview, previews.current]);

  return (
    <section className="codePreviewDrawer">
      <header>
        <span>
          <Code2 size={15} />
          <strong>{filePath}</strong>
        </span>
        <button className="inlineIconButton" type="button" onClick={onClose}>
          <X size={14} />
          Close
        </button>
      </header>
      <div className="segmentedMini">
        <button className={tab === "current" ? "active" : ""} type="button" onClick={() => loadPreview("current")}>
          Current
        </button>
        <button className={tab === "before" ? "active" : ""} disabled={!canCompare} type="button" onClick={() => loadPreview("before")}>
          Before
        </button>
        <button className={tab === "after" ? "active" : ""} disabled={!canCompare} type="button" onClick={() => loadPreview("after")}>
          After
        </button>
      </div>
      {loading ? <p className="muted">Loading code…</p> : null}
      {error ? <p className="errorText">{error}</p> : null}
      {active && !active.exists ? <p className="muted">File does not exist in this view.</p> : null}
      {active?.tooLarge ? <p className="muted">File is too large to preview ({active.size} bytes).</p> : null}
      {active?.binary ? <p className="muted">Binary file preview is not available.</p> : null}
      {active?.content !== null && active?.content !== undefined ? <HighlightedCode filePath={filePath} text={active.content} /> : null}
    </section>
  );
}

export function ProjectDiffPanel({
  compact = false,
  data,
  onOpenFile
}: {
  compact?: boolean;
  data: ProjectDiff | null;
  onOpenFile?: (filePath: string) => void;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [codeFile, setCodeFile] = useState<string | null>(null);
  const sections = useMemo(() => parseUnifiedDiff(data?.diff || ""), [data?.diff]);

  useEffect(() => {
    if (!data?.files.length) {
      setSelectedFile(null);
      return;
    }
    if (!selectedFile || !data.files.some((file) => file.path === selectedFile)) setSelectedFile(data.files[0].path);
  }, [data?.files, selectedFile]);

  if (!data) return <p className="muted">No diff returned.</p>;
  if (!data.hasChanges) {
    return (
      <div className={`diffPanel ${compact ? "compact" : ""}`}>
        {compact ? <p className="muted">No working-tree changes</p> : (
          <div className="diffSummary">
            <strong>No working-tree changes</strong>
            <small>{data.root}</small>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`diffPanel ${compact ? "compact" : ""}`}>
      {compact ? null : (
      <div className="diffSummary">
        <strong>
          {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
        </strong>
        <small>
          {data.branch || "detached"} · +{data.additions} -{data.deletions}
        </small>
        <small>{data.root}</small>
      </div>
      )}
      <div className="diffBrowser">
        <aside className="diffFileNav">
          <button className={!selectedFile ? "selected" : ""} type="button" onClick={() => setSelectedFile(null)}>
            <ListTree size={14} />
            <span>All files</span>
            <code>{data.files.length}</code>
          </button>
          {data.files.map((file) => (
            <button
              className={selectedFile === file.path ? "selected" : ""}
              key={file.path}
              title={file.path}
              type="button"
              onClick={() => setSelectedFile(file.path)}
            >
              <FileText size={13} />
              <span>{file.path}</span>
              <code>{file.status}</code>
              {!file.binary && !file.tooLarge ? <small>+{file.additions} -{file.deletions}</small> : null}
            </button>
          ))}
        </aside>
        <section className="diffContent">
          <div className="diffToolbar">
            <strong>{selectedFile || "All files"}</strong>
            <span>
              {selectedFile
                ? `${sections.find((section) => section.file === selectedFile)?.lines.length || 0} lines`
                : `${sections.length} diff section${sections.length === 1 ? "" : "s"}`}
            </span>
            {selectedFile ? (
              <>
                <button type="button" onClick={() => onOpenFile ? onOpenFile(selectedFile) : setCodeFile(selectedFile)}>
                  <Code2 size={14} />
                  Open file
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard?.writeText(
                      sections
                        .filter((section) => section.file === selectedFile)
                        .flatMap((section) => section.lines.map((line) => line.text))
                        .join("\n")
                    )
                  }
                >
                  <Copy size={14} />
                  Copy file diff
                </button>
              </>
            ) : null}
          </div>
          <DiffViewer diff={data.diff} selectedFile={selectedFile} />
        </section>
      </div>
      {codeFile && !onOpenFile ? <CodePreviewDrawer diff={data} filePath={codeFile} onClose={() => setCodeFile(null)} /> : null}
      {compact ? null : (
        <details>
          <summary>Raw git status</summary>
          <pre className="diffRaw">{data.status || "clean"}</pre>
        </details>
      )}
    </div>
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
  const output = text || (streaming ? "Waiting for output…" : "…");
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
