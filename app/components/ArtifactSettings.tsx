import { useQuery } from "@tanstack/react-query";
import { Download, FileCode } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router";
import type { ArtifactSummary } from "@shared/artifacts";
import { paths } from "../lib/paths";
import { queries } from "../lib/query";
import { formatBytes } from "../lib/format";
import "./artifacts.css";

const ArtifactPanel = lazy(() => import("./ArtifactPanel"));

/**
 * Settings → Customize → Files (Phase 13c): every source file captured from
 * the user's replies. Files outlive their chats; a deleted chat's files say
 * so instead of linking. Loaded lazily with its tab.
 */
export default function ArtifactSettings({ userId }: { userId: string }) {
  const list = useQuery(queries.artifacts(userId));
  const [open, setOpen] = useState<{ artifact: ArtifactSummary; trigger: HTMLElement } | null>(
    null,
  );
  return (
    <section className="settings-body" aria-labelledby="settings-files">
      <h2 id="settings-files">Files</h2>
      <p className="settings-hint">
        Source files from replies. A code block becomes a file when the model labels it, like{" "}
        <code>```python file=hello.py</code>. Files are shown as text and never run.
      </p>
      {list.isPending ? (
        <p className="settings-hint">Loading files…</p>
      ) : list.isError ? (
        <p className="settings-hint" role="alert">
          Files couldn’t be loaded.{" "}
          <button type="button" className="link-button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : list.data.artifacts.length === 0 ? (
        <p className="settings-hint" data-testid="files-empty">
          No files yet.
        </p>
      ) : (
        <>
          <p className="settings-hint">
            {formatBytes(list.data.usedBytes)} of {formatBytes(list.data.quotaBytes)} used
          </p>
          <ul className="artifact-list" aria-label="Your files">
            {list.data.artifacts.map((artifact) => (
              <li key={artifact.id} className="artifact-row" data-testid="artifact-row">
                <FileCode size={18} aria-hidden />
                <div className="artifact-row-text">
                  <p className="artifact-row-name">{artifact.name}</p>
                  <p className="artifact-row-meta">
                    {formatBytes(artifact.size)} ·{" "}
                    {new Date(artifact.createdAt).toLocaleDateString()} ·{" "}
                    {artifact.backlinkAvailable && artifact.conversationId ? (
                      <Link
                        to={`${paths.chat(artifact.conversationId)}${artifact.assistantMessageId ? `#m-${artifact.assistantMessageId}` : ""}`}
                      >
                        Open chat
                      </Link>
                    ) : (
                      "Chat deleted"
                    )}
                  </p>
                </div>
                <div className="artifact-row-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`View ${artifact.name}`}
                    onClick={(event) => {
                      setOpen({ artifact, trigger: event.currentTarget });
                    }}
                  >
                    View
                  </button>
                  <a
                    className="button-link secondary"
                    href={`/api/artifacts/${encodeURIComponent(artifact.id)}/source?download=1`}
                    download={artifact.name}
                    aria-label={`Download ${artifact.name}`}
                  >
                    <Download size={16} aria-hidden />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {open ? (
        <Suspense fallback={null}>
          <ArtifactPanel
            userId={userId}
            artifact={open.artifact}
            trigger={open.trigger}
            onClose={() => {
              setOpen(null);
            }}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
