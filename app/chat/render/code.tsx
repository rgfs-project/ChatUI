import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { copyText } from "../copy";
import { lazyModule, useLazy } from "./lazy";

/** highlight.js with its common languages, loaded only when a code block appears. */
export const highlighterModule = lazyModule(() =>
  import("highlight.js/lib/common").then((m) => m.default),
);

type Highlighter = Awaited<ReturnType<typeof highlighterModule.load>>;

/**
 * highlight.js escapes the source and only adds <span class="hljs-…">, so the
 * result is inert markup (INV-45). Unknown languages stay plain text.
 */
export function highlight(
  hljs: Highlighter,
  source: string,
  language: string | null,
): string | null {
  if (!language || !hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

export function CodeBlock({ language, source }: { language: string | null; source: string }) {
  const [copied, setCopied] = useState(false);
  const hljs = useLazy(highlighterModule, language !== null);
  const html = useMemo(
    () => (hljs ? highlight(hljs, source, language) : null),
    [hljs, source, language],
  );
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
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{source}</code>}
      </pre>
    </div>
  );
}
