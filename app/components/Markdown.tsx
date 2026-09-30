import { Check, Copy } from "lucide-react";
import { memo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * Safe Markdown (INV-22): raw HTML is dropped (never executed), output is
 * sanitized, only safe URL schemes survive (no javascript:/data:), and links
 * open with rel="noopener noreferrer". Rendering never changes the stored
 * Markdown. Incomplete fences, tables and lists render stably while streaming.
 */

const SAFE_URL = /^(https?:|mailto:|#|\/(?!\/))/i;

export function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  return SAFE_URL.test(cleaned) ? cleaned : "";
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);
  const code = textOf(children);
  const language = /language-([\w-]+)/.exec(
    (children as { props?: { className?: string } } | undefined)?.props?.className ?? "",
  )?.[1];
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="code-language">{language ?? "text"}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1500);
            });
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

function MarkdownImpl({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span className="image-placeholder">[image: {alt ?? "untitled"}]</span>,
          pre: CodeBlock,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized by text: a streaming token re-renders only the growing message. */
export const Markdown = memo(MarkdownImpl);
