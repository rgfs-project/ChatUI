import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { paths } from "../lib/paths";
import { apiJson, queries, queryKeys } from "../lib/query";
import { count } from "../lib/render-counters";
import { ConfirmDialog, RenameDialog } from "./Dialogs";

function SidebarImpl({ userId, hidden }: { userId: string; hidden: boolean }) {
  count("sidebarRenders");
  useEffect(() => {
    count("sidebarMounts");
  }, []);
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Secondary data: loaded after hydration, never gating the composer.
  const list = useQuery(queries.conversations(userId));
  const conversations = list.data ?? [];
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  // The menu trigger that opened a dialog: focus returns there (INV-47).
  const menuTrigger = useRef<HTMLElement | null>(null);
  const returnFocus = () => menuTrigger.current;

  const invalidate = () => client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    onSettled: (_d, _e, vars) => {
      void invalidate();
      void client.invalidateQueries({ queryKey: queryKeys.conversation(userId, vars.id) });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_d, id) => {
      // Leave the deleted conversation first so nothing refetches it.
      if (id === conversationId) await navigate(paths.newChat(), { replace: true });
      client.removeQueries({ queryKey: queryKeys.conversation(userId, id) });
    },
    onSettled: () => void invalidate(),
  });

  return (
    <nav id="sidebar" className="sidebar" aria-label="Conversations" hidden={hidden}>
      <Link to={paths.newChat()} className="new-chat">
        <Plus size={16} aria-hidden /> New chat
      </Link>
      {list.isPending ? (
        <p className="sidebar-note" aria-busy="true" data-testid="conversations-loading">
          Loading conversations…
        </p>
      ) : list.isError && !list.data ? (
        <div className="sidebar-note" role="alert" data-testid="conversations-error">
          <p>Conversations couldn’t be loaded.</p>
          <button type="button" className="secondary" onClick={() => void list.refetch()}>
            Try again
          </button>
        </div>
      ) : conversations.length === 0 ? (
        <p className="sidebar-note" data-testid="conversations-empty">
          No conversations yet. Your chats will appear here.
        </p>
      ) : null}
      <ul className="conversation-list" data-testid="conversation-list">
        {conversations.map((item) => (
          <li key={item.id} className={item.id === conversationId ? "current" : undefined}>
            <Link
              to={paths.chat(item.id)}
              aria-current={item.id === conversationId ? "page" : undefined}
            >
              {item.malformed ? <AlertTriangle size={14} aria-label="Unreadable" /> : null}
              <span className="conversation-title">
                {item.malformed ? `${item.title} (unreadable)` : item.title}
              </span>
            </Link>
            <Menu.Root>
              <Menu.Trigger asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Actions for ${item.title}`}
                  title="Actions"
                  onFocus={(event) => {
                    menuTrigger.current = event.currentTarget;
                  }}
                >
                  <MoreHorizontal size={16} aria-hidden />
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu-content" align="end" sideOffset={4}>
                  {item.malformed ? null : (
                    <Menu.Item
                      className="menu-item"
                      onSelect={() => {
                        setRenaming(item);
                      }}
                    >
                      <Pencil size={14} aria-hidden /> Rename
                    </Menu.Item>
                  )}
                  <Menu.Item
                    className="menu-item danger"
                    onSelect={() => {
                      setDeleting(item);
                    }}
                  >
                    <Trash2 size={14} aria-hidden /> Delete
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </li>
        ))}
      </ul>
      {/* Keyed so the field starts from the chosen conversation's title. */}
      <RenameDialog
        key={renaming?.id ?? "none"}
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        initial={renaming?.title ?? ""}
        returnFocus={returnFocus}
        onRename={(title) => {
          if (renaming) rename.mutate({ id: renaming.id, title });
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete conversation?"
        description={`"${deleting?.title ?? ""}" will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete"
        returnFocus={returnFocus}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </nav>
  );
}

export const Sidebar = memo(SidebarImpl);
