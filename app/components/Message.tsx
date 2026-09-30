import { Check, ChevronRight, Copy } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { MessageAttachmentDto } from "@shared/attachments";
import type { MessageDto } from "@shared/conversations";
import { MessageAttachments } from "./MessageAttachments";
import { count } from "../lib/render-counters";
import { Markdown } from "./Markdown";

const STATUS_LABEL: Record<NonNullable<MessageDto["status"]>, string> = {
  complete: "",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

/** Copies text to the clipboard, confirming briefly. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
    </button>
  );
}

/** Reasoning: collapsed by default, visually distinct from the answer. */
export function Reasoning({
  text,
  done,
  testId,
}: {
  text: string;
  done: boolean;
  testId?: string;
}) {
  return (
    <details className="reasoning" data-testid={testId}>
      <summary>
        {done ? "Thought process" : "Thinking…"}
        <ChevronRight size={16} className="chevron" aria-hidden />
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

export interface MessageViewProps {
  role: MessageDto["role"];
  content: string;
  reasoning: string | null;
  status: MessageDto["status"];
  testId?: string;
  /** User messages: their attachments (Phase 12). */
  attachments?: readonly MessageAttachmentDto[];
  onOpenImage?: (
    items: readonly MessageAttachmentDto[],
    index: number,
    trigger: HTMLElement,
  ) => void;
}

function MessageImpl({
  role,
  content,
  reasoning,
  status,
  testId,
  attachments,
  onOpenImage,
}: MessageViewProps) {
  count("messageRenders");
  useEffect(() => {
    count("messageMounts");
  }, []);
  const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";
  const statusLabel = status ? STATUS_LABEL[status] : "";
  if (role === "user")
    return (
      <li className="turn turn-user" data-testid={testId ?? "message-user"}>
        <span className="visually-hidden">{label}</span>
        {attachments?.length ? (
          <MessageAttachments items={attachments} onOpenImage={onOpenImage} />
        ) : null}
        {content ? (
          <div className="bubble">
            <p className="plain-text">{content}</p>
          </div>
        ) : null}
        {content ? (
          <div className="turn-actions">
            <CopyButton text={content} label="Copy message" />
          </div>
        ) : null}
      </li>
    );
  return (
    <li className={`turn turn-${role}`} data-testid={testId ?? `message-${role}`}>
      <span className="visually-hidden">{label}</span>
      {statusLabel ? <span className={`badge status-${status ?? ""}`}>{statusLabel}</span> : null}
      {reasoning ? <Reasoning text={reasoning} done /> : null}
      {role === "assistant" ? <Markdown text={content} /> : <p className="plain-text">{content}</p>}
      {role === "assistant" && content ? (
        <div className="turn-actions">
          <CopyButton text={content} label="Copy reply" />
        </div>
      ) : null}
    </li>
  );
}

/** Memoized: unrelated messages never re-render while another one streams. */
export const Message = memo(MessageImpl);
