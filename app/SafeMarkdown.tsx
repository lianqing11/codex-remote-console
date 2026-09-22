"use client";

import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (!streaming) {
      setRendered(text);
      return;
    }
    const timer = window.setTimeout(() => setRendered(text), 100);
    return () => window.clearTimeout(timer);
  }, [streaming, text]);

  return (
    <div className={`markdownBody gfmMarkdown ${expanded ? "expandedMarkdown" : ""}`}>
      {rendered ? (
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
              return <img {...props} src={src} alt={alt} />;
            },
            pre({ children, ...props }) {
              return <pre {...props} className="markdownPre">{children}</pre>;
            }
          }}
        >
          {rendered}
        </ReactMarkdown>
      ) : <p>{streaming ? "Waiting for output" : "…"}</p>}
      {streaming ? <span className="streamCursor" /> : null}
    </div>
  );
}
