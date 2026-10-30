import { Check, Copy, Square, Volume2 } from "lucide-react";
import { memo, useState } from "react";
import type { AttachmentRef } from "@shared/attachments";
import type { MessageDto } from "@shared/conversations";
import type { GenerationState } from "@shared/generations";
import { useRenderProbe } from "../lib/render-probe";
import { IconButton } from "../ui/icon-button";
import { copyText } from "./copy";
import { Markdown } from "./markdown";
import { MessageAttachments } from "./message-attachments";
import { speak, speakableText, stopSpeaking, useSpeaking, useSpeechSupported } from "./read-aloud";

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

function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const supported = useSpeechSupported();
  const speaking = useSpeaking(id);
  if (!supported) return null;
  return (
    <IconButton
      label={speaking ? "Stop reading" : "Read aloud"}
      className="msg-action"
      aria-pressed={speaking}
      onClick={() => {
        if (speaking) stopSpeaking();
        else speak(id, speakableText(text));
      }}
    >
      {speaking ? <Square size={14} aria-hidden /> : <Volume2 size={16} aria-hidden />}
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

const NO_ATTACHMENTS: readonly AttachmentRef[] = [];

export function UserBubble({
  content,
  attachments = NO_ATTACHMENTS,
  pending,
  onCheck,
}: {
  content: string;
  attachments?: readonly AttachmentRef[];
  /** An optimistic message: still sending, or its outcome is unknown. */
  pending?: "sending" | "unknown";
  onCheck?: () => void;
}) {
  return (
    <div
      className={`msg msg-user${pending ? ` is-pending is-${pending}` : ""}`}
      data-testid="message-user"
    >
      <MessageAttachments refs={attachments} />
      {content ? <div className="bubble selectable">{content}</div> : null}
      <div className="msg-actions">
        {pending === "sending" ? <span className="msg-note">Sending…</span> : null}
        {pending === "unknown" ? (
          <span className="msg-note" role="status">
            Not sure this was sent.{" "}
            <button type="button" className="link-button" onClick={onCheck}>
              Check the conversation
            </button>
          </span>
        ) : null}
        {pending || !content ? null : <CopyButton text={content} label="Copy message" />}
      </div>
    </div>
  );
}

/** A stored message. Memoized: streaming another message never re-renders it. */
export const Message = memo(function Message({ message }: { message: MessageDto }) {
  useRenderProbe(`Message:${message.id}`);
  if (message.role === "user")
    return <UserBubble content={message.content} attachments={message.attachments} />;
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
          <ReadAloudButton id={message.id} text={message.content} />
        </div>
      ) : null}
    </div>
  );
});
