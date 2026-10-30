/**
 * Rich paste (Phase 15): clipboard HTML becomes plain Markdown text in the
 * composer. The HTML is parsed with DOMParser into an inert document (no
 * scripts run, nothing loads) and only text and a fixed set of structures
 * are read from it: headings, emphasis, links, lists, quotes, code and
 * tables. Nothing else from the page survives; the result is ordinary text
 * the user can still edit before sending.
 */

/** Bigger clipboard HTML is pasted as its plain text. */
export const RICH_PASTE_MAX_HTML = 1_000_000;

const SKIP = new Set([
  "script",
  "style",
  "head",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "button",
  "select",
  "textarea",
  "input",
]);
const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "figure",
  "figcaption",
  "dl",
  "dt",
  "dd",
  "address",
]);
/** Elements that make clipboard HTML worth converting rather than pasting as text. */
const MEANINGFUL = "h1,h2,h3,h4,h5,h6,strong,b,em,i,a[href],ul,ol,table,blockquote,pre,code,del,s";

const SAFE_URL = /^(https?:|mailto:)/i;

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1");
}

/** Inline code with a fence longer than any backtick run inside it. */
function inlineCode(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function styleOf(el: Element): string {
  return (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
}

function isBold(el: Element, tag: string): boolean {
  const style = styleOf(el);
  // Google Docs wraps whole documents in <b style="font-weight:normal">.
  if (/font-weight:(normal|400|300|lighter)/.test(style)) return false;
  return tag === "strong" || tag === "b" || /font-weight:(bold|[6-9]00)/.test(style);
}

function isItalic(el: Element, tag: string): boolean {
  const style = styleOf(el);
  if (style.includes("font-style:normal")) return false;
  return tag === "em" || tag === "i" || style.includes("font-style:italic");
}

/** Wraps inline text in a marker, keeping the spaces outside it. */
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || match[2] === "") return text;
  return `${match[1] ?? ""}${marker}${match[2]}${marker}${match[3] ?? ""}`;
}

function inline(node: Node): string {
  if (node.nodeType === 3) return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "img") return escapeText(el.getAttribute("alt") ?? "");
  if (tag === "code") return inlineCode(el.textContent);
  const inner = Array.from(el.childNodes).map(inline).join("");
  if (tag === "a") {
    const href = el.getAttribute("href")?.trim() ?? "";
    const label = inner.trim();
    if (!SAFE_URL.test(href) || label === "") return inner;
    const url = href.replace(/[()\s]/g, (c) =>
      c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c),
    );
    return `[${label}](${url})`;
  }
  let out = inner;
  if (tag === "del" || tag === "s" || tag === "strike") out = wrap(out, "~~");
  if (isItalic(el, tag)) out = wrap(out, "*");
  if (isBold(el, tag)) out = wrap(out, "**");
  return out;
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^ (?! )/, ""))
    .join("\n")
    .trim();
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === "TD" || c.tagName === "TH")
      .map((c) => tidy(inline(c)).replace(/\n+/g, " ").replace(/\|/g, "\\|")),
  );
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (width === 0) return "";
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join(
    "\n",
  );
}

function list(el: Element, ordered: boolean, depth: number): string {
  const items = Array.from(el.children).filter((c) => c.tagName === "LI");
  const start = Number(el.getAttribute("start") ?? "1");
  return items
    .map((li, index) => {
      const marker = ordered ? `${String((Number.isFinite(start) ? start : 1) + index)}.` : "-";
      const indent = " ".repeat(marker.length + 1);
      const body = blocks(li, depth + 1, "\n")
        .split("\n")
        .map((line, i) => (i === 0 ? line : line === "" ? "" : `${indent}${line}`))
        .join("\n");
      return `${marker} ${body}`;
    })
    .join("\n");
}

/** Block-level Markdown for an element's children, separated by blank lines (tight in list items). */
function blocks(parent: Element, depth = 0, separator = "\n\n"): string {
  const parts: string[] = [];
  let run = "";
  const flush = () => {
    const text = tidy(run);
    if (text !== "") parts.push(text);
    run = "";
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1) {
      run += inline(node);
      continue;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      flush();
      const text = tidy(inline(el)).replace(/\n+/g, " ");
      if (text !== "") parts.push(`${"#".repeat(Number(heading[1]))} ${text}`);
    } else if (tag === "ul" || tag === "ol") {
      flush();
      const text = list(el, tag === "ol", depth);
      if (text !== "") parts.push(text);
    } else if (tag === "pre") {
      flush();
      const code = el.textContent.replace(/\n$/, "");
      const runs = code.match(/`{3,}/g) ?? [];
      const fence = "`".repeat(Math.max(2, ...runs.map((r) => r.length)) + 1);
      parts.push(`${fence}\n${code}\n${fence}`);
    } else if (tag === "blockquote") {
      flush();
      const text = blocks(el, depth);
      if (text !== "")
        parts.push(
          text
            .split("\n")
            .map((line) => (line === "" ? ">" : `> ${line}`))
            .join("\n"),
        );
    } else if (tag === "table") {
      flush();
      const text = table(el);
      if (text !== "") parts.push(text);
    } else if (tag === "hr") {
      flush();
      parts.push("---");
    } else if (tag === "li") {
      flush();
      const text = blocks(el, depth);
      if (text !== "") parts.push(`- ${text}`);
    } else if (BLOCKS.has(tag) || tag === "body" || tag === "html") {
      flush();
      const text = blocks(el, depth);
      if (text !== "") parts.push(text);
    } else {
      run += inline(el);
    }
  }
  flush();
  return parts.join(separator);
}

/**
 * Markdown for clipboard HTML, or null when it should be pasted as plain text:
 * too large, unparsable, without any structure worth keeping, or copied from a
 * code editor (whitespace-preserving markup, where the plain text is exact).
 */
export function htmlToMarkdown(html: string): string | null {
  if (html.length === 0 || html.length > RICH_PASTE_MAX_HTML) return null;
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body.querySelector(MEANINGFUL)) return null;
  if (/white-space:\s*pre/i.test(html) && !doc.body.querySelector("pre")) return null;
  const markdown = blocks(doc.body);
  return markdown === "" ? null : markdown;
}
