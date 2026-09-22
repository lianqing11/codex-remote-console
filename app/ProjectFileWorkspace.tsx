"use client";

import {
  ArrowLeft,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  ImageOff,
  LoaderCircle,
  RefreshCcw,
  Upload
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  projectAssetUrl,
  resolveProjectReference,
  type ProjectFilePreview,
  type ProjectTreeListing
} from "./projectFileUtils";
import { getJson } from "./apiClient";
import { formatBytes } from "./formatUtils";
import { ProjectUploadError, uploadProjectFile } from "./projectUploads";

const directoryCache = new Map<string, ProjectTreeListing>();
const projectSessionState = new Map<string, { directory: string; filePath: string | null }>();
const scrollPositions = new Map<string, number>();
const projectDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function projectConflictSummary(count: number) {
  return count === 1 ? "1 file already exists and needs confirmation." : `${count} files already exist and need confirmation.`;
}

function tokenizedLine(line: string, language: string) {
  const pattern =
    language === "json"
      ? /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g
      : language === "markdown"
        ? /(`[^`]+`|^#{1,6}\s.*|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
        : /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:and|as|async|await|break|case|catch|class|const|continue|def|elif|else|except|export|extends|false|finally|for|from|function|if|import|in|interface|is|lambda|let|none|null|or|pass|raise|return|true|try|type|while|with|yield)\b|-?\b\d+(?:\.\d+)?\b)/gi;
  const tokens: Array<{ text: string; kind: string }> = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) tokens.push({ text: line.slice(cursor, match.index), kind: "plain" });
    const text = match[0];
    const kind =
      text.startsWith("//") || text.startsWith("#") || text.startsWith("/*")
        ? "comment"
        : /^['"`]/.test(text)
          ? language === "json" && /^".*"$/.test(text) && line.slice(pattern.lastIndex).trimStart().startsWith(":")
            ? "key"
            : "string"
          : /^-?\d/.test(text)
            ? "number"
            : language === "markdown"
              ? "markup"
              : "keyword";
    tokens.push({ text, kind });
    cursor = pattern.lastIndex;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: "plain" });
  return tokens.length ? tokens : [{ text: line || " ", kind: "plain" }];
}

export type LineSelection = {
  path: string;
  start: number;
  end: number;
  text: string;
};

function lineFromPoint(root: HTMLElement, clientY: number) {
  const nodes = root.querySelectorAll<HTMLElement>("[data-line]");
  if (!nodes.length) return null;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return Number(node.dataset.line);
  }
  const first = nodes[0].getBoundingClientRect();
  const last = nodes[nodes.length - 1].getBoundingClientRect();
  if (clientY < first.top) return Number(nodes[0].dataset.line);
  if (clientY > last.bottom) return Number(nodes[nodes.length - 1].dataset.line);
  return null;
}

function SourceCode({
  text,
  language,
  path,
  highlight,
  onLineSelect
}: {
  text: string;
  language: string;
  path: string;
  highlight?: { start: number; end: number } | null;
  onLineSelect?: (selection: LineSelection) => void;
}) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const dragRef = useRef<{ start: number; end: number } | null>(null);
  const selectingRef = useRef(false);

  useEffect(() => {
    setDrag(null);
    dragRef.current = null;
  }, [path, highlight?.start, highlight?.end]);

  useEffect(() => {
    if (!highlight) return;
    document.querySelector(`.projectSourceLine[data-line="${highlight.start}"]`)?.scrollIntoView({ block: "center" });
  }, [highlight?.start, highlight?.end, path]);

  const selected = drag || highlight || null;
  const from = selected ? Math.min(selected.start, selected.end) : 0;
  const to = selected ? Math.max(selected.start, selected.end) : -1;

  const commit = (start: number, end: number) => {
    const rangeStart = Math.min(start, end);
    const rangeEnd = Math.max(start, end);
    onLineSelect?.({
      path,
      start: rangeStart,
      end: rangeEnd,
      text: lines.slice(rangeStart - 1, rangeEnd).join("\n")
    });
  };

  const startDrag = (event: ReactPointerEvent<HTMLPreElement>, line: number) => {
    if (!onLineSelect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectingRef.current = true;
    const anchor = event.shiftKey && (dragRef.current || highlight) ? (dragRef.current?.start || highlight?.start || line) : line;
    const next = { start: anchor, end: line };
    dragRef.current = next;
    setDrag(next);
  };

  return (
    <pre
      className="projectSourceCode"
      onPointerDown={(event) => {
        const gutter = (event.target as HTMLElement).closest(".projectSourceLineNo");
        if (!gutter) return;
        const line = lineFromPoint(event.currentTarget, event.clientY);
        if (!line) return;
        startDrag(event, line);
      }}
      onPointerMove={(event) => {
        if (!selectingRef.current || !dragRef.current) return;
        const line = lineFromPoint(event.currentTarget, event.clientY);
        if (!line || line === dragRef.current.end) return;
        const next = { start: dragRef.current.start, end: line };
        dragRef.current = next;
        setDrag(next);
      }}
      onPointerUp={(event) => {
        if (!selectingRef.current || !dragRef.current) return;
        selectingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const { start, end } = dragRef.current;
        commit(start, end);
      }}
      onPointerCancel={() => {
        selectingRef.current = false;
      }}
    >
      {lines.map((line, index) => {
        const n = index + 1;
        return (
          <span className={`projectSourceLine${n >= from && n <= to ? " selected" : ""}`} data-line={n} key={index}>
            <span className="projectSourceLineNo">{n}</span>
            <code>
              {tokenizedLine(line, language).map((token, tokenIndex) => (
                <span className={`tok tok-${token.kind}`} key={`${tokenIndex}-${token.text}`}>
                  {token.text}
                </span>
              ))}
            </code>
          </span>
        );
      })}
    </pre>
  );
}

