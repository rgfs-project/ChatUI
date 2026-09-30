import type { Element as HastElement, ElementContent } from "hast";
import { Download } from "lucide-react";
import {
  createContext,
  memo,
  Suspense,
  use,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { downloadName, grammarFor } from "../lib/code-languages";
import { BlockSplitter } from "../lib/markdown-blocks";
import { count } from "../lib/render-counters";
import { remarkGfmParse } from "../lib/remark-gfm-parse";
import { remarkMathParse } from "../lib/remark-math-parse";
import {
  highlightSnapshot,
  loadMath,
  requestHighlight,
  subscribeHighlights,
} from "../lib/renderers";
import { CopyButton } from "./CopyButton";

/**
 * The answer renderer (INV-22, INV-45, INV-46). Untrusted Markdown renders
 * inert: raw HTML is dropped (never executed), output is sanitized, only safe
 * URL schemes survive (no javascript:/data:), and links open with
 * rel="noopener noreferrer". Math and syntax highlighting are separate
 * on-demand chunks; if either fails to load, the source stays readable.
 * Rendering never changes the stored Markdown. While a reply streams, each
 * top-level block renders on its own (`StreamingBody`), so finished blocks
 * keep their DOM, selection and focus while the last one grows.
 */

const SAFE_URL = /^(https?:|mailto:|#|\/(?!\/))/i;

export function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  return SAFE_URL.test(cleaned) ? cleaned : "";
}

/** GitHub's sanitize schema, plus the two math classes on `<code>`. */
const schema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};

/** Where a block sits in its message: its source length, and whether it may still grow. */
const BlockContext = createContext<{ growing: boolean; length: number }>({
  growing: false,
  length: 0,
});

function hastText(node: HastElement | ElementContent | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(hastText).join("");
  return "";
}

function classesOf(node: HastElement | undefined): string[] {
  const value = node?.properties.className;
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
}

/** Ends at the end of a block that may still grow: an unfinished fence. */
function useOpenAtEnd(node: HastElement | undefined): boolean {
  const { growing, length } = useContext(BlockContext);
  return growing && node?.position?.end.offset === length;
}

// ---- Math -----------------------------------------------------------------

interface MathSlotProps {
  tex: string;
  display: boolean;
  block?: boolean;
  pending?: boolean;
}

/** Shown while the math chunk loads, or if it can't: the inert source. */
function MathFallback({ tex, display, block = false }: MathSlotProps) {
  if (block)
    return (
      <pre className="math-source" data-testid="math-source">
        <code>{tex}</code>
      </pre>
    );
  return (
    <code
      className={display ? "math-source math-source-display" : "math-source"}
      data-testid="math-source"
    >
      {tex}
    </code>
  );
}

function LoadedMath(props: MathSlotProps) {
  const { MathView } = use(loadMath());
  return <MathView {...props} />;
}

