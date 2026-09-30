import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileCode, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "../lib/format";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { CopyButton } from "./Message";
import { ConfirmDialog } from "./Dialogs";
import "./artifacts.css";

/** What the panel needs to show before the source arrives. */
export interface ArtifactRef {
  id: string;
  name: string;
  language: string | null;
  size: number;
}

/**
 * The source panel (Phase 13c, INV-41), loaded when first opened. The source
 * is fetched as text and rendered as a text node: HTML, SVG and scripts are
 * shown, never parsed or run. A Radix Dialog: focus is trapped, Escape
 * closes and focus returns to the card that opened it.
 */
export default function ArtifactPanel(props: {
  userId: string;
  artifact: ArtifactRef;
  onClose: () => void;
  /** Where focus goes back (the card or row that opened the panel). */
  trigger: HTMLElement | null;
}) {
  const { userId, artifact } = props;
  const client = useQueryClient();
  const source = useQuery(queries.artifactSource(userId, artifact.id));
  const [confirming, setConfirming] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () =>
      apiJson(`/api/artifacts/${encodeURIComponent(artifact.id)}`, { method: "DELETE" }),
    onSuccess: () => {
      client.removeQueries({ queryKey: queryKeys.artifactSource(userId, artifact.id) });
      void client.invalidateQueries({ queryKey: queryKeys.artifacts(userId) });
      // Transcript cards come with the conversation DTO.
      void client.invalidateQueries({ queryKey: ["user", userId, "conversation"] });
      props.onClose();
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "The file couldn’t be deleted.");
    },
  });
  const href = `/api/artifacts/${encodeURIComponent(artifact.id)}/source?download=1`;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content artifact-panel"
          data-testid="artifact-panel"
          // Focus starts on the source (scrollable with the keyboard), not on Delete.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            sourceRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (props.trigger?.isConnected) {
              event.preventDefault();
              props.trigger.focus();
            }
          }}
        >
          <header className="artifact-panel-head">
            <FileCode size={18} aria-hidden />
            <div className="artifact-panel-title">
              <Dialog.Title className="artifact-name">{artifact.name}</Dialog.Title>
              <Dialog.Description className="artifact-meta">
                {artifact.language ? `${artifact.language} · ` : ""}
                {formatBytes(artifact.size)} · source only, never run
              </Dialog.Description>
            </div>
            <div className="artifact-panel-actions">
              {source.data !== undefined ? (
                <CopyButton text={source.data} label="Copy source" />
              ) : null}
              <a className="icon-btn" href={href} download={artifact.name} aria-label="Download">
                <Download size={16} aria-hidden />
              </a>
              <button
                type="button"
                className="icon-btn"
                aria-label="Delete file"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                <Trash2 size={16} aria-hidden />
              </button>
              <Dialog.Close className="icon-btn" aria-label="Close">
                <X size={16} aria-hidden />
              </Dialog.Close>
            </div>
          </header>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="artifact-source-wrap" ref={sourceRef} tabIndex={0} aria-label="Source">
            {source.isPending ? (
              <p className="settings-hint" role="status">
                Loading…
              </p>
            ) : source.isError ? (
              <p className="form-error" role="alert">
                The file couldn’t be loaded.
              </p>
            ) : (
              <pre className="artifact-source" data-testid="artifact-source">
                <code>{source.data}</code>
              </pre>
            )}
          </div>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Delete this file?"
            description="It is removed from your files. The chat it came from keeps its text."
            confirmLabel="Delete"
            onConfirm={() => {
              remove.mutate();
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
