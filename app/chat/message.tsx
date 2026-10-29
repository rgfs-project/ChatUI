import { Check, Copy } from "lucide-react";
import { memo, useState } from "react";
import type { MessageDto } from "@shared/conversations";
import type { GenerationState } from "@shared/generations";
import { useRenderProbe } from "../lib/render-probe";
import { IconButton } from "../ui/icon-button";
import { copyText } from "./copy";
import { Markdown } from "./markdown";

export const STATUS_LABEL: Record<NonNullable<MessageDto["status"]>, string> = {
  complete: "",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

export const LIVE_LABEL: Record<GenerationState, string> = {
  pending: "Waiting for the model…",
  streaming: "Generating…",
  completed: "",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : label}
      className="msg-action"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1_500);
        });
      }}
    >
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
    </IconButton>
  );
}

export function Reasoning({ text }: { text: string }) {
  return (
    <details className="reasoning" data-testid="reasoning">
      <summary>Reasoning</summary>
      <div className="reasoning-body selectable">{text}</div>
    </details>
  );
}

export function UserBubble({ content, pending }: { content: string; pending?: boolean }) {
  return (
    <div className={`msg msg-user${pending ? " is-pending" : ""}`} data-testid="message-user">
      <div className="bubble selectable">{content}</div>
      <div className="msg-actions">
        {pending ? (
          <span className="msg-note">Sending…</span>
        ) : (
          <CopyButton text={content} label="Copy message" />
        )}
      </div>
    </div>
  );
}

/** A stored message. Memoized: streaming another message never re-renders it. */
export const Message = memo(function Message({ message }: { message: MessageDto }) {
  useRenderProbe(`Message:${message.id}`);
  if (message.role === "user") return <UserBubble content={message.content} />;
  if (message.role === "system") {
    return (
      <details className="msg msg-system" data-testid="message-system">
        <summary>System instructions</summary>
        <div className="selectable">{message.content}</div>
      </details>
    );
  }
  const status = message.status ? STATUS_LABEL[message.status] : "";
  return (
    <div className="msg msg-assistant" data-testid="message-assistant" data-message-id={message.id}>
      {message.reasoning ? <Reasoning text={message.reasoning} /> : null}
      {message.content ? <Markdown>{message.content}</Markdown> : null}
      {status ? (
        <p className={`msg-status status-${message.status ?? ""}`} data-testid="message-status">
          {status}
          {message.status === "failed" && !message.content
            ? " — the model did not return an answer."
            : ""}
        </p>
      ) : null}
      {message.content ? (
        <div className="msg-actions">
          <CopyButton text={message.content} label="Copy reply" />
        </div>
      ) : null}
    </div>
  );
});
