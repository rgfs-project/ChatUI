import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Copies text, then shows a check for a moment. */
export function CopyButton({
  text,
  label,
  size = 18,
  className = "icon-btn",
}: {
  text: string;
  label: string;
  size?: 14 | 16 | 18 | 20;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? <Check size={size} aria-hidden /> : <Copy size={size} aria-hidden />}
    </button>
  );
}
