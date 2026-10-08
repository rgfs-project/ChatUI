import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "./ui";

/** Copies text; the icon confirms for a moment. */
export function CopyButton(props: {
  text: string | (() => string);
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      clearTimeout(t);
    };
  }, [copied]);
  return (
    <IconButton
      label={copied ? "Copied" : (props.label ?? "Copy")}
      className={props.className ?? "muted-icon"}
      onClick={() => {
        const text = typeof props.text === "function" ? props.text() : props.text;
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
        });
      }}
    >
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
    </IconButton>
  );
}
