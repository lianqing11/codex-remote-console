"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeUrl(url: string) {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return trimmed;
  return "";
}

export default function SafeMarkdown({
  text,
  expanded,
  streaming
}: {
  text: string;
  expanded?: boolean;
  streaming?: boolean;
}) {
  const [rendered, setRendered] = useState(text);
  const latest = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPaintedText = useRef(false);
  useEffect(() => {
    latest.current = text;
    if (!streaming) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      setRendered(text);
      hasPaintedText.current = Boolean(text);
      return;
    }
    if (!hasPaintedText.current && text) {
      hasPaintedText.current = true;
      setRendered(text);
      performance.clearMarks("console:first-text");
      performance.mark("console:first-text");
      requestAnimationFrame(() => {
        const received = performance.getEntriesByName("console:first-output-received").at(-1)?.startTime;
        window.dispatchEvent(new CustomEvent("console:first-text-visible", { detail: { at: performance.now(), received } }));
      });
      return;
    }
    // Throttle, rather than debounce: continuous deltas must not postpone paint.
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setRendered(latest.current);
      }, 80);
    }
  }, [streaming, text]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const visibleText = streaming ? rendered || text : text;

  return (
    <div className={`markdownBody gfmMarkdown ${expanded ? "expandedMarkdown" : ""}`}>
      {visibleText ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={safeUrl}
          components={{
            a({ href = "", children, ...props }) {
              if (!href) return <span>{children}</span>;
              const external = /^https?:/i.test(href);
              return (
                <a {...props} href={href} rel={external ? "noreferrer" : undefined} target={external ? "_blank" : undefined}>
                  {children}
                </a>
              );
            },
            img({ src = "", alt = "", ...props }) {
              if (!src) return null;
              return <img {...props} src={src} alt={alt} loading="lazy" decoding="async" />;
            },
            pre({ children, ...props }) {
              return <pre {...props} className="markdownPre">{children}</pre>;
            }
          }}
        >
          {visibleText}
        </ReactMarkdown>
      ) : <p>{streaming ? "Waiting for output" : "…"}</p>}
      {streaming ? <span className="streamCursor" /> : null}
    </div>
  );
}
