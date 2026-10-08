import { Download } from "lucide-react";
import { lazy, memo, Suspense, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { Element, ElementContent } from "hast";
import type { Processor } from "unified";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./ui";

const MathView = lazy(() => import("./MathView"));
const Highlight = lazy(() => import("./Highlight"));

/** GFM (tables, task lists, strikethrough, autolinks) and $math$ in the parser. */
function remarkExtensions(this: Processor) {
  const data = this.data() as Record<string, unknown>;
  const add = (key: string, value: unknown) => {
    const list = (data[key] as unknown[] | undefined) ?? [];
    list.push(value);
    data[key] = list;
  };
  add("micromarkExtensions", gfm());
  add("micromarkExtensions", math({ singleDollarTextMath: true }));
  add("fromMarkdownExtensions", gfmFromMarkdown());
  add("fromMarkdownExtensions", mathFromMarkdown());
}

function textOf(nodes: readonly ElementContent[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.value : n.type === "element" ? textOf(n.children) : ""))
    .join("");
}

function classes(node: Element | undefined): string[] {
  const value = node?.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
}

const EXTENSIONS: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  ruby: "rb",
  rust: "rs",
  shell: "sh",
  bash: "sh",
  markdown: "md",
  yaml: "yml",
  kotlin: "kt",
  csharp: "cs",
};

function download(code: string, language: string | null) {
  const ext = language ? (EXTENSIONS[language] ?? language) : "txt";
  const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `snippet.${ext.replace(/[^a-z0-9]/gi, "") || "txt"}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function CodeBlock(props: { code: string; language: string | null }) {
  return (
    <div className="code-block">
      <div className="code-header">
        <span>{props.language ?? "text"}</span>
        <span className="code-tools">
          <IconButton
            label="Download code"
            className="muted-icon small"
            onClick={() => {
              download(props.code, props.language);
            }}
          >
            <Download size={16} aria-hidden />
          </IconButton>
          <CopyButton text={props.code} label="Copy code" className="muted-icon small" />
        </span>
      </div>
      <pre>
        <code>
          <Suspense fallback={props.code}>
            <Highlight code={props.code} language={props.language} />
          </Suspense>
        </code>
      </pre>
    </div>
  );
}

function MathNode(props: { tex: string; display: boolean }) {
  return (
    <Suspense fallback={<code className="math-source">{props.tex}</code>}>
      <MathView tex={props.tex} display={props.display} />
    </Suspense>
  );
}

const components: Components = {
  pre({ node }) {
    const code = node?.children.find(
      (c): c is Element => c.type === "element" && c.tagName === "code",
    );
    const cls = classes(code);
    const text = textOf(code?.children ?? []).replace(/\n$/, "");
    if (cls.includes("math-display")) return <MathNode tex={text} display />;
    const language = cls.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
    return <CodeBlock code={text} language={language} />;
  },
  code({ node, children }) {
    if (classes(node).includes("math-inline"))
      return <MathNode tex={textOf(node?.children ?? [])} display={false} />;
    return <code className="inline-code">{children}</code>;
  },
  a({ href, children }) {
    const external = href !== undefined && /^https?:/i.test(href);
    return (
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
      >
        {children}
      </a>
    );
  },
  // Remote images are never fetched (privacy, CSP): the link stays.
  img({ src, alt }) {
    const href = typeof src === "string" ? src : undefined;
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {alt === undefined || alt === "" ? href : alt}
      </a>
    ) : (
      <span>{alt}</span>
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

/** A reply as formatted text. Raw HTML in it is never rendered. */
export const Markdown = memo(function Markdown(props: { text: string }): ReactNode {
  return (
    <ReactMarkdown remarkPlugins={[remarkExtensions]} components={components} skipHtml>
      {props.text}
    </ReactMarkdown>
  );
});
