import { Check, ChevronRight, Copy, FileCode, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from "react";
import type { MessageAttachmentDto } from "@shared/attachments";
import type { MessageDto } from "@shared/conversations";
import type { ProposalDto } from "@shared/memories";
import type { MessageArtifactDto } from "@shared/artifacts";
import { MessageAttachments } from "./MessageAttachments";
import { count } from "../lib/render-counters";
import { formatBytes } from "../lib/format";
import { Markdown } from "./Markdown";

/** Memory suggestion cards (Phase 13b): loaded only for replies that have some. */
const MemorySuggestions = lazy(() => import("./MemorySuggestions"));

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

/** A per-message operation (Phase 13a); ConversationView decides what it means. */
export type MessageAction = "edit" | "delete" | "regenerate";

export interface MessageViewProps {
  role: MessageDto["role"];
  content: string;
  reasoning: string | null;
  status: MessageDto["status"];
  testId?: string;
  /** The stored message id: an anchor for search navigation (`#m-<id>`). */
  messageId?: string;
  /** User messages: their attachments (Phase 12). */
  attachments?: readonly MessageAttachmentDto[];
  onOpenImage?: (
    items: readonly MessageAttachmentDto[],
    index: number,
    trigger: HTMLElement,
  ) => void;
  /** Operations offered on this message; a stable callback keeps the memo effective. */
  actions?: readonly MessageAction[];
  /** Operations are temporarily unavailable (a reply is running). */
  actionsDisabled?: boolean;
  onAction?: (action: MessageAction, messageId: string, trigger: HTMLElement) => void;
  /** Rendered instead of the bubble while this message is being edited. */
  editor?: ReactNode;
  /** Assistant only: memory suggestions made with this reply (Phase 13b). */
  suggestions?: readonly ProposalDto[] | undefined;
  /** Owner and conversation of the suggestions (primitives keep the memo effective). */
  userId?: string;
  conversationId?: string;
  /** Assistant only: source files captured from this reply (Phase 13c). */
  artifacts?: readonly MessageArtifactDto[] | undefined;
  onOpenArtifact?: (artifact: MessageArtifactDto, trigger: HTMLElement) => void;
}

/** A captured file under its reply: opens the lazy source panel. */
function ArtifactCards({
  artifacts,
  onOpen,
}: {
  artifacts: readonly MessageArtifactDto[];
  onOpen: NonNullable<MessageViewProps["onOpenArtifact"]>;
}) {
  return (
    <ul className="artifact-cards" aria-label="Files from this reply">
      {artifacts.map((artifact) => (
        <li key={artifact.id}>
          <button
            type="button"
            className="artifact-card"
            data-testid="artifact-card"
            onClick={(event) => {
              onOpen(artifact, event.currentTarget);
            }}
          >
            <FileCode size={18} aria-hidden />
            <span className="artifact-card-name">{artifact.name}</span>
            <span className="artifact-card-meta">
              {artifact.language ?? "file"} · {formatBytes(artifact.size)}
            </span>
            <span className="visually-hidden">, view source</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const ACTION_LABEL: Record<MessageAction, string> = {
  edit: "Edit message",
  delete: "Delete message and reply",
  regenerate: "Regenerate reply",
};

function ActionButtons({
  messageId,
  actions,
  disabled,
  onAction,
  regenerateLabel,
}: {
  messageId: string;
  actions: readonly MessageAction[];
  disabled: boolean;
  onAction: NonNullable<MessageViewProps["onAction"]>;
  regenerateLabel: string;
}) {
  return actions.map((action) => (
    <button
      key={action}
      type="button"
      className="icon-btn"
      aria-label={action === "regenerate" ? regenerateLabel : ACTION_LABEL[action]}
      title={
        disabled
          ? "Stop the reply first"
          : action === "regenerate"
            ? regenerateLabel
            : ACTION_LABEL[action]
      }
      disabled={disabled}
      onClick={(event) => {
        onAction(action, messageId, event.currentTarget);
      }}
    >
      {action === "edit" ? (
        <Pencil size={16} aria-hidden />
      ) : action === "delete" ? (
        <Trash2 size={16} aria-hidden />
      ) : (
        <RefreshCw size={16} aria-hidden />
      )}
    </button>
  ));
}

function MessageImpl({
  role,
  content,
  reasoning,
  status,
  testId,
  messageId,
  attachments,
  onOpenImage,
  actions = [],
  actionsDisabled = false,
  onAction,
  editor,
  suggestions,
  userId,
  conversationId,
  artifacts,
  onOpenArtifact,
}: MessageViewProps) {
  count("messageRenders");
  useEffect(() => {
    count("messageMounts");
  }, []);
  const label = role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";
  const statusLabel = status ? STATUS_LABEL[status] : "";
  const anchor = messageId ? `m-${messageId}` : undefined;
  const buttons =
    messageId && onAction && actions.length > 0 ? (
      <ActionButtons
        messageId={messageId}
        actions={actions}
        disabled={actionsDisabled}
        onAction={onAction}
        regenerateLabel={role === "user" ? "Get a reply" : ACTION_LABEL.regenerate}
      />
    ) : null;
  if (role === "user")
    return (
      <li id={anchor} className="turn turn-user" data-testid={testId ?? "message-user"}>
        <span className="visually-hidden">{label}</span>
        {attachments?.length ? (
          <MessageAttachments items={attachments} onOpenImage={onOpenImage} />
        ) : null}
        {editor ??
          (content ? (
            <div className="bubble">
              <p className="plain-text">{content}</p>
            </div>
          ) : null)}
        {editor ? null : (
          <div className="turn-actions">
            {content ? <CopyButton text={content} label="Copy message" /> : null}
            {buttons}
          </div>
        )}
      </li>
    );
  return (
    <li id={anchor} className={`turn turn-${role}`} data-testid={testId ?? `message-${role}`}>
      <span className="visually-hidden">{label}</span>
      {statusLabel ? <span className={`badge status-${status ?? ""}`}>{statusLabel}</span> : null}
      {reasoning ? <Reasoning text={reasoning} done /> : null}
      {role === "assistant" ? <Markdown text={content} /> : <p className="plain-text">{content}</p>}
      {role === "assistant" && artifacts?.length && onOpenArtifact ? (
        <ArtifactCards artifacts={artifacts} onOpen={onOpenArtifact} />
      ) : null}
      {role === "assistant" && (content || buttons) ? (
        <div className="turn-actions">
          {content ? <CopyButton text={content} label="Copy reply" /> : null}
          {buttons}
        </div>
      ) : null}
      {role === "assistant" && suggestions?.length && userId && conversationId ? (
        <Suspense fallback={null}>
          <MemorySuggestions
            userId={userId}
            conversationId={conversationId}
            proposals={suggestions}
            emptyAnswer={content === "" && status === "complete"}
            disabled={actionsDisabled}
            onRegenerate={
              messageId && onAction && actions.includes("regenerate")
                ? (trigger) => {
                    onAction("regenerate", messageId, trigger);
                  }
                : undefined
            }
          />
        </Suspense>
      ) : null}
    </li>
  );
}

/** Memoized: unrelated messages never re-render while another one streams. */
export const Message = memo(MessageImpl);
