import * as RadixDialog from "@radix-ui/react-dialog";
import "./source-panel.css";
import { useQuery } from "@tanstack/react-query";
import { Code2, Download, Play, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { ArtifactDto } from "@shared/artifacts";
import { apiFetch, apiJson } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { useChat } from "./chat-context";
import { CopyButton } from "./message";
import { formatSize } from "./message-attachments";
import { CodeBlock } from "./render/code";
import { PreviewFrame } from "./preview-frame";
import { isPreviewable } from "@shared/preview";
import { preferencesQuery } from "../lib/query/queries";

/** File extension → highlighter language. */
function languageOf(filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    mjs: "javascript",
    jsx: "jsx",
    py: "python",
    md: "markdown",
    yml: "yaml",
    sh: "bash",
    rs: "rust",
    rb: "ruby",
    txt: "",
  };
  const language = map[ext] ?? ext;
  return language === "" ? null : language;
}

/**
 * The source panel (Phase 13c, INV-41): a captured file shown as text, never
 * rendered or run. HTML, SVG and scripts appear as their source.
 */
export default function SourcePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { userId } = useChat();
  const meta = useQuery({
    queryKey: [...qk.artifact(userId, id), "meta"],
    queryFn: ({ signal }) => apiJson<ArtifactDto>(`/api/artifacts/${id}`, { signal }),
  });
  const source = useQuery({
    queryKey: [...qk.artifact(userId, id), "source"],
    queryFn: async ({ signal }) => {
      const res = await apiFetch(`/api/artifacts/${id}/source`, { signal });
      if (!res.ok) throw new Error("The file could not be loaded");
      return res.text();
    },
  });
  const file = meta.data;
  // Phase 19: only with the setting on, only for small HTML/SVG, only on request.
  const previewsOn = useQuery(preferencesQuery(userId)).data?.previews === true;
  const canPreview = previewsOn && file !== undefined && isPreviewable(file.filename, file.size);
  const [previewing, setPreviewing] = useState(false);
  // Opened by an event, not a Radix trigger: return focus to whatever opened it.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content
          className="dialog source-panel"
          aria-describedby={undefined}
          data-testid="source-panel"
          data-artifact-id={id}
          // Focus the panel itself: a focused toolbar button would show its tooltip.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (opener?.isConnected) {
              event.preventDefault();
              opener.focus();
            }
          }}
        >
          <div className="source-head">
            <RadixDialog.Title className="source-title">
              <span>{file?.filename ?? "File"}</span>
              {file ? (
                <span className="source-meta">
                  {formatSize(file.size)}
                  {file.conversationAvailable ? (
                    <>
                      {" · "}
                      <Link to={paths.chat(file.conversationId)} onClick={onClose}>
                        Open chat
                      </Link>
                    </>
                  ) : (
                    " · Its chat was deleted"
                  )}
                </span>
              ) : null}
            </RadixDialog.Title>
            {canPreview ? (
              <button
                type="button"
                className="pill-button source-mode"
                onClick={() => {
                  setPreviewing(!previewing);
                }}
              >
                {previewing ? <Code2 size={16} aria-hidden /> : <Play size={16} aria-hidden />}
                <span>{previewing ? "Show source" : "Run preview"}</span>
              </button>
            ) : null}
            {source.data !== undefined ? <CopyButton text={source.data} label="Copy file" /> : null}
            <a
              className="icon-button"
              href={`/api/artifacts/${id}/source?download=1`}
              aria-label="Download file"
              download
            >
              <Download size={18} aria-hidden />
            </a>
            <RadixDialog.Close asChild>
              <button type="button" className="icon-button" aria-label="Close">
                <X size={18} aria-hidden />
              </button>
            </RadixDialog.Close>
          </div>
          <div className="source-body selectable">
            {meta.isError || source.isError ? (
              <p className="source-note" role="alert">
                This file is no longer available.
              </p>
            ) : source.data === undefined || !file ? (
              <p className="source-note">Loading…</p>
            ) : previewing && canPreview ? (
              <PreviewFrame artifactId={file.id} filename={file.filename} />
            ) : (
              <CodeBlock language={languageOf(file.filename)} source={source.data} />
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
