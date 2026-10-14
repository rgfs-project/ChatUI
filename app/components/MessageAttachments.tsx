import { FileText, FileX, Music } from "lucide-react";
import type { MessageAttachmentDto } from "@shared/attachments";
import { attachmentContentUrl } from "@shared/attachment-media";
import { formatBytes } from "../lib/format";

type OpenImage = (
  items: readonly MessageAttachmentDto[],
  index: number,
  trigger: HTMLElement,
) => void;

/**
 * A sent message's files: square thumbnails above the bubble (a click opens
 * the viewer), cards for audio and text files, a placeholder for a missing
 * one. Bytes load on demand: lazy images, `preload="none"` audio, text only
 * when downloaded.
 */
export function MessageAttachments({
  items,
  onOpenImage,
}: {
  items: readonly MessageAttachmentDto[];
  onOpenImage?: OpenImage | undefined;
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
              <FileCard item={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FileCard({ item }: { item: MessageAttachmentDto }) {
  if (item.missing)
    return (
      <span className="file-card missing" data-testid="attachment-missing">
        <span className="file-icon">
          <FileX size={18} aria-hidden />
        </span>
        <span className="file-text">
          <span className="file-name">Attachment unavailable</span>
        </span>
      </span>
    );
  const meta = `${item.kind === "audio" ? "Audio" : "File"} · ${formatBytes(item.size ?? 0)}`;
  if (item.kind === "audio")
    return (
      <span className="file-card audio" data-testid="attachment-audio">
        <span className="file-head">
          <span className="file-icon">
            <Music size={18} aria-hidden />
          </span>
          <span className="file-text">
            <span className="file-name">{item.filename}</span>
            <span className="file-meta">{meta}</span>
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
      className="file-card"
      href={attachmentContentUrl(item.id, true)}
      download={item.filename ?? true}
      data-testid="attachment-file"
      aria-label={`Download ${item.filename ?? "file"} (${formatBytes(item.size ?? 0)})`}
    >
      <span className="file-icon">
        <FileText size={18} aria-hidden />
      </span>
      <span className="file-text">
        <span className="file-name">{item.filename}</span>
        <span className="file-meta">{meta}</span>
      </span>
    </a>
  );
}
