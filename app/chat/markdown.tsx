import { memo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock } from "./render/code";
import { lazyModule, useLazy } from "./render/lazy";
import { useUiBlocks } from "./ui/context";
import { DisplayMath, InlineMath, normalizeMath } from "./render/math";
import { TableBlock } from "./render/table";

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

/** The UI block renderer: a separate chunk, loaded when a reply has a ```ui block. */
const uiBlocksModule = lazyModule(() => import("./ui/blocks"));

/** A ```ui block (Phase 14b): rendered when enabled and readable, otherwise its source as code. */
function UiFence({ source }: { source: string }) {
  const { enabled, streaming } = useUiBlocks();
  const blocks = useLazy(uiBlocksModule, enabled);
  if (!enabled || !blocks?.parseUiBlock(source, !streaming).ok)
    return <CodeBlock language="ui" source={source} />;
  return <blocks.UiBlock source={source} streaming={streaming} />;
}

const components: Components = {
  pre({ children }) {
    // Block code: <pre><code class="language-x">…</code></pre>; display math
    // (remark-math): <pre><code class="language-math math-display">.
    const child: unknown = Array.isArray(children) ? (children as unknown[])[0] : children;
    const props = (child as { props?: { className?: string; children?: ReactNode } } | null)?.props;
    const className = props?.className ?? "";
    const source = textOf(props?.children ?? children).replace(/\n$/, "");
    if (className.includes("math-display")) return <DisplayMath tex={source} />;
    const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? null;
    if (language === "ui") return <UiFence source={source} />;
    return <CodeBlock language={language} source={source} />;
  },
  code({ children, className }) {
    if (className?.includes("math-inline")) return <InlineMath tex={textOf(children)} />;
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
    return <TableBlock>{children}</TableBlock>;
  },
};

const REMARK_PLUGINS = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]] as NonNullable<
  ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
>;

type MarkdownProps = Pick<ComponentProps<typeof ReactMarkdown>, "children">;

/** Memoized on the source text: an unrelated re-render never reparses. */
export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown selectable">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={safeUrl}>
        {typeof children === "string" ? normalizeMath(children) : children}
      </ReactMarkdown>
    </div>
  );
});
