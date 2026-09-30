import { createElement, type ReactNode } from "react";
import temml from "temml";
import { CopyButton } from "../CopyButton";
import mathCss from "./math.css?url";

/**
 * Math rendering (Phase 14, INV-45): LaTeX → MathML with Temml, loaded only
 * for messages that contain math. The browser renders MathML natively, and
 * the same markup is what assistive technology reads (no hidden duplicate).
 *
 * Temml's tree is converted to React elements through an allowlist of MathML
 * elements and attributes; nothing is parsed as HTML, links and images are
 * dropped, and untrusted commands (`\href`, `\url`, `\includegraphics`,
 * `\html…`) are rejected by Temml (`trust: false`). Macro expansion is
 * bounded. The few inline styles Temml emits (matrix cell padding, boxes) are
 * applied through CSSOM refs, which the strict CSP allows, never as `style`
 * attributes, which it blocks. A formula Temml can't render falls back to its
 * inert source.
 */

/** Longest formula rendered; longer ones show their source. */
export const MAX_TEX_LENGTH = 4000;

const ELEMENTS = new Set([
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mstyle",
  "merror",
  "mpadded",
  "mphantom",
  "munder",
  "mover",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "menclose",
]);

const ATTRIBUTES = new Set([
  "accent",
  "accentunder",
  "align",
  "columnalign",
  "columnlines",
  "columnspacing",
  "columnspan",
  "depth",
  "dir",
  "display",
  "displaystyle",
  "encoding",
  "fence",
  "form",
  "frame",
  "framespacing",
  "height",
  "largeop",
  "linethickness",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "movablelimits",
  "notation",
  "rowalign",
  "rowlines",
  "rowspacing",
  "rowspan",
  "rspace",
  "scriptlevel",
  "separator",
  "stretchy",
  "symmetric",
  "voffset",
  "width",
]);

/** CSS properties Temml sets, as camelCase CSSOM names. */
const STYLE_PROPERTIES = new Set([
  "backgroundColor",
  "border",
  "borderBottom",
  "borderLeft",
  "borderRight",
  "borderTop",
  "borderWidth",
  "borderStyle",
  "color",
  "height",
  "marginLeft",
  "marginRight",
  "padding",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "verticalAlign",
  "width",
]);
/** Lengths, keywords and colors only: no functions such as `url()`. */
const SAFE_STYLE_VALUE = /^[\w\s.#%,-]*$/;

interface TemmlNode {
  type?: unknown;
  text?: unknown;
  attributes?: Record<string, unknown>;
  classes?: unknown[];
  style?: Record<string, unknown>;
  children?: unknown[];
}

function applyStyles(style: Record<string, string>) {
  return (element: Element | null) => {
    if (!element || !("style" in element)) return;
    const declarations = element.style as Record<string, string>;
    for (const [name, value] of Object.entries(style)) declarations[name] = value;
  };
}

function convert(node: unknown, key: number): ReactNode {
  if (node === null || typeof node !== "object") return null;
  const n = node as TemmlNode;
  const children = Array.isArray(n.children)
    ? n.children.map((child, index) => convert(child, index))
    : [];
  if (typeof n.type !== "string") {
    // A text node, or a container without a MathML type (fragments; the
    // equation-number span and anchors, which are kept as plain content).
    if (typeof n.text === "string" && !Array.isArray(n.children)) return n.text;
    return children.length > 0 ? children : null;
  }
  if (!ELEMENTS.has(n.type)) return children.length > 0 ? children : null;
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(n.attributes ?? {}))
    if (ATTRIBUTES.has(name) && (typeof value === "string" || typeof value === "number"))
      props[name] = String(value);
  const classes = (n.classes ?? []).filter((c): c is string => typeof c === "string" && c !== "");
  if (classes.length > 0) props.className = classes.join(" ");
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(n.style ?? {}))
    if (STYLE_PROPERTIES.has(name) && typeof value === "string" && SAFE_STYLE_VALUE.test(value))
      style[name] = value;
  if (Object.keys(style).length > 0) props.ref = applyStyles(style);
  return createElement(n.type, props, ...children);
}

export type MathResult = { ok: true; element: ReactNode } | { ok: false; reason: string };

/** Rendered formulas by (mode, source): streaming re-renders reuse them. */
const cache = new Map<string, MathResult>();
const CACHE_LIMIT = 500;

/** Renders TeX to a MathML React tree, or explains why it can't. */
export function renderMath(tex: string, display: boolean): MathResult {
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: MathResult;
  if (tex.trim() === "") result = { ok: false, reason: "empty formula" };
  else if (tex.length > MAX_TEX_LENGTH) result = { ok: false, reason: "formula too long" };
  else {
    try {
      const tree: unknown = temml.__renderToMathMLTree(tex, {
        displayMode: display,
        annotate: true,
        throwOnError: true,
        trust: false,
        strict: false,
        maxExpand: 500,
        maxSize: [50, 400],
        // A fresh macro table: `\gdef` in one reply never leaks into another.
        macros: {},
      });
      result = { ok: true, element: convert(tree, 0) };
    } catch (error) {
      result = {
        ok: false,
        reason:
          (error instanceof Error ? error.message.split("\n", 1)[0] : undefined) ??
          "invalid formula",
      };
    }
  }
  const oldest = cache.keys().next();
  if (cache.size >= CACHE_LIMIT && !oldest.done) cache.delete(oldest.value);
  cache.set(key, result);
  return result;
}

export interface MathProps {
  tex: string;
  /** Display style (`$$`, `\\[`) rather than inline style. */
  display: boolean;
  /** A block of its own (a `$$` fence): otherwise it sits inside a paragraph. */
  block?: boolean;
  /** Still streaming: show the source until the formula is complete. */
  pending?: boolean;
}

/**
 * The inert fallback: the formula's source, exactly as written. Phrasing
 * content unless it is a block, so it is valid inside a paragraph.
 */
export function MathSource({
  tex,
  display,
  block = false,
  reason,
}: MathProps & { reason?: string | undefined }) {
  const title = reason ? `Couldn’t render this formula: ${reason}` : undefined;
  if (block)
    return (
      <pre className="math-source" data-testid="math-source" title={title}>
        <code>{tex}</code>
      </pre>
    );
  return (
    <code
      className={display ? "math-source math-source-display" : "math-source"}
      data-testid="math-source"
      title={title}
    >
      {tex}
    </code>
  );
}

export function MathView({ tex, display, block = false, pending = false }: MathProps) {
  // Hoisted into <head> once by React, in server HTML and on the client alike.
  const stylesheet = mathCss ? <link rel="stylesheet" href={mathCss} precedence="default" /> : null;
  const result = pending ? null : renderMath(tex, display);
  if (!result?.ok)
    return (
      <>
        {stylesheet}
        <MathSource
          tex={tex}
          display={display}
          block={block}
          reason={pending ? undefined : result?.reason}
        />
      </>
    );
  if (!display)
    return (
      <span className="math math-inline" data-tex={tex} data-testid="math">
        {stylesheet}
        {result.element}
      </span>
    );
  // Display math: wide equations scroll, and keyboard users can focus the
  // region to scroll it. Spans (styled as blocks) inside a paragraph.
  const Box = block ? "div" : "span";
  return (
    <Box className="math math-block" data-tex={tex} data-display="" data-testid="math">
      {stylesheet}
      <Box className="math-scroll" tabIndex={0} role="group" aria-label="Equation">
        {result.element}
      </Box>
      <Box className="math-actions">
        <CopyButton text={tex} label="Copy LaTeX" size={14} />
      </Box>
    </Box>
  );
}

export default MathView;
