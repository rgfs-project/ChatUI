import { AudioLines, FileQuestion, FileText } from "lucide-react";
import type { AttachmentRef } from "@shared/attachments";
import { useViewer } from "./viewer";

export const contentUrl = (id: string, download = false) =>
  `/api/attachments/${id}/content${download ? "?download=1" : ""}`;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Thumbnail box: the image's own aspect ratio within `box` (so no layout shift). */
function fit(width: number | null, height: number | null, box: number): [number, number] {
  if (!width || !height) return [box, box];
  const scale = Math.min(1, box / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/**
 * A user message's files: image thumbnails (lazy, sized from stored
 * dimensions, opening the viewer), audio players that load nothing until
 * played, and download chips for text. A missing file is a placeholder.
 */
export function MessageAttachments({ refs }: { refs: readonly AttachmentRef[] }) {
  const viewer = useViewer();
  if (refs.length === 0) return null;
  const images = refs.filter((r) => !r.missing && r.kind === "image");
  const box = images.length > 1 ? 160 : 240;
  return (
    <div className="msg-files" data-testid="message-attachments">
      {images.length > 0 ? (
        <div className="msg-images">
          {images.map((ref) => {
            if (ref.missing) return null;
            const [width, height] = fit(ref.width, ref.height, box);
            return (
              <button
                key={ref.id}
                type="button"
                className="msg-image"
                aria-label={`Open image ${ref.filename}`}
                onClick={() => {
                  viewer.open(ref.id);
                }}
              >
                <img
                  src={contentUrl(ref.id)}
                  alt={ref.filename}
                  width={width}
                  height={height}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              </button>
            );
          })}
        </div>
      ) : null}
      {refs.map((ref) => {
        if (ref.missing) {
          return (
            <span key={ref.id} className="file-chip is-missing" data-testid="attachment-missing">
              <FileQuestion size={18} aria-hidden />
              <span className="file-chip-name">File unavailable</span>
            </span>
          );
        }
        if (ref.kind === "image") return null;
        if (ref.kind === "audio") {
          return (
            <div key={ref.id} className="file-audio">
              <a className="file-chip" href={contentUrl(ref.id, true)} download={ref.filename}>
                <AudioLines size={18} aria-hidden />
                <span className="file-chip-name">{ref.filename}</span>
                <span className="file-chip-meta">{formatSize(ref.size)}</span>
              </a>
              <audio
                controls
                preload="none"
                src={contentUrl(ref.id)}
                aria-label={`Play ${ref.filename}`}
              />
            </div>
          );
        }
        return (
          <a
            key={ref.id}
            className="file-chip"
            href={contentUrl(ref.id, true)}
            download={ref.filename}
          >
            <FileText size={18} aria-hidden />
            <span className="file-chip-name">{ref.filename}</span>
            <span className="file-chip-meta">{formatSize(ref.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
