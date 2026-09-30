import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { paths } from "../lib/paths";
import type { ConversationSummary } from "@shared/conversations";
import { apiJson, queryKeys } from "../lib/query";

// Interaction-only UI loads on demand (Phase 9): never in the critical bundle.
/** Starts loading the dialog chunk (on menu intent) before it is needed. */
export const preloadDialogs = () => import("./Dialogs");
const RenameDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.RenameDialog })));
const ConfirmDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.ConfirmDialog })));

export interface ConversationTarget {
  id: string;
  title: string;
}

export interface ConversationActions {
  /** Opens the rename dialog; focus returns to `from` (or the focused element). */
  rename: (target: ConversationTarget, from?: HTMLElement | null) => void;
  /** Opens the delete confirmation; focus returns like `rename`. */
  remove: (target: ConversationTarget, from?: HTMLElement | null) => void;
  /** Pins or unpins (canonical preferences, Phase 13a). */
  togglePin: (target: ConversationTarget & { pinned: boolean }) => void;
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
  // Dialogs mount on first use, then stay mounted (Radix restores focus on close).
  const [used, setUsed] = useState(false);
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

  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      apiJson<{ pins: string[] }>(`/api/conversations/${encodeURIComponent(id)}/pin`, {
        method: pinned ? "DELETE" : "PUT",
      }),
    onSuccess: ({ pins }) => {
      client.setQueryData<ConversationSummary[]>(queryKeys.conversations(userId), (list) =>
        list?.map((item) => ({
          ...item,
          pinnedRank: pins.includes(item.id) ? pins.indexOf(item.id) : null,
        })),
      );
    },
    onError: () => void invalidate(),
  });

  const remember = (from?: HTMLElement | null) => {
    origin.current =
      from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  return {
    rename: (target, from) => {
      remember(from);
      setUsed(true);
      setRenaming(target);
    },
    remove: (target, from) => {
      remember(from);
      setUsed(true);
      setDeleting(target);
    },
    togglePin: (target) => {
      pinMutation.mutate({ id: target.id, pinned: target.pinned });
    },
    dialogs: used ? (
      <Suspense fallback={null}>
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
      </Suspense>
    ) : null,
  };
}
