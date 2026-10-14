import {
  ChevronRight,
  Ellipsis,
  FileCode,
  Pencil,
  RefreshCw,
  Square,
  Split,
  Trash2,
  Volume2,
} from "lucide-react";
import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from "react";
import type { MessageAttachmentDto } from "@shared/attachments";
import type { MessageArtifactDto } from "@shared/artifacts";
import type { MessageDto } from "@shared/conversations";
import type { ProposalDto } from "@shared/memories";
import { formatBytes } from "../lib/format";
import { menuRequest, type MenuRequest } from "../lib/menu-request";
import { count } from "../lib/render-counters";
import { toggleSpeaking, useSpeaking, useSpeechSupported } from "../lib/speech";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { MessageAttachments } from "./MessageAttachments";

export { CopyButton };

/** Memory suggestion cards: loaded only for replies that have some. */
const MemorySuggestions = lazy(() => import("./MemorySuggestions"));
const ReplyMenu = lazy(() => import("./Menus").then((m) => ({ default: m.ReplyMenu })));

const STATUS_LABEL: Record<NonNullable<MessageDto["status"]>, string> = {
  complete: "",
  cancelled: "Stopped",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

/** The model's reasoning: folded by default, quieter than the answer. */
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
        <ChevronRight size={16} aria-hidden />
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

/**
 * What can be done to a message; the conversation decides what each means.
 * On a reply, "edit" and "delete" act on the prompt it answers.
 */
export type MessageAction = "edit" | "delete" | "regenerate" | "branch";

export interface MessageViewProps {
  role: MessageDto["role"];
  content: string;
  reasoning: string | null;
  status: MessageDto["status"];
  testId?: string;
  /** The stored id: the anchor search results scroll to (`#m-<id>`). */
  messageId?: string;
  attachments?: readonly MessageAttachmentDto[];
  onOpenImage?: (
    items: readonly MessageAttachmentDto[],
    index: number,
    trigger: HTMLElement,
  ) => void;
  /** Offered operations; a stable callback keeps the memo effective. */
  actions?: readonly MessageAction[];
  /** Unavailable for now (a reply is running). */
  actionsDisabled?: boolean;
  onAction?: (action: MessageAction, messageId: string, trigger: HTMLElement) => void;
  /** Rendered in place of the bubble while editing. */
  editor?: ReactNode;
  suggestions?: readonly ProposalDto[] | undefined;
  userId?: string;
  conversationId?: string;
  artifacts?: readonly MessageArtifactDto[] | undefined;
  onOpenArtifact?: (artifact: MessageArtifactDto, trigger: HTMLElement) => void;
}

/** Files a reply produced: each opens the source panel. */
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
            className="file-card"
            data-testid="artifact-card"
            onClick={(event) => {
              onOpen(artifact, event.currentTarget);
            }}
          >
            <span className="file-icon">
              <FileCode size={18} aria-hidden />
            </span>
            <span className="file-text">
              <span className="file-name">{artifact.name}</span>
              <span className="file-meta">
                {artifact.language ?? "file"} · {formatBytes(artifact.size)}
              </span>
            </span>
            <span className="visually-hidden">, view source</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const USER_LABEL: Record<MessageAction, string> = {
  edit: "Edit message",
  delete: "Delete message and reply",
  regenerate: "Get a reply",
  branch: "Branch in new chat",
};

/** A user message's buttons: copy, then edit / get a reply / delete. */
function UserActions(props: {
  messageId: string | undefined;
  content: string;
  actions: readonly MessageAction[];
  disabled: boolean;
  onAction: MessageViewProps["onAction"];
}) {
  return (
    <div className="turn-actions">
      {props.content ? <CopyButton text={props.content} label="Copy message" /> : null}
      {props.messageId && props.onAction
        ? props.actions.map((action) => (
            <button
              key={action}
              type="button"
              className="icon-btn"
              aria-label={USER_LABEL[action]}
              title={props.disabled ? "Stop the reply first" : USER_LABEL[action]}
              disabled={props.disabled}
              onClick={(event) => {
                if (props.messageId) props.onAction?.(action, props.messageId, event.currentTarget);
              }}
            >
              {action === "edit" ? (
                <Pencil size={18} aria-hidden />
              ) : action === "delete" ? (
                <Trash2 size={18} aria-hidden />
              ) : (
                <RefreshCw size={18} aria-hidden />
              )}
            </button>
          ))
        : null}
    </div>
  );
}

function ReadAloud({ id, text }: { id: string; text: string }) {
  const speaking = useSpeaking(id);
  const supported = useSpeechSupported();
  if (!supported) return null;
  const label = speaking ? "Stop reading" : "Read aloud";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      aria-pressed={speaking}
      title={label}
      onClick={() => {
        toggleSpeaking(id, text);
      }}
    >
      {speaking ? <Square size={16} aria-hidden /> : <Volume2 size={18} aria-hidden />}
    </button>
  );
}

