import { FileText, FileX, Music } from "lucide-react";
import type { MessageAttachmentDto } from "@shared/attachments";
import { attachmentContentUrl } from "@shared/attachment-media";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A user message's attachments (Phase 12): square image thumbnails in a row
 * above the bubble (a click opens the viewer), accessible chips for audio and
 * text files, a placeholder for a missing one. Bytes are demand-loaded: images
 * use native lazy loading, audio `preload="none"`, text only on download.
 */
export function MessageAttachments({
  items,
  onOpenImage,
}: {
  items: readonly MessageAttachmentDto[];
  onOpenImage?:
    | ((items: readonly MessageAttachmentDto[], index: number, trigger: HTMLElement) => void)
    | undefined;
}) {
  const images = items.filter((a) => !a.missing && a.kind === "image");
  const others = items.filter((a) => a.missing || a.kind !== "image");
  return (
    <div className="message-attachments" data-testid="message-attachments">
      {images.length > 0 ? (
        <ul className="attachment-thumbs" aria-label="Images">
          {images.map((image, index) => (
            <li key={image.id}>
              <button
                type="button"
                className="attachment-thumb"
                aria-label={`View image ${image.filename ?? ""}`}
                onClick={(event) => onOpenImage?.(images, index, event.currentTarget)}
              >
                <img
                  src={attachmentContentUrl(image.id)}
                  alt={image.filename ?? "Image"}
                  loading="lazy"
                  decoding="async"
                  width={image.width ?? undefined}
                  height={image.height ?? undefined}
                  data-testid="attachment-thumbnail"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <ul className="attachment-files" aria-label="Files">
          {others.map((item) => (
            <li key={item.id}>
              <AttachmentFile item={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AttachmentFile({ item }: { item: MessageAttachmentDto }) {
  if (item.missing)
    return (
      <span className="attachment-file missing" data-testid="attachment-missing">
        <FileX size={18} aria-hidden />
        <span className="attachment-name">Attachment unavailable</span>
      </span>
    );
  const meta = `${item.kind === "audio" ? "Audio" : "File"} · ${formatBytes(item.size ?? 0)}`;
  if (item.kind === "audio")
    return (
      <span className="attachment-file audio" data-testid="attachment-audio">
        <span className="attachment-row">
          <Music size={18} aria-hidden />
          <span className="attachment-label">
            <span className="attachment-name">{item.filename}</span>
            <span className="attachment-meta">{meta}</span>
          </span>
        </span>
        <audio
          controls
          preload="none"
          src={attachmentContentUrl(item.id)}
          aria-label={`Play ${item.filename ?? "audio"}`}
        />
      </span>
    );
  return (
    <a
      className="attachment-file"
      href={attachmentContentUrl(item.id, true)}
      download={item.filename ?? true}
      data-testid="attachment-file"
      aria-label={`Download ${item.filename ?? "file"} (${formatBytes(item.size ?? 0)})`}
    >
      <span className="attachment-row">
        <FileText size={18} aria-hidden />
        <span className="attachment-label">
          <span className="attachment-name">{item.filename}</span>
          <span className="attachment-meta">{meta}</span>
        </span>
      </span>
    </a>
  );
}
