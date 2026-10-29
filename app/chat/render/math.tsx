import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyText } from "../copy";
import { lazyModule, useLazy } from "./lazy";

export const katexModule = lazyModule(() => import("katex").then((m) => m.default));

/**
 * KaTeX with MathML output only: native browser math rendering with real
 * semantics, no fonts or stylesheet to load, no HTML from the model. `trust`
 * stays off, so \href, \url and friends never become links (INV-45).
 */
export function renderMath(
  katex: { renderToString: (tex: string, options: object) => string },
  tex: string,
  display: boolean,
): string | null {
  try {
    return katex.renderToString(tex, {
      output: "mathml",
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 500,
    });
  } catch {
    return null; // malformed math: the caller shows the inert source
  }
}

/** "$5 and $10" is money, not math: inline math starting with an amount stays text. */
export function looksLikeMoney(tex: string): boolean {
  return /^\s*\d[\d.,]*(\s|$)/.test(tex) && /\s/.test(tex.trim());
}

/**
 * Display-only normalisation: a whole line `\[ … \]` becomes a `$$` block and
 * `\( … \)` inline math, outside code fences. The stored text is unchanged.
 */
export function normalizeMath(source: string): string {
  let fence: string | null = null;
  return source
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (fence === null) fence = marker;
        else if (marker.startsWith(fence.charAt(0)) && marker.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const display = /^\s*\\\[(.+)\\\]\s*$/.exec(line);
      if (display) return `$$\n${display[1] ?? ""}\n$$`;
      return line.replace(/\\\((.+?)\\\)/g, (_m, tex: string) => `$${tex}$`);
    })
    .join("\n");
}

export function InlineMath({ tex }: { tex: string }) {
  const katex = useLazy(katexModule, true);
  if (looksLikeMoney(tex)) return <>{`$${tex}$`}</>;
  const html = katex ? renderMath(katex, tex, false) : null;
  if (!html) return <code className="math-source">{tex}</code>;
  return <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function DisplayMath({ tex }: { tex: string }) {
  const katex = useLazy(katexModule, true);
  const [copied, setCopied] = useState(false);
  const html = katex ? renderMath(katex, tex, true) : null;
  return (
    <div className="math-display">
      {html ? (
        <div className="math-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="math-source selectable">{tex}</pre>
      )}
      <button
        type="button"
        className="table-tool math-copy"
        aria-label={copied ? "Copied" : "Copy LaTeX"}
        onClick={() => {
          void copyText(tex).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1_500);
          });
        }}
      >
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>
    </div>
  );
}
