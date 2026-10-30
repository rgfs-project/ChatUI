import { AlertCircle, AudioLines, FileText, X } from "lucide-react";
import { composerFiles, type ComposerFile } from "./composer-files";
import { formatSize } from "./message-attachments";

/** Files in the composer before sending: preview, name, size or progress, error, remove. */
export function AttachmentChips({
  draft,
  files,
}: {
  draft: string;
  files: readonly ComposerFile[];
}) {
  if (files.length === 0) return null;
  return (
    <ul className="composer-files" aria-label="Attached files" data-testid="composer-files">
      {files.map((file) => (
        <li
          key={file.localId}
          className={`composer-file is-${file.status}`}
          data-testid="composer-file"
          data-status={file.status}
        >
          {file.previewUrl ? (
            <img
              className="composer-file-thumb"
              src={file.previewUrl}
              alt=""
              width={40}
              height={40}
            />
          ) : (
            <span className="composer-file-icon" aria-hidden>
              {file.kind === "audio" ? <AudioLines size={20} /> : <FileText size={20} />}
            </span>
          )}
          <span className="composer-file-text">
            <span className="composer-file-name">{file.name}</span>
            <span
              className="composer-file-meta"
              role={file.status === "error" ? "alert" : undefined}
            >
              {file.status === "error" ? (
                <>
                  <AlertCircle size={14} aria-hidden /> {file.error}
                </>
              ) : file.status === "uploading" ? (
                `Uploading ${String(Math.round(file.progress * 100))}%`
              ) : (
                formatSize(file.size)
              )}
            </span>
          </span>
          {file.status === "uploading" ? (
            <progress
              className="composer-file-progress"
              max={1}
              value={file.progress}
              aria-label={`Uploading ${file.name}`}
            />
          ) : null}
          <button
            type="button"
            className="composer-file-remove"
            aria-label={`Remove ${file.name}`}
            onClick={() => {
              composerFiles.remove(draft, file.localId);
            }}
          >
            <X size={14} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
