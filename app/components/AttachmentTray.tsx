import { AlertCircle, FileText, Music, X } from "lucide-react";
import { attachmentContentUrl } from "@shared/attachment-media";
import type { DraftAttachment } from "../lib/attachments";
import { formatBytes } from "./MessageAttachments";
import "./attachments.css";

/**
 * The composer's attachments before sending (Phase 12, loaded on the first
 * attach): square image previews and file/audio chips with name, size,
 * upload progress, errors and a remove button.
 */
export function AttachmentTray({
  items,
  onRemove,
}: {
  items: readonly DraftAttachment[];
  onRemove: (localId: string) => void;
}) {
  return (
    <ul className="attachment-tray" aria-label="Attachments" data-testid="attachment-tray">
      {items.map((item) => {
        const preview =
          item.kind === "image"
            ? (item.previewUrl ?? (item.dto ? attachmentContentUrl(item.dto.id) : null))
            : null;
        const state =
          item.status === "uploading"
            ? `uploading, ${String(Math.round(item.progress * 100))}%`
            : item.status === "error"
              ? `not attached: ${item.error ?? "failed"}`
              : "attached";
        return (
          <li
            key={item.localId}
            className={`tray-item${preview ? " tray-image" : " tray-file"} ${item.status}`}
            data-testid="attachment-chip"
            data-status={item.status}
          >
            {preview ? (
              <img src={preview} alt="" className="tray-preview" />
            ) : (
              <span className="tray-icon" aria-hidden>
                {item.status === "error" ? (
                  <AlertCircle size={18} />
                ) : item.kind === "audio" ? (
                  <Music size={18} />
                ) : (
                  <FileText size={18} />
                )}
              </span>
            )}
            <span className={preview ? "visually-hidden" : "tray-label"}>
              <span className="tray-name">{item.name}</span>
              <span className="tray-meta">
                {item.status === "error" ? item.error : formatBytes(item.size)}
              </span>
            </span>
            <span className="visually-hidden" role="status">
              {item.name} {state}
            </span>
            {item.status === "uploading" ? (
              <span
                className="tray-progress"
                role="progressbar"
                aria-label={`Uploading ${item.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(item.progress * 100)}
              >
                <span style={{ transform: `scaleX(${String(item.progress)})` }} />
              </span>
            ) : null}
            {item.status === "error" && preview ? (
              <span className="tray-error" aria-hidden>
                <AlertCircle size={20} />
              </span>
            ) : null}
            <button
              type="button"
              className="tray-remove"
              aria-label={`Remove ${item.name}`}
              title="Remove"
              onClick={() => {
                onRemove(item.localId);
              }}
            >
              <span className="tray-x" aria-hidden>
                <X size={14} strokeWidth={2.5} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
