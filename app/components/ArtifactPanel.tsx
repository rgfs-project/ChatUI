import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { apiFetch, ensureOk } from "../lib/api";
import { formatBytes } from "../lib/format";
import { CopyButton } from "./CopyButton";
import { CodeBlock } from "./Markdown";
import { CloseButton } from "./ui";

export interface OpenArtifact {
  id: string;
  name: string;
  language: string | null;
  size: number;
}

/** A file a reply produced, shown as source beside the chat. Never run. */
export function ArtifactPanel(props: {
  userId: string;
  artifact: OpenArtifact;
  onClose: () => void;
}) {
  const source = useQuery({
    queryKey: ["user", props.userId, "artifact-source", props.artifact.id],
    queryFn: async ({ signal }) => {
      const response = await apiFetch(
        `/api/artifacts/${encodeURIComponent(props.artifact.id)}/source`,
        { signal },
      );
      await ensureOk(response);
      return response.text();
    },
    staleTime: Infinity,
  });
  return (
    <aside className="artifact-panel" aria-label={`File: ${props.artifact.name}`}>
      <header className="panel-header">
        <div className="panel-title">
          <h2>{props.artifact.name}</h2>
          <p className="muted small">
            {[props.artifact.language, formatBytes(props.artifact.size)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <a
          className="icon-button muted-icon"
          href={`/api/artifacts/${encodeURIComponent(props.artifact.id)}/source?download=1`}
          aria-label="Download file"
          title="Download file"
        >
          <Download size={18} aria-hidden />
        </a>
        {source.data !== undefined ? (
          <CopyButton text={source.data} label="Copy file" className="muted-icon" />
        ) : null}
        <CloseButton onClick={props.onClose} label="Close file" />
      </header>
      <div className="panel-body">
        {source.isError ? (
          <p className="error" role="alert">
            Couldn’t load this file.
          </p>
        ) : source.data === undefined ? (
          <p className="muted">Loading…</p>
        ) : (
          <CodeBlock code={source.data} language={props.artifact.language} bare />
        )}
      </div>
    </aside>
  );
}
