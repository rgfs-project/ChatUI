import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FileCode2, MoreHorizontal, Trash2 } from "lucide-react";
import { Link } from "react-router";
import type { ArtifactList } from "@shared/artifacts";
import { openArtifact } from "../chat/artifact-events";
import { formatSize } from "../chat/message-attachments";
import { apiJson } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { formatSeparator } from "../lib/time";
import { useUi } from "../lib/ui-context";
import { useConfirm } from "../ui/dialog";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useToast } from "../ui/toast";
import { COMPARE_CREATED, type Sort } from "./sort";

/**
 * Files captured from replies (Phase 13c). They outlive their chat; deleting
 * one never touches the chat, and a deleted file is never captured again.
 */
export function CreatedFiles({
  userId,
  query,
  sort,
  titles,
}: {
  userId: string;
  query: string;
  sort: Sort;
  titles: Map<string, string>;
}) {
  const { timeFormat } = useUi();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const created = useQuery({
    queryKey: qk.artifacts(userId),
    queryFn: ({ signal }) => apiJson<ArtifactList>("/api/artifacts", { signal }),
  });
  const needle = query.trim().toLowerCase();
  const shown = (created.data?.artifacts ?? [])
    .filter((a) => needle === "" || a.filename.toLowerCase().includes(needle))
    .sort(COMPARE_CREATED[sort]);
  if (created.isPending) return <p className="library-note">Loading files…</p>;
  if (created.isError)
    return (
      <p className="library-note" role="alert">
        Your files could not be loaded.
      </p>
    );
  if (shown.length === 0)
    return (
      <p className="library-note" data-testid="library-empty">
        {created.data.artifacts.length === 0
          ? "No files from replies yet. Files a model creates appear here."
          : "No files match."}
      </p>
    );
  return (
    <table className="library-table" data-testid="library-created">
      <thead>
        <tr>
          <th>Name</th>
          <th className="col-chat">Chat</th>
          <th className="col-size">Size</th>
          <th className="col-date">Created</th>
          <th>
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {shown.map((file) => (
          <tr key={file.id} data-testid="library-row">
            <td>
              <button
                type="button"
                className="library-name"
                onClick={() => {
                  openArtifact(file.id);
                }}
              >
                <FileCode2 size={18} aria-hidden />
                <span className="library-name-text">{file.filename}</span>
              </button>
            </td>
            <td className="col-chat">
              {file.conversationAvailable ? (
                <Link to={paths.chat(file.conversationId)} className="library-chat">
                  {titles.get(file.conversationId) ?? "Chat"}
                </Link>
              ) : (
                <span className="library-muted">Chat deleted</span>
              )}
            </td>
            <td className="col-size">{formatSize(file.size)}</td>
            <td className="col-date">{formatSeparator(file.createdAt, timeFormat)}</td>
            <td className="col-actions">
              <Menu
                label={`Options for ${file.filename}`}
                align="end"
                trigger={
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Options for ${file.filename}`}
                  >
                    <MoreHorizontal size={18} aria-hidden />
                  </button>
                }
              >
                <MenuItem
                  icon={<ExternalLink size={16} aria-hidden />}
                  onSelect={() => {
                    openArtifact(file.id);
                  }}
                >
                  Open
                </MenuItem>
                <MenuItem
                  icon={<Download size={16} aria-hidden />}
                  onSelect={() => {
                    window.location.assign(`/api/artifacts/${file.id}/source?download=1`);
                  }}
                >
                  Download
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 size={16} aria-hidden />}
                  danger
                  onSelect={() => {
                    void (async () => {
                      const yes = await confirm({
                        title: "Delete this file?",
                        body: `“${file.filename}” is deleted. Its chat stays as it is.`,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!yes) return;
                      try {
                        await apiJson(`/api/artifacts/${file.id}`, { method: "DELETE" });
                        toast("File deleted.");
                      } catch (error) {
                        toast(error instanceof Error ? error.message : "Could not delete", "error");
                      }
                      await client.invalidateQueries({ queryKey: ["u", userId] });
                    })();
                  }}
                >
                  Delete
                </MenuItem>
              </Menu>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
