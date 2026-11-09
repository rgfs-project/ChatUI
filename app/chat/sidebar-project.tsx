import { useQueryClient } from "@tanstack/react-query";
import type { PreferencesDto } from "@shared/preferences";
import { apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { useConfirm } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { openProjectDialog } from "./project-dialogs";
import { Folder, FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ConversationSummary } from "@shared/conversations";
import type { usePrefetcher } from "../lib/prefetch";
import { Menu, MenuItem } from "../ui/menu";
import { useChat } from "./chat-context";
import { ConversationRow } from "./sidebar-row";

export /** A project (Phase 13g): a folder row that folds open to its chats. */
function ProjectRow({
  project,
  items,
  open,
  onToggle,
  conversationId,
  pins,
  prefetcher,
}: {
  project: PreferencesDto["projects"][number];
  items: ConversationSummary[];
  open: boolean;
  onToggle: () => void;
  conversationId: string | null;
  pins: string[];
  prefetcher: ReturnType<typeof usePrefetcher>;
}) {
  const { userId } = useChat();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const listId = `project-${project.id}`;
  return (
    <li className="project-item" data-testid="project">
      <div className="chat-row project-row">
        <button
          type="button"
          className="chat-link project-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
        >
          {open ? <FolderOpen size={16} aria-hidden /> : <Folder size={16} aria-hidden />}
          <span className="chat-title">
            <span className="chat-title-text">{project.name}</span>
          </span>
        </button>
        <Menu
          label={`Options for project ${project.name}`}
          align="start"
          trigger={
            <button
              type="button"
              className="row-menu"
              aria-label={`Options for project ${project.name}`}
            >
              <MoreHorizontal size={16} aria-hidden />
            </button>
          }
        >
          <MenuItem
            icon={<Pencil size={16} aria-hidden />}
            onSelect={() => {
              openProjectDialog({ kind: "rename", projectId: project.id, name: project.name });
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            danger
            icon={<Trash2 size={16} aria-hidden />}
            onSelect={() => {
              void (async () => {
                const yes = await confirm({
                  title: "Delete this project?",
                  body: `“${project.name}” is removed. Its chats stay in Recents.`,
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (!yes) return;
                try {
                  client.setQueryData(
                    qk.preferences(userId),
                    await apiJson<PreferencesDto>(`/api/projects/${project.id}`, {
                      method: "DELETE",
                    }),
                  );
                } catch (error) {
                  toast(error instanceof Error ? error.message : "Could not delete", "error");
                }
              })();
            }}
          >
            Delete
          </MenuItem>
        </Menu>
      </div>
      {open ? (
        items.length === 0 ? (
          <p className="side-note project-empty" id={listId}>
            No chats yet. Use “Move to project…” on a chat.
          </p>
        ) : (
          <ul className="chat-list project-chats" id={listId}>
            {items.map((item) => (
              <ConversationRow
                key={item.id}
                item={item}
                active={item.id === conversationId}
                pinned={pins.includes(item.id)}
                prefetcher={prefetcher}
              />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}