/** A reply's buttons: copy, read aloud, regenerate, and "…" for the rest. */
function ReplyActions(props: {
  messageId: string | undefined;
  content: string;
  actions: readonly MessageAction[];
  disabled: boolean;
  onAction: MessageViewProps["onAction"];
}) {
  const [menu, setMenu] = useState<MenuRequest>(false);
  const { messageId, onAction } = props;
  const can = (action: MessageAction) =>
    messageId !== undefined && onAction !== undefined && props.actions.includes(action);
  const more = (["branch", "edit", "delete"] as const).filter(can);
  const fire = (action: MessageAction, trigger: HTMLElement) => {
    if (messageId) onAction?.(action, messageId, trigger);
  };
  return (
    <div className="turn-actions">
      {props.content ? <CopyButton text={props.content} label="Copy reply" /> : null}
      {props.content && messageId ? <ReadAloud id={messageId} text={props.content} /> : null}
      {can("regenerate") ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Regenerate reply"
          title={props.disabled ? "Stop the reply first" : "Regenerate reply"}
          disabled={props.disabled}
          onClick={(event) => {
            fire("regenerate", event.currentTarget);
          }}
        >
          <RefreshCw size={18} aria-hidden />
        </button>
      ) : null}
      {more.length > 0 ? (
        menu === false ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="More actions"
            title="More actions"
            disabled={props.disabled}
            onClick={(event) => {
              setMenu(menuRequest(event));
            }}
          >
            <Ellipsis size={18} aria-hidden />
          </button>
        ) : (
          <Suspense
            fallback={
              <button type="button" className="icon-btn" aria-label="More actions" disabled>
                <Ellipsis size={18} aria-hidden />
              </button>
            }
          >
            <ReplyMenu
              defaultOpen={menu}
              items={[
                ...(more.includes("branch")
                  ? [
                      {
                        label: "Branch in new chat",
                        icon: <Split size={20} aria-hidden />,
                        disabled: props.disabled,
                        onSelect: () => {
                          fire("branch", document.activeElement as HTMLElement);
                        },
                      },
                    ]
                  : []),
                ...(more.includes("edit")
                  ? [
                      {
                        label: "Edit prompt",
                        icon: <Pencil size={20} aria-hidden />,
                        disabled: props.disabled,
                        onSelect: () => {
                          fire("edit", document.activeElement as HTMLElement);
                        },
                      },
                    ]
                  : []),
                ...(more.includes("delete")
                  ? [
                      {
                        label: "Delete",
                        icon: <Trash2 size={20} aria-hidden />,
                        danger: true,
                        disabled: props.disabled,
                        onSelect: () => {
                          fire("delete", document.activeElement as HTMLElement);
                        },
                      },
                    ]
                  : []),
              ]}
            />
          </Suspense>
        )
      ) : null}
    </div>
  );
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
  const anchor = messageId ? `m-${messageId}` : undefined;
  if (role === "user")
    return (
      <li id={anchor} className="turn turn-user" data-testid={testId ?? "message-user"}>
        <span className="visually-hidden">You</span>
        {attachments?.length ? (
          <MessageAttachments items={attachments} onOpenImage={onOpenImage} />
        ) : null}
        {editor ??
          (content ? (
            <div className="bubble">
              <p className="plain-text" dir="auto">
                {content}
              </p>
            </div>
          ) : null)}
        {editor ? null : (
          <UserActions
            messageId={messageId}
            content={content}
            actions={actions}
            disabled={actionsDisabled}
            onAction={onAction}
          />
        )}
      </li>
    );
  const statusLabel = status ? STATUS_LABEL[status] : "";
  return (
    <li id={anchor} className={`turn turn-${role}`} data-testid={testId ?? `message-${role}`}>
      <span className="visually-hidden">{role === "assistant" ? "Assistant" : "System"}</span>
      {statusLabel ? (
        <span className={`badge${status === "cancelled" ? "" : " danger"}`}>{statusLabel}</span>
      ) : null}
      {reasoning ? <Reasoning text={reasoning} done /> : null}
      {role === "assistant" ? <Markdown text={content} /> : <p className="plain-text">{content}</p>}
      {role === "assistant" && artifacts?.length && onOpenArtifact ? (
        <ArtifactCards artifacts={artifacts} onOpen={onOpenArtifact} />
      ) : null}
      {role === "assistant" && (content || actions.length > 0) ? (
        <ReplyActions
          messageId={messageId}
          content={content}
          actions={actions}
          disabled={actionsDisabled}
          onAction={onAction}
        />
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

/** Memoized: other messages never re-render while one streams. */
export const Message = memo(MessageImpl);
