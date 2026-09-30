import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { paths } from "../lib/paths";
import { apiJson, queryKeys } from "../lib/query";
import { ConfirmDialog, RenameDialog } from "./Dialogs";

export interface ConversationTarget {
  id: string;
  title: string;
}

export interface ConversationActions {
  /** Opens the rename dialog; focus returns to `from` (or the focused element). */
  rename: (target: ConversationTarget, from?: HTMLElement | null) => void;
  /** Opens the delete confirmation; focus returns like `rename`. */
  remove: (target: ConversationTarget, from?: HTMLElement | null) => void;
  /** The dialogs; render once wherever the hook is used. */
  dialogs: ReactNode;
}

/**
 * Rename and delete for any conversation, shared by the sidebar row menus,
 * the header title menu and the "/" commands. Deleting the open conversation
 * leaves it for a new chat first so nothing refetches it.
 */
export function useConversationActions(userId: string): ConversationActions {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [renaming, setRenaming] = useState<ConversationTarget | null>(null);
  const [deleting, setDeleting] = useState<ConversationTarget | null>(null);
  // The control that opened a dialog: focus returns there (INV-47).
  const origin = useRef<HTMLElement | null>(null);
  const returnFocus = () => origin.current;

  const invalidate = () => client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  const renameMutation = useMutation({
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
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_d, id) => {
      if (id === conversationId) await navigate(paths.newChat(), { replace: true });
      client.removeQueries({ queryKey: queryKeys.conversation(userId, id) });
    },
    onSettled: () => void invalidate(),
  });

  const remember = (from?: HTMLElement | null) => {
    origin.current =
      from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  return {
    rename: (target, from) => {
      remember(from);
      setRenaming(target);
    },
    remove: (target, from) => {
      remember(from);
      setDeleting(target);
    },
    dialogs: (
      <>
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
            if (renaming) renameMutation.mutate({ id: renaming.id, title });
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
            if (deleting) deleteMutation.mutate(deleting.id);
          }}
        />
      </>
    ),
  };
}
