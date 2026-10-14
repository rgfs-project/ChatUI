import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ArrowLeft, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useRouteLoaderData } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { isTheme, type Theme } from "@shared/theme";
import { paths } from "../lib/paths";
import { apiJson, queries, queryKeys } from "../lib/query";
import { applyReasoningShown, applyTheme } from "../lib/theme";
import { AttachmentSettings } from "./AttachmentSettings";
import { ConfirmDialog } from "./Dialogs";

/** Settings → General: appearance, chat display and the chat history. */
export function GeneralSettings({ userId }: { userId: string }) {
  const [archive, setArchive] = useState(false);
  if (archive)
    return (
      <ArchivedChats
        userId={userId}
        onBack={() => {
          setArchive(false);
        }}
      />
    );
  return (
    <>
      <h1 className="page-title">General</h1>
      <section className="section">
        <h2 className="section-title">Appearance</h2>
        <div className="group">
          <ThemeRow />
        </div>
      </section>
      <section className="section">
        <h2 className="section-title">Chat</h2>
        <div className="group">
          <ReasoningRow />
          <AttachmentSettings userId={userId} />
        </div>
      </section>
      <ChatHistory
        userId={userId}
        onOpenArchive={() => {
          setArchive(true);
        }}
      />
    </>
  );
}

/** The theme: applied at once and remembered by this browser. */
function ThemeRow() {
  // What the server rendered from the cookie: the same on server and client.
  const root = useRouteLoaderData<{ theme?: Theme }>("root");
  const [theme, setTheme] = useState<Theme>(root?.theme ?? "system");
  return (
    <div className="row">
      <label className="row-label" htmlFor="theme-select">
        Theme
      </label>
      <select
        id="theme-select"
        className="select"
        value={theme}
        onChange={(event) => {
          const next = event.target.value;
          if (!isTheme(next)) return;
          applyTheme(next);
          setTheme(next);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}

/** Show thought process: the model's reasoning above replies (display only). */
function ReasoningRow() {
  const root = useRouteLoaderData<{ reasoningShown?: boolean }>("root");
  const [shown, setShown] = useState(root?.reasoningShown ?? true);
  return (
    <div className="row">
      <label className="row-label" htmlFor="reasoning-toggle">
        Show thought process
      </label>
      <input
        id="reasoning-toggle"
        type="checkbox"
        className="switch"
        role="switch"
        checked={shown}
        onChange={(event) => {
          applyReasoningShown(event.target.checked);
          setShown(event.target.checked);
        }}
      />
    </div>
  );
}

function ChatHistory({ userId, onOpenArchive }: { userId: string; onOpenArchive: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery(queries.conversations(userId));
  const archived = (list.data ?? []).filter((c) => c.archived === true).length;
  const active = (list.data ?? []).filter((c) => c.archived !== true).length;
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const archiveAll = useMutation({
    mutationFn: () =>
      apiJson<{ archived: number }>("/api/conversations/archive-all", {
        method: "POST",
        body: "{}",
      }),
    onSuccess: async ({ archived: count }) => {
      setResult(`${String(count)} chat${count === 1 ? "" : "s"} archived.`);
      await client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
    },
    onError: () => {
      setResult("The chats couldn’t be archived. Try again.");
    },
  });

  const clear = useMutation({
    mutationFn: () => apiJson<{ deleted: number }>("/api/conversations", { method: "DELETE" }),
    onSuccess: async ({ deleted }) => {
      setResult(`${String(deleted)} chat${deleted === 1 ? "" : "s"} deleted.`);
      client.removeQueries({ queryKey: ["user", userId, "conversation"] });
      client.removeQueries({ queryKey: ["user", userId, "search"] });
      await client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
      await client.invalidateQueries({ queryKey: queryKeys.projects(userId) });
      // Back would otherwise return to a chat that no longer exists.
      await navigate(paths.settings(), { replace: true, state: { background: paths.newChat() } });
    },
    onError: () => {
      setResult("The chats couldn’t be deleted. Try again.");
    },
  });

  return (
    <>
      <section className="section">
        <h2 className="section-title">Chat history</h2>
        <div className="group">
          <button
            type="button"
            className="row"
            onClick={onOpenArchive}
            aria-label={`Archived chats: ${String(archived)}`}
          >
            <span className="row-label">Archived chats</span>
            <span className="row-value">
              {list.data ? `${String(archived)} chat${archived === 1 ? "" : "s"}` : "…"}
              <ChevronRight size={16} aria-hidden />
            </span>
          </button>
          <div className="row">
            <span className="row-label">Archive all chats</span>
            <button
              type="button"
              className="btn sm"
              disabled={archiveAll.isPending || active === 0}
              onClick={() => {
                setConfirm("archive");
              }}
            >
              Archive all
            </button>
          </div>
        </div>
      </section>
      <section className="group">
        <div className="row">
          <span className="row-label">Delete all chats</span>
          <button
            type="button"
            className="btn sm danger"
            disabled={clear.isPending}
            onClick={() => {
              setConfirm("delete");
            }}
          >
            Delete all
          </button>
        </div>
      </section>
      <p className="section-hint" role="status">
        {result ?? ""}
      </p>
      <ConfirmDialog
        open={confirm === "archive"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Archive all chats?"
        description="They leave the sidebar. You’ll find them under Archived chats."
        confirmLabel="Archive all"
        tone="primary"
        onConfirm={() => {
          archiveAll.mutate();
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Delete all chats?"
        description="This permanently deletes every chat in your history. You can’t undo this."
        confirmLabel="Delete all"
        onConfirm={() => {
          clear.mutate();
        }}
      />
    </>
  );
}

/** Settings → General → Archived chats: open one, bring it back, or delete it. */
function ArchivedChats({ userId, onBack }: { userId: string; onBack: () => void }) {
  const client = useQueryClient();
  const list = useQuery(queries.conversations(userId));
  const archived = (list.data ?? []).filter((c) => c.archived === true);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.conversations(userId) });
  const restore = useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}/archive`, { method: "DELETE" }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: refresh,
  });
  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden /> General
      </button>
      <h1 className="page-title">Archived chats</h1>
      {list.isPending ? (
        <p className="hint">Loading…</p>
      ) : archived.length === 0 ? (
        <section className="group">
          <p className="row row-hint">
            No archived chats. Archive one from its menu in the sidebar.
          </p>
        </section>
      ) : (
        <ul className="group" aria-label="Archived chats" data-testid="archived-list">
          {archived.map((chat) => (
            <li key={chat.id} className="row">
              <Link to={paths.chat(chat.id)} className="row-text grow archived-link">
                <span className="row-label">{chat.title}</span>
                <span className="row-hint">{new Date(chat.updatedAt).toLocaleDateString()}</span>
              </Link>
              <div className="row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Unarchive ${chat.title}`}
                  title="Unarchive"
                  disabled={restore.isPending}
                  onClick={() => {
                    restore.mutate(chat.id);
                  }}
                >
                  <ArchiveRestore size={18} aria-hidden />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete ${chat.title}`}
                  title="Delete"
                  onClick={() => {
                    setDeleting(chat);
                  }}
                >
                  <Trash2 size={18} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete conversation?"
        description={`"${deleting?.title ?? ""}" will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </>
  );
}
