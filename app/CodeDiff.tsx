"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Code2, Copy, FileText, ListTree, X } from "lucide-react";
import { getJson } from "./apiClient";
import type { ProjectDiff, FilePreview } from "./conversationViews";

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

export function DiffViewer({ diff, selectedFile }: { diff: string; selectedFile?: string | null }) {
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
          {data.truncated ? <p className="muted">Diff text is truncated to 512 KiB. Open a file to see its full contents.</p> : null}
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