function MathSlot(props: MathSlotProps) {
  const fallback = <MathFallback {...props} />;
  return (
    <ErrorBoundary fallback={fallback} resetKeys={[props.tex]}>
      <Suspense fallback={fallback}>
        <LoadedMath {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

// ---- Code -----------------------------------------------------------------

/** Highlighted children once ready (never during hydration: server HTML is plain). */
function useHighlight(code: string, label: string | undefined, enabled: boolean): ReactNode {
  const highlighted = useSyncExternalStore(
    subscribeHighlights,
    () => (enabled ? highlightSnapshot(code, label) : null),
    () => null,
  );
  const missing = enabled && highlighted === null;
  useEffect(() => {
    if (missing) requestHighlight(code, label);
  }, [code, label, missing]);
  return highlighted;
}

function download(code: string, label: string | undefined) {
  const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName(label);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * A read-only code block: language label, copy and download of the exact
 * source, horizontal scrolling (focusable for keyboard users), and syntax
 * colors once the lazy highlighter has them. An unfinished fence stays plain
 * until it closes.
 */
function CodeBlock({
  code,
  language,
  open,
}: {
  code: string;
  language: string | undefined;
  open: boolean;
}) {
  const highlighted = useHighlight(code, language, !open && grammarFor(language) !== null);
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-toolbar">
        <span className="code-language">{language ?? "text"}</span>
        <span className="code-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Download code"
            title="Download code"
            onClick={() => {
              download(code, language);
            }}
          >
            <Download size={14} aria-hidden />
          </button>
          <CopyButton text={code} label="Copy code" size={14} />
        </span>
      </div>
      <pre tabIndex={0}>
        <code
          className={
            [language ? `language-${language}` : "", highlighted ? "hljs" : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
        >
          {highlighted ?? code}
        </code>
      </pre>
    </div>
  );
}

function Pre({ node }: { node?: HastElement | undefined }) {
  const open = useOpenAtEnd(node);
  const code = node?.children.find(
    (child): child is HastElement => child.type === "element" && child.tagName === "code",
  );
  const classes = classesOf(code);
  if (classes.includes("language-math"))
    return <MathSlot tex={hastText(code)} display block pending={open} />;
  const language = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
  // A fence's text ends with its last line's newline; the source to copy doesn't.
  return <CodeBlock code={hastText(code).replace(/\n$/, "")} language={language} open={open} />;
}

function InlineCode({
  node,
  className,
  children,
}: {
  node?: HastElement | undefined;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const classes = classesOf(node);
  if (classes.includes("language-math"))
    return <MathSlot tex={hastText(node)} display={classes.includes("math-display")} />;
  return <code className={className}>{children}</code>;
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="image-placeholder">[image: {alt ?? "untitled"}]</span>,
  pre: Pre,
  code: InlineCode,
};

const remarkPlugins = [remarkGfmParse, remarkMathParse];
const rehypePlugins = [[rehypeSanitize, schema] as [typeof rehypeSanitize, SanitizeSchema]];

/** One Markdown document (or one block of a streaming one). */
const MarkdownPart = memo(function MarkdownPart({
  source,
  growing,
}: {
  source: string;
  growing: boolean;
}) {
  count("markdownPartRenders");
  return (
    <BlockContext value={{ growing, length: source.length }}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={safeUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </BlockContext>
  );
});

/** A live reply: one keyed part per top-level block; only the last one re-parses. */
function StreamingBody({ text, growing }: { text: string; growing: boolean }) {
  const [splitter] = useState(() => new BlockSplitter());
  const blocks = splitter.split(text);
  return blocks.map((block, index) => (
    <MarkdownPart
      key={block.start}
      source={block.source}
      growing={growing && index === blocks.length - 1}
    />
  ));
}

// ---- Copying math as LaTeX -------------------------------------------------

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "BLOCKQUOTE",
  "TABLE",
]);

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.tagName === "BUTTON") return "";
  if (node instanceof Element && node.tagName === "BR") return "\n";
  let text = "";
  for (const child of node.childNodes) text += plainText(child);
  return node instanceof Element && BLOCK_TAGS.has(node.tagName) ? `${text}\n` : text;
}

function delimited(element: Element): string {
  const tex = element.getAttribute("data-tex") ?? "";
  return element.hasAttribute("data-display") ? `$$${tex}$$` : `$${tex}$`;
}

/**
 * Copying a selection that includes rendered math puts each formula's LaTeX
 * source on the clipboard (as `$…$` / `$$…$$`) instead of its MathML text.
 */
function copyMathAsTex(event: ClipboardEvent<HTMLDivElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const within = (ancestor instanceof Element ? ancestor : ancestor.parentElement)?.closest(
    "[data-tex]",
  );
  let text: string;
  if (within) {
    text = delimited(within);
  } else {
    const fragment = range.cloneContents();
    const formulas = fragment.querySelectorAll("[data-tex]");
    if (formulas.length === 0) return;
    for (const formula of formulas) formula.replaceWith(delimited(formula));
    text = plainText(fragment).replace(/\n+$/, "");
  }
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
}

function MarkdownImpl({
  text,
  live = false,
  growing = false,
}: {
  text: string;
  /** A live reply: rendered block by block (kept until the stored copy replaces it). */
  live?: boolean;
  /** Its text is still growing: an unfinished last block stays unhighlighted. */
  growing?: boolean;
}) {
  // Rendered in the same commit as the text changes (no deferral): the
  // transcript's scroll pin follows growth in that commit's layout effect.
  return (
    <div className="markdown" onCopy={copyMathAsTex}>
      {live ? (
        <StreamingBody text={text} growing={growing} />
      ) : (
        <MarkdownPart source={text} growing={false} />
      )}
    </div>
  );
}

/** Memoized by text: a streaming token re-renders only the growing message. */
export const Markdown = memo(MarkdownImpl);
