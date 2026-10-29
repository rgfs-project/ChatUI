import { Check, Copy } from "lucide-react";
import { memo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "./copy";

/**
 * Untrusted model output → React elements (INV-22). Raw HTML is never
 * interpreted: react-markdown escapes it (no rehype-raw), so tags in the source
 * appear as text. URLs are filtered to safe schemes; images are not loaded.
 * Rendering never changes the stored Markdown.
 */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

export function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  if (!cleaned) return "";
  // Relative links stay in-app; anything with a scheme must be allowlisted.
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) && !SAFE_SCHEME.test(cleaned)) return "";
  return cleaned;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ language, children }: { language: string | null; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const source = textOf(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language ?? "text"}</span>
        <button
          type="button"
          className="code-copy"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void copyText(source).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1_500);
            });
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="selectable">
        <code>{source}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  pre({ children }) {
    // Block code: <pre><code class="language-x">…</code></pre>.
    const child: unknown = Array.isArray(children) ? (children as unknown[])[0] : children;
    const props = (child as { props?: { className?: string; children?: ReactNode } } | null)?.props;
    const language = /language-([\w+#.-]+)/.exec(props?.className ?? "")?.[1] ?? null;
    return <CodeBlock language={language}>{props?.children ?? children}</CodeBlock>;
  },
  code({ children, className }) {
    return <code className={`inline-code${className ? ` ${className}` : ""}`}>{children}</code>;
  },
  a({ href, children }) {
    const target = safeUrl(href ?? "");
    if (!target) return <span className="link-removed">{children}</span>;
    return (
      <a href={target} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ alt, src }) {
    // No third-party image loads (CSP img-src 'self'); show the reference instead.
    const target = safeUrl(typeof src === "string" ? src : "");
    const label = alt ? `Image: ${alt}` : "Image";
    return target ? (
      <a href={target} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

type MarkdownProps = Pick<ComponentProps<typeof ReactMarkdown>, "children">;

/** Memoized on the source text: an unrelated re-render never reparses. */
export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown selectable">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
