"use client";

// Renders assistant text as markdown (GFM) with syntax-highlighted code blocks —
// the Claude-style look: a language label + copy button on each fenced block,
// plus bold/lists/links/inline-code. Safe mid-stream: an unclosed ``` just
// renders as a growing code block until the closing fence arrives.

import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import s from "../chat.module.css";

function textOf(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: ReactNode } };
  return el.props ? textOf(el.props.children) : "";
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={s.codeCopy}
      onClick={() => {
        try {
          void navigator.clipboard.writeText(getText());
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({
  lang,
  className,
  children,
}: {
  lang: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={s.codeBlock}>
      <div className={s.codeHeader}>
        <span className={s.codeLang}>{lang || "text"}</span>
        <CopyButton getText={() => textOf(children)} />
      </div>
      <pre className={s.codePre}>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className={s.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Unwrap <pre>; the block code renderer below provides its own.
          pre: ({ children }) => <>{children}</>,
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className ?? "");
            if (match) {
              return (
                <CodeBlock lang={match[1]} className={className}>
                  {children}
                </CodeBlock>
              );
            }
            return <code className={s.inlineCode}>{children}</code>;
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
