import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { LIBRARY_LIMITS } from "@shared/library-limits";
import { paths } from "../lib/paths";
import { apiJson, queryKeys } from "../lib/query";

/** The dialog chunk: fetched on menu intent, never in the critical bundle. */
export const preloadDialogs = () => import("./Dialogs");
const RenameDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.RenameDialog })));
const ConfirmDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.ConfirmDialog })));
const TextDialog = lazy(() => preloadDialogs().then((m) => ({ default: m.TextDialog })));

export interface ChatTarget {
  id: string;
  title: string;
}

export interface ChatActions {
  /** Opens the rename dialog; focus returns to `from` (else whatever was focused). */
  rename: (target: ChatTarget, from?: HTMLElement | null) => void;
  /** Opens the delete confirmation. */
  remove: (target: ChatTarget, from?: HTMLElement | null) => void;
  togglePin: (target: ChatTarget & { pinned: boolean }) => void;
  /** Archives (out of the sidebar) or brings back. */
  setArchived: (target: ChatTarget, archived: boolean) => void;
  /** Moves into a project, or out of every project (null). */
  moveTo: (target: ChatTarget, projectId: string | null) => void;
  /** Asks for a name, creates the project and moves the chat into it. */
  moveToNewProject: (target: ChatTarget, from?: HTMLElement | null) => void;
  /** Render once wherever the hook is used. */
  dialogs: ReactNode;
}

/**
 * Chat-level actions shared by the sidebar rows, the header menu and the "/"
 * commands. Deleting the open chat leaves it for a new chat first, so nothing
 * refetches a conversation that no longer exists.
 */
export function useChatActions(userId: string): ChatActions {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [renaming, setRenaming] = useState<ChatTarget | null>(null);
  const [deleting, setDeleting] = useState<ChatTarget | null>(null);
  const [newProjectFor, setNewProjectFor] = useState<ChatTarget | null>(null);
  // Mounted on first use, then kept (Radix needs the closing render for focus).
  const [used, setUsed] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  const returnFocus = () => origin.current;

  const refreshList = () => client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    onSettled: (_data, _error, vars) => {
      void refreshList();
      void client.invalidateQueries({ queryKey: queryKeys.conversation(userId, vars.id) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_data, id) => {
      if (id === conversationId) await navigate(paths.newChat(), { replace: true });
      client.removeQueries({ queryKey: queryKeys.conversation(userId, id) });
    },
    onSettled: () => void refreshList(),
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
    onError: () => void refreshList(),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}/archive`, {
        method: archived ? "PUT" : "DELETE",
      }),
    onMutate: ({ id, archived }) => {
      client.setQueryData<ConversationSummary[]>(queryKeys.conversations(userId), (list) =>
        list?.map((item) => (item.id === id ? { ...item, archived } : item)),
      );
    },
    onSettled: () => void refreshList(),
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string | null }) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}/project`, {
        method: "PUT",
        body: JSON.stringify({ projectId }),
      }),
    onMutate: ({ id, projectId }) => {
      client.setQueryData<ConversationSummary[]>(queryKeys.conversations(userId), (list) =>
        list?.map((item) => (item.id === id ? { ...item, projectId } : item)),
      );
    },
    onSettled: () => {
      void refreshList();
      void client.invalidateQueries({ queryKey: queryKeys.projects(userId) });
    },
  });

  const createProject = useMutation({
    mutationFn: (name: string) =>
      apiJson<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  });

  const remember = (from?: HTMLElement | null) => {
    origin.current =
      from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setUsed(true);
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
    togglePin: (target) => {
      pinMutation.mutate({ id: target.id, pinned: target.pinned });
    },
    setArchived: (target, archived) => {
      archiveMutation.mutate({ id: target.id, archived });
    },
    moveTo: (target, projectId) => {
      moveMutation.mutate({ id: target.id, projectId });
    },
    moveToNewProject: (target, from) => {
      remember(from);
      setNewProjectFor(target);
    },
    dialogs: used ? (
      <Suspense fallback={null}>
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
        <TextDialog
          key={newProjectFor?.id ?? "none"}
          open={newProjectFor !== null}
          onOpenChange={(open) => {
            if (!open) setNewProjectFor(null);
          }}
          title="New project"
          description={`“${newProjectFor?.title ?? ""}” moves into it.`}
          label="Project name"
          initial=""
          submitLabel="Create and move"
          maxLength={LIBRARY_LIMITS.projectName}
          returnFocus={returnFocus}
          onSubmit={(name) => {
            const target = newProjectFor;
            if (!target) return;
            createProject.mutate(name, {
              onSuccess: (project) => {
                moveMutation.mutate({ id: target.id, projectId: project.id });
              },
            });
          }}
        />
      </Suspense>
    ) : null,
  };
}
