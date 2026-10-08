import { useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ConversationDto, ConversationList } from "@shared/conversations";
import { api, messageOf } from "../lib/api";
import { paths } from "../lib/paths";
import { keys } from "../lib/query";
import { ConfirmDialog, Dialog, DialogClose, MenuItem, MenuSeparator } from "./ui";

export interface ConversationRef {
  id: string;
  title: string;
  pinned: boolean;
}

type Open = { kind: "rename" | "delete"; target: ConversationRef } | null;

/**
 * Rename, pin, export and delete, shared by the sidebar rows, the chat header
 * and slash commands. `items(target)` renders menu items; `dialogs` must be
 * rendered once.
 */
export function useConversationActions(userId: string) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = () => client.invalidateQueries({ queryKey: keys.conversations(userId) });

  async function setPinned(target: ConversationRef, pinned: boolean) {
    // Optimistic: the row moves at once; the list refetch settles it.
    client.setQueryData<ConversationList>(keys.conversations(userId), (list) =>
      list
        ? {
            conversations: list.conversations.map((c) =>
              c.id === target.id ? { ...c, pinnedRank: pinned ? -1 : null } : c,
            ),
          }
        : list,
    );
    try {
      await api(`/api/conversations/${encodeURIComponent(target.id)}/pin`, {
        method: pinned ? "PUT" : "DELETE",
      });
    } finally {
      await refreshList();
    }
  }

  async function rename(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (open?.kind !== "rename") return;
    const title = ((new FormData(event.currentTarget).get("title") as string | null) ?? "").trim();
    if (!title) {
      setError("Enter a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dto = await api<ConversationDto>(
        `/api/conversations/${encodeURIComponent(open.target.id)}`,
        { method: "PATCH", body: { title } },
      );
      client.setQueryData(keys.conversation(userId, dto.id), dto);
      await refreshList();
      setOpen(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (open?.kind !== "delete") return;
    const id = open.target.id;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      setOpen(null);
      if (location.pathname === paths.chat(id)) await navigate(paths.newChat(), { replace: true });
      client.removeQueries({ queryKey: keys.conversation(userId, id) });
      await refreshList();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const start = (kind: "rename" | "delete", target: ConversationRef) => {
    setError(null);
    setOpen({ kind, target });
  };

  const items = (target: ConversationRef) => (
    <>
      <MenuItem
        icon={target.pinned ? <PinOff size={18} aria-hidden /> : <Pin size={18} aria-hidden />}
        onSelect={() => void setPinned(target, !target.pinned)}
      >
        {target.pinned ? "Unpin" : "Pin"}
      </MenuItem>
      <MenuItem
        icon={<Pencil size={18} aria-hidden />}
        onSelect={() => {
          start("rename", target);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem
        icon={<Download size={18} aria-hidden />}
        onSelect={() => {
          window.location.assign(`/api/conversations/${encodeURIComponent(target.id)}/export`);
        }}
      >
        Export as Markdown
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        danger
        icon={<Trash2 size={18} aria-hidden />}
        onSelect={() => {
          start("delete", target);
        }}
      >
        Delete
      </MenuItem>
    </>
  );

  const close = (value: boolean) => {
    if (!value) setOpen(null);
  };

  const dialogs = (
    <>
      <Dialog open={open?.kind === "rename"} onOpenChange={close} title="Rename chat">
        <form className="dialog-form" onSubmit={(e) => void rename(e)}>
          <label className="sr-only" htmlFor="rename-title">
            Title
          </label>
          <input
            id="rename-title"
            name="title"
            className="input"
            maxLength={200}
            defaultValue={open?.target.title ?? ""}
            autoFocus
          />
          {error && open?.kind === "rename" ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <DialogClose asChild>
              <button type="button" className="button">
                Cancel
              </button>
            </DialogClose>
            <button type="submit" className="button primary" disabled={busy}>
              Rename
            </button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={open?.kind === "delete"}
        onOpenChange={close}
        title="Delete chat?"
        description={`“${open?.target.title ?? ""}” will be permanently deleted.`}
        confirm="Delete"
        danger
        busy={busy}
        error={open?.kind === "delete" ? error : null}
        onConfirm={() => void remove()}
      />
    </>
  );

  return { items, dialogs, start, setPinned };
}
