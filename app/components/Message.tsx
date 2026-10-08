import {
  Brain,
  ChevronRight,
  Download,
  FileCode,
  FileText,
  Music,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { attachmentContentUrl, type MessageAttachmentDto } from "@shared/attachments";
import type { MessageArtifactDto } from "@shared/artifacts";
import { formatBytes } from "../lib/format";
import { modelLabel } from "../lib/models";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { IconButton } from "./ui";

export function Attachments(props: { attachments: readonly MessageAttachmentDto[] }) {
  const [viewing, setViewing] = useState<MessageAttachmentDto | null>(null);
  if (props.attachments.length === 0) return null;
  return (
    <>
      <ImageViewer
        image={viewing}
        onClose={() => {
          setViewing(null);
        }}
      />
      <ul className="message-attachments" aria-label="Attachments">
        {props.attachments.map((a) => {
          if (a.missing)
            return (
              <li key={a.id} className="file-chip missing">
                <FileText size={18} aria-hidden />
                <span>File no longer available</span>
              </li>
            );
          if (a.kind === "image")
            return (
              <li key={a.id} className="image-attachment">
                <a
                  href={attachmentContentUrl(a.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    // A plain click opens the viewer; modified clicks keep the new tab.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    setViewing(a);
                  }}
                >
                  <img
                    src={attachmentContentUrl(a.id)}
                    alt={a.filename ?? "Image"}
                    width={a.width ?? undefined}
                    height={a.height ?? undefined}
                    loading="lazy"
                  />
                </a>
              </li>
            );
          return (
            <li key={a.id}>
              <a className="file-chip" href={attachmentContentUrl(a.id, true)} download>
                {a.kind === "audio" ? (
                  <Music size={18} aria-hidden />
                ) : (
                  <FileText size={18} aria-hidden />
                )}
                <span className="file-chip-text">
                  <span className="file-chip-name">{a.filename}</span>
                  {a.size !== null ? (
                    <span className="file-chip-meta">{formatBytes(a.size)}</span>
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** A full-size image over the page: Escape, the backdrop or × closes it. */
function ImageViewer(props: { image: MessageAttachmentDto | null; onClose: () => void }) {
  const image = props.image;
  return (
    <RadixDialog.Root
      open={image !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content
          className="image-viewer"
          aria-describedby={undefined}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <RadixDialog.Title className="sr-only">{image?.filename ?? "Image"}</RadixDialog.Title>
          <div className="image-viewer-bar">
            {image ? (
              <a
                className="icon-button"
                href={attachmentContentUrl(image.id, true)}
                download
                aria-label="Download"
                title="Download"
              >
                <Download size={20} aria-hidden />
              </a>
            ) : null}
            <RadixDialog.Close className="icon-button" aria-label="Close" title="Close">
              <X size={20} aria-hidden />
            </RadixDialog.Close>
          </div>
          {image ? (
            <img
              src={attachmentContentUrl(image.id)}
              alt={image.filename ?? "Image"}
              onClick={props.onClose}
            />
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function UserMessage(props: {
  content: string;
  attachments: readonly MessageAttachmentDto[];
  pending?: boolean;
  onEdit?: (content: string) => Promise<void>;
  onDelete?: () => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.content);
  const [busy, setBusy] = useState(false);
  if (editing && props.onEdit) {
    const onEdit = props.onEdit;
    return (
      <div className="user-turn" data-testid="message-user">
        <form
          className="edit-box"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void onEdit(draft).then(
              () => {
                setEditing(false);
                setBusy(false);
              },
              () => {
                setBusy(false);
              },
            );
          }}
        >
          <label className="sr-only" htmlFor="edit-message">
            Edit message
          </label>
          <textarea
            id="edit-message"
            value={draft}
            autoFocus
            rows={Math.min(10, draft.split("\n").length + 1)}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <div className="edit-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy || draft.trim() === ""}>
              Send
            </button>
          </div>
        </form>
      </div>
    );
  }
  return (
    <div className={`user-turn${props.pending ? " pending" : ""}`} data-testid="message-user">
      <Attachments attachments={props.attachments} />
      {props.content ? <div className="bubble">{props.content}</div> : null}
      {props.pending ? null : (
        <div className="message-actions">
          <CopyButton text={props.content} />
          {props.onEdit ? (
            <IconButton
              label="Edit message"
              className="muted-icon"
              disabled={props.disabled}
              onClick={() => {
                setDraft(props.content);
                setEditing(true);
              }}
            >
              <Pencil size={16} aria-hidden />
            </IconButton>
          ) : null}
          {props.onDelete ? (
            <IconButton
              label="Delete this exchange"
              className="muted-icon"
              disabled={props.disabled}
              onClick={props.onDelete}
            >
              <Trash2 size={16} aria-hidden />
            </IconButton>
          ) : null}
        </div>
      )}
    </div>
  );
}

const STATUS_NOTE: Record<string, string> = {
  cancelled: "Stopped",
  failed: "The reply failed",
  timed_out: "The reply timed out",
  interrupted: "The reply was interrupted",
};

export function AssistantMessage(props: {
  content: string;
  reasoning: string | null;
  /** complete | cancelled | failed | timed_out | interrupted, or live states. */
  status: string | null;
  streaming?: boolean;
  errorMessage?: string | null;
  model?: string | null;
  artifacts?: readonly MessageArtifactDto[];
  onOpenArtifact?: (artifact: MessageArtifactDto) => void;
  onRegenerate?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const note = props.status ? STATUS_NOTE[props.status] : undefined;
  // Dots until the answer starts, even while reasoning streams (it may be hidden).
  const thinking = props.streaming && !props.content;
  return (
    <div className="assistant-turn" data-testid="message-assistant">
      {props.reasoning ? (
        <details className="reasoning" open={props.streaming && !props.content}>
          <summary>
            <Brain size={16} aria-hidden />
            {props.streaming && !props.content ? "Thinking…" : "Thought process"}
            <ChevronRight size={16} aria-hidden className="chevron" />
          </summary>
          <div className="reasoning-body">{props.reasoning}</div>
        </details>
      ) : null}
      {thinking ? (
        <p className="thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </p>
      ) : null}
      <div className="prose" data-testid="content">
        <Markdown text={props.content} />
      </div>
      {note || props.errorMessage ? (
        <p className={`reply-note${props.status === "cancelled" ? "" : " error"}`}>
          {note}
          {note && props.errorMessage ? ": " : ""}
          {props.errorMessage}
        </p>
      ) : null}
      {props.artifacts && props.artifacts.length > 0 ? (
        <ul className="artifact-list" aria-label="Files from this reply">
          {props.artifacts.map((a) => (
            <li key={a.id}>
              <button type="button" className="file-chip" onClick={() => props.onOpenArtifact?.(a)}>
                <FileCode size={18} aria-hidden />
                <span className="file-chip-text">
                  <span className="file-chip-name">{a.name}</span>
                  <span className="file-chip-meta">
                    {[a.language, formatBytes(a.size)].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {props.children}
      {props.streaming ? null : (
        <div className="message-actions start">
          <CopyButton text={props.content} />
          {props.onRegenerate ? (
            <IconButton
              label="Regenerate"
              className="muted-icon"
              disabled={props.disabled}
              onClick={props.onRegenerate}
            >
              <RefreshCw size={16} aria-hidden />
            </IconButton>
          ) : null}
          {props.model ? <span className="message-model">{modelLabel(props.model)}</span> : null}
        </div>
      )}
    </div>
  );
}