function headingId(children: ReactNode) {
  return String(children)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({ children }: { children?: ReactNode }) {
    return <Tag id={headingId(children)}>{children}</Tag>;
  };
}

function ProjectMarkdown({
  content,
  file,
  root,
  onOpenProjectPath
}: {
  content: string;
  file: string;
  root: string;
  onOpenProjectPath: (path: string, hash?: string) => void;
}) {
  const components = useMemo<Components>(
    () => ({
      a({ href = "", children, ...props }) {
        const target = resolveProjectReference(file, href);
        if (target.kind === "external") {
          return (
            <a {...props} href={target.href} rel="noreferrer" target="_blank">
              {children}
            </a>
          );
        }
        if (target.kind === "anchor") return <a {...props} href={target.href}>{children}</a>;
        if (target.kind === "project") {
          return (
            <a
              {...props}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                onOpenProjectPath(target.path, target.hash);
              }}
            >
              {children}
            </a>
          );
        }
        return <span className="blockedMarkdownLink">{children}</span>;
      },
      img({ src = "", alt = "", ...props }) {
        const target = resolveProjectReference(file, typeof src === "string" ? src : "");
        const source =
          target.kind === "external"
            ? target.href
            : target.kind === "project" && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(target.path)
              ? projectAssetUrl(process.env.NEXT_PUBLIC_BASE_PATH || "", root, target.path)
              : "";
        return source ? <img {...props} alt={alt} loading="lazy" src={source} /> : <span className="markdownImageUnavailable"><ImageOff size={15} /> {alt || "Image unavailable"}</span>;
      },
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
      pre({ children }) {
        return <pre>{children}</pre>;
      },
      code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
        const language = /language-([^\s]+)/.exec(className || "")?.[1] || "text";
        const text = String(children).replace(/\n$/, "");
        if (!className) return <code {...props}>{children}</code>;
        return (
          <code className={className} {...props}>
            {text.split("\n").map((line, index) => (
              <span className="markdownHighlightedLine" key={index}>
                {tokenizedLine(line, language).map((token, tokenIndex) => (
                  <span className={`tok tok-${token.kind}`} key={`${tokenIndex}-${token.text}`}>{token.text}</span>
                ))}
                {index < text.split("\n").length - 1 ? "\n" : null}
              </span>
            ))}
          </code>
        );
      }
    }),
    [file, onOpenProjectPath, root]
  );

  return <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}

