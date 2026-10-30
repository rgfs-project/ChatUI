import { FileCode2 } from "lucide-react";
import type { ArtifactRef } from "@shared/artifacts";
import { openArtifact } from "./artifact-events";
import { formatSize } from "./message-attachments";

/** Files captured from a reply (Phase 13c); each opens the inert source panel. */
export function ArtifactCards({ artifacts }: { artifacts: readonly ArtifactRef[] }) {
  if (artifacts.length === 0) return null;
  return (
    <ul className="artifact-cards" aria-label="Files from this reply">
      {artifacts.map((file) => (
        <li key={file.id}>
          <button
            type="button"
            className="artifact-card"
            data-testid="artifact-card"
            onClick={() => {
              openArtifact(file.id);
            }}
          >
            <FileCode2 size={20} aria-hidden />
            <span className="artifact-card-text">
              <span className="artifact-card-name">{file.filename}</span>
              <span className="artifact-card-meta">
                {file.filename.split(".").pop()?.toUpperCase()} · {formatSize(file.size)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
