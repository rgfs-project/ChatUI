import { Check, Copy, Pencil, RefreshCw, Square, Trash2, Volume2 } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { AttachmentRef } from "@shared/attachments";
import type { MessageDto } from "@shared/conversations";
import type { GenerationState } from "@shared/generations";
import { useRenderProbe } from "../lib/render-probe";
import { IconButton } from "../ui/icon-button";
import { copyText } from "./copy";
import { Markdown } from "./markdown";
import { MessageAttachments } from "./message-attachments";
import { useConversationOps } from "./conversation-ops";
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

/** Edit in place: the bubble becomes an editor with Cancel and Send (reference UI). */
function UserEditor({
  messageId,
  initial,
  onDone,
}: {
  messageId: string;
  initial: string;
  onDone: () => void;
}) {
  const ops = useConversationOps();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${String(Math.min(el.scrollHeight, 320))}px`;
  }, [value]);
  const changed = value.trim() !== "" && value.trim() !== initial.trim();
  const submit = async () => {
    if (!changed || busy) return;
    setBusy(true);
    const ok = await ops.editAndResend(messageId, value.trim());
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <form
      className="msg-editor"
      aria-label="Edit message"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        className="selectable"
        aria-label="Edited message"
        value={value}
        autoFocus
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="msg-editor-actions">
        <button type="button" className="pill-button pill-dark" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="pill-button pill-light" disabled={!changed || busy}>
          Send
        </button>
      </div>
    </form>
  );
}

function UserActions({ messageId, onEdit }: { messageId: string; onEdit: () => void }) {
  const ops = useConversationOps();
  return (
    <>
      <IconButton label="Edit message" className="msg-action needs-idle" onClick={onEdit}>
        <Pencil size={16} aria-hidden />
      </IconButton>
      <IconButton
        label="Delete message"
        className="msg-action needs-idle"
        onClick={() => {
          void ops.deleteExchange(messageId);
        }}
      >
        <Trash2 size={16} aria-hidden />
      </IconButton>
    </>
  );
}

function RegenerateButton({ turnUserId }: { turnUserId: string }) {
  const ops = useConversationOps();
  return (
    <IconButton
      label="Regenerate"
      className="msg-action needs-idle"
      onClick={() => {
        void ops.regenerate(turnUserId);
      }}
    >
      <RefreshCw size={16} aria-hidden />
    </IconButton>
  );
}

export function UserBubble({
  content,
  attachments = NO_ATTACHMENTS,
  pending,
  onCheck,
  messageId,
}: {
  content: string;
  /** Stored messages only: enables Edit and Delete. */
  messageId?: string;
  attachments?: readonly AttachmentRef[];
  /** An optimistic message: still sending, or its outcome is unknown. */
  pending?: "sending" | "unknown";
  onCheck?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && messageId) {
    return (
      <div
        className="msg msg-user is-editing"
        data-testid="message-user"
        data-message-id={messageId}
      >
        <UserEditor
          messageId={messageId}
          initial={content}
          onDone={() => {
            setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={`msg msg-user${pending ? ` is-pending is-${pending}` : ""}`}
      data-testid="message-user"
      data-message-id={messageId}
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
        {pending || !messageId ? null : (
          <UserActions
            messageId={messageId}
            onEdit={() => {
              setEditing(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A stored message. Memoized: streaming another message never re-renders it. */
export const Message = memo(function Message({
  message,
  turnUserId,
}: {
  message: MessageDto;
  /** Assistant replies: the user turn they answer (for Regenerate). */
  turnUserId?: string | undefined;
}) {
  useRenderProbe(`Message:${message.id}`);
  if (message.role === "user")
    return (
      <UserBubble
        content={message.content}
        attachments={message.attachments}
        messageId={message.id}
      />
    );
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
          {turnUserId ? <RegenerateButton turnUserId={turnUserId} /> : null}
        </div>
      ) : turnUserId ? (
        <div className="msg-actions">
          <RegenerateButton turnUserId={turnUserId} />
        </div>
      ) : null}
    </div>
  );
});