export default function ProjectFileWorkspace({
  root,
  requestedPath,
  highlight,
  maxUploadBytes,
  onRequestedPathHandled,
  onLineSelect
}: {
  root: string;
  requestedPath?: string | null;
  highlight?: { path: string; start: number; end: number } | null;
  maxUploadBytes: number;
  onRequestedPathHandled?: () => void;
  onLineSelect?: (selection: LineSelection) => void;
}) {
  const restored = root ? projectSessionState.get(root) : null;
  const [directory, setDirectory] = useState(restored?.directory || "");
  const [listing, setListing] = useState<ProjectTreeListing | null>(null);
  const [file, setFile] = useState<ProjectFilePreview | null>(null);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [treeError, setTreeError] = useState("");
  const [fileError, setFileError] = useState("");
  const [uploadsInProgress, setUploadsInProgress] = useState(0);
  const [uploadConflicts, setUploadConflicts] = useState<File[]>([]);
  const [uploadNotice, setUploadNotice] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const projectUploadInputRef = useRef<HTMLInputElement | null>(null);
  const conflictDialogRef = useRef<HTMLElement | null>(null);

  const loadDirectory = useCallback(async (nextDirectory: string, force = false) => {
    if (!root) return;
    setLoadingTree(true);
    setTreeError("");
    const cacheKey = `${root}:${nextDirectory}`;
    try {
      const next = !force && directoryCache.get(cacheKey)
        ? directoryCache.get(cacheKey)!
        : await getJson<ProjectTreeListing>(`/api/projects/tree?${new URLSearchParams({ cwd: root, path: nextDirectory })}`);
      directoryCache.set(cacheKey, next);
      setDirectory(next.path);
      setListing(next);
      projectSessionState.set(root, { directory: next.path, filePath: projectSessionState.get(root)?.filePath || null });
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTree(false);
    }
  }, [root]);

  const openFile = useCallback(async (filePath: string, hash = "") => {
    if (!root) return;
    setLoadingFile(true);
    setFileError("");
    try {
      const next = await getJson<ProjectFilePreview>(`/api/projects/read?${new URLSearchParams({ cwd: root, path: filePath })}`);
      setFile(next);
      setMode(next.viewer === "markdown" ? "preview" : "source");
      projectSessionState.set(root, { directory: next.path.split("/").slice(0, -1).join("/"), filePath: next.path });
      if (hash) requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }));
      return true;
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setLoadingFile(false);
    }
  }, [root]);

  const openProjectPath = useCallback(async (filePath: string, hash = "") => {
    await openFile(filePath, hash);
  }, [openFile]);

  const uploadFiles = useCallback(async (files: File[], overwrite = false) => {
    if (!root || !files.length) return;
    const accepted = files.filter((candidate) => candidate.size <= maxUploadBytes);
    const oversized = files.filter((candidate) => candidate.size > maxUploadBytes);
    if (!accepted.length) {
      setUploadNotice({
        tone: "error",
        text: `${oversized[0]?.name || "File"} exceeds the ${formatBytes(maxUploadBytes)} project upload limit.`
      });
      return;
    }

    const visibleNames = new Set((listing?.entries || []).map((entry) => entry.name));
    const knownConflicts = overwrite ? [] : accepted.filter((candidate) => visibleNames.has(candidate.name));
    const pending = overwrite ? accepted : accepted.filter((candidate) => !visibleNames.has(candidate.name));
    if (!pending.length) {
      setUploadConflicts(knownConflicts);
      const oversizedDetail = oversized.length ? ` ${oversized.length} exceed the ${formatBytes(maxUploadBytes)} limit.` : "";
      setUploadNotice({
        tone: "warning",
        text: `${projectConflictSummary(knownConflicts.length)}${oversizedDetail}`
      });
      return;
    }

    setUploadsInProgress((current) => current + pending.length);
    setUploadNotice(null);
    try {
      const results = await Promise.allSettled(
        pending.map((candidate) => uploadProjectFile({ root, directory, file: candidate, overwrite }))
      );
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const conflicts = overwrite
        ? []
        : results.flatMap((result, index) => (
          result.status === "rejected" && result.reason instanceof ProjectUploadError && result.reason.status === 409
            ? [pending[index]]
            : []
        ));
      conflicts.unshift(...knownConflicts);
      const failures = results.filter((result) => (
        result.status === "rejected"
        && (overwrite || !(result.reason instanceof ProjectUploadError) || result.reason.status !== 409)
      )) as PromiseRejectedResult[];

      if (uploaded.length) {
        directoryCache.delete(`${root}:${directory}`);
        await loadDirectory(directory, true);
        if (file && uploaded.some((item) => item.path === file.path)) await openFile(file.path);
      }
      setUploadConflicts(conflicts);

      const details: string[] = [];
      if (conflicts.length) details.push(projectConflictSummary(conflicts.length));
      if (oversized.length) details.push(`${oversized.length} exceed the ${formatBytes(maxUploadBytes)} limit.`);
      if (failures.length) {
        const reason = failures[0].reason;
        details.push(reason instanceof Error ? reason.message : String(reason));
      }
      const destination = directory || "project root";
      if (uploaded.length) {
        setUploadNotice({
          tone: details.length ? "warning" : "success",
          text: `Uploaded ${uploaded.length} file${uploaded.length === 1 ? "" : "s"} to ${destination}.${details.length ? ` ${details.join(" ")}` : ""}`
        });
      } else if (details.length) {
        setUploadNotice({ tone: conflicts.length ? "warning" : "error", text: details.join(" ") });
      }
    } finally {
      setUploadsInProgress((current) => Math.max(0, current - pending.length));
    }
  }, [directory, file, listing?.entries, loadDirectory, maxUploadBytes, openFile, root]);

  useEffect(() => {
    if (!root) {
      setListing(null);
      setFile(null);
      return;
    }
    setUploadConflicts([]);
    setUploadNotice(null);
    for (const key of [...directoryCache.keys()]) {
      if (!key.startsWith(`${root}:`)) directoryCache.delete(key);
    }
    const state = projectSessionState.get(root);
    setFile(null);
    loadDirectory(state?.directory || "");
    if (state?.filePath) openFile(state.filePath);
  }, [loadDirectory, openFile, root]);

  useEffect(() => {
    if (uploadConflicts.length) conflictDialogRef.current?.focus();
  }, [uploadConflicts.length]);

  useEffect(() => {
    if (!requestedPath || !root) return;
    openFile(requestedPath).finally(onRequestedPathHandled);
  }, [onRequestedPathHandled, openFile, requestedPath, root]);

  useEffect(() => {
    if (!file || !highlight || highlight.path !== file.path) return;
    setMode("source");
  }, [file?.path, highlight?.end, highlight?.path, highlight?.start]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !file) return;
    if (highlight?.path === file.path) return;
    const key = `${root}:${file.path}:${mode}`;
    requestAnimationFrame(() => {
      viewer.scrollTop = scrollPositions.get(key) || 0;
    });
  }, [file?.path, highlight?.path, mode, root]);

  const breadcrumbs = directory ? directory.split("/") : [];
  const source = file?.content || "";

  if (!root) {
    return <div className="projectFilesEmpty"><FolderOpen size={34} /><h2>Choose a project first</h2><p>Select a server directory to browse its files.</p></div>;
  }

  return (
    <div className={`projectFilesWorkspace ${file ? "fileSelected" : ""}`}>
      <aside className="projectTreePane">
        <header>
          <input
            className="hiddenFileInput"
            multiple
            ref={projectUploadInputRef}
            type="file"
            onChange={(event) => {
              void uploadFiles([...(event.currentTarget.files || [])]);
              event.currentTarget.value = "";
            }}
          />
          <button
            aria-label="Upload files to project"
            className="projectUploadButton"
            disabled={uploadsInProgress > 0 || loadingTree}
            title={`Upload files to ${directory || "project root"}`}
            type="button"
            onClick={() => projectUploadInputRef.current?.click()}
          >
            {uploadsInProgress > 0 ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={15} /> : <Upload aria-hidden="true" size={15} />}
            <span>{uploadsInProgress > 0 ? `Uploading ${uploadsInProgress}` : "Upload here"}</span>
          </button>
          <button aria-label="Refresh directory" title="Refresh directory" type="button" onClick={() => loadDirectory(directory, true)}><RefreshCcw size={15} /></button>
        </header>
        <nav className="projectBreadcrumbs" aria-label="Project path">
          <button type="button" onClick={() => loadDirectory("")}>root</button>
          {breadcrumbs.map((segment, index) => {
            const target = breadcrumbs.slice(0, index + 1).join("/");
            return <span key={target}><ChevronRight size={13} /><button type="button" onClick={() => loadDirectory(target)}>{segment}</button></span>;
          })}
        </nav>
        <div className="projectTreeList">
          <div aria-live="polite" className={`projectUploadStatus ${uploadNotice?.tone || ""}`} role="status">
            {uploadNotice?.text || ""}
          </div>
          {listing?.parent !== null && listing ? (
            <button className="projectTreeRow directory" type="button" onClick={() => loadDirectory(listing.parent || "")}>
              <ArrowLeft size={15} /><span><strong>..</strong><small>Parent directory</small></span>
            </button>
          ) : null}
          {listing?.entries.map((entry) => (
            <button
              className={`projectTreeRow ${entry.kind} ${file?.path === entry.path ? "selected" : ""}`}
              disabled={!entry.accessible}
              key={entry.path}
              title={entry.accessible ? entry.path : "Symlink target is outside the project"}
              type="button"
              onClick={() => entry.kind === "directory" ? loadDirectory(entry.path) : openFile(entry.path)}
            >
              {entry.kind === "directory" ? <Folder size={15} /> : <FileText size={15} />}
              <span><strong>{entry.name}</strong><small>{entry.symlink ? "symlink · " : ""}{entry.size === null ? "directory" : formatBytes(entry.size)}</small></span>
              {entry.kind === "directory" ? <ChevronRight size={14} /> : null}
            </button>
          ))}
          {listing?.truncated ? <p className="projectTreeNotice">Only the first 500 entries are shown.</p> : null}
          {!loadingTree && listing?.entries.length === 0 ? <p className="projectTreeNotice">This directory is empty.</p> : null}
          {loadingTree ? <p className="projectTreeNotice">Loading directory…</p> : null}
          {treeError ? <p className="errorText projectTreeNotice">{treeError}</p> : null}
        </div>
      </aside>

      <section className="projectFilePane">
        {file ? (
          <>
            <header className="projectFileHeader">
              <button className="projectFileBack" type="button" onClick={() => setFile(null)}><ArrowLeft size={15} /> Files</button>
              <span className="projectFileIdentity">
                {file.viewer === "markdown" ? <FileText size={17} /> : <Code2 size={17} />}
                <span><strong>{file.name}</strong><small>{file.path}</small></span>
              </span>
              <span className="projectFileMeta">{formatBytes(file.size)} · {projectDateFormatter.format(file.modifiedAt)}</span>
              <span className="projectFileActions">
                {file.viewer === "markdown" && !file.binary && !file.tooLarge ? (
                  <span className="segmentedMini">
                    <button className={mode === "preview" ? "active" : ""} type="button" onClick={() => setMode("preview")}>Preview</button>
                    <button className={mode === "source" ? "active" : ""} type="button" onClick={() => setMode("source")}>Source</button>
                  </span>
                ) : null}
                <button aria-label="Copy project-relative path" title="Copy project-relative path" type="button" onClick={() => navigator.clipboard?.writeText(file.path)}><Copy size={14} /><span>Copy Path</span></button>
                <button aria-label="Reload file" title="Reload file" type="button" onClick={() => openFile(file.path)}><RefreshCcw size={14} /></button>
              </span>
            </header>
            <div
              className={`projectFileViewer ${mode}`}
              ref={viewerRef}
              onScroll={(event) => scrollPositions.set(`${root}:${file.path}:${mode}`, event.currentTarget.scrollTop)}
            >
              {loadingFile ? <p className="projectFileStatus">Loading file…</p> : null}
              {fileError ? <p className="errorText projectFileStatus">{fileError}</p> : null}
              {file.tooLarge ? <p className="projectFileStatus">This file is too large to preview ({formatBytes(file.size)}). The limit is 512 KiB.</p> : null}
              {file.binary ? <p className="projectFileStatus">Binary file preview is not available.</p> : null}
              {!file.tooLarge && !file.binary && file.content !== null ? (
                file.viewer === "markdown" && mode === "preview"
                  ? <article className="markdownBody fileMarkdown"><ProjectMarkdown content={source} file={file.path} root={root} onOpenProjectPath={openProjectPath} /></article>
                  : (
                    <SourceCode
                      highlight={highlight?.path === file.path ? highlight : null}
                      language={file.language}
                      onLineSelect={onLineSelect}
                      path={file.path}
                      text={source}
                    />
                  )
              ) : null}
            </div>
          </>
        ) : (
          <div className="projectFilesEmpty">
            <FileText size={34} />
            <h2>Select a file to read</h2>
            <p>Markdown opens as a rendered document. Python and other text files open with line numbers.</p>
            {fileError ? <p className="errorText">{fileError}</p> : null}
          </div>
        )}
      </section>
      {uploadConflicts.length ? (
        <div className="dialogBackdrop">
          <section
            aria-labelledby="project-upload-conflict-title"
            aria-modal="true"
            className="dialog projectUploadConflictDialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && uploadsInProgress === 0) setUploadConflicts([]);
            }}
            role="dialog"
            ref={conflictDialogRef}
            tabIndex={-1}
          >
            <header>
              <div>
                <h2 id="project-upload-conflict-title">Replace existing files?</h2>
                <p>The following files already exist in <code>{directory || "project root"}</code>.</p>
              </div>
            </header>
            <ul>
              {uploadConflicts.map((candidate, index) => <li key={`${candidate.name}-${index}`}>{candidate.name}</li>)}
            </ul>
            <footer>
              <button type="button" disabled={uploadsInProgress > 0} onClick={() => setUploadConflicts([])}>Cancel</button>
              <button
                className="primaryButton"
                type="button"
                disabled={uploadsInProgress > 0}
                onClick={() => {
                  const conflicts = uploadConflicts;
                  setUploadConflicts([]);
                  void uploadFiles(conflicts, true);
                }}
              >
                Replace {uploadConflicts.length} file{uploadConflicts.length === 1 ? "" : "s"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
