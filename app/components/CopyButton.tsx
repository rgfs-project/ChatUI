import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Copies text to the clipboard, confirming briefly. */
export function CopyButton({
  text,
  label,
  size = 16,
}: {
  text: string;
  label: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
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
