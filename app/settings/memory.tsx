import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { MemoryDto, MemoryList } from "@shared/memories";
import { useChat } from "../chat/chat-context";
import { apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { useConfirm } from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { useToast } from "../ui/toast";

function MemoryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; body: string };
  submitLabel: string;
  onSubmit: (value: { name: string; body: string }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    void onSubmit({ name: name.trim(), body: body.trim() }).then((done) => {
      setBusy(false);
      if (done) onCancel();
    });
  };
  return (
    <form className="memory-form" aria-label={submitLabel} onSubmit={submit}>
      <input
        className="text-field selectable"
        aria-label="Name"
        placeholder="Name"
        maxLength={64}
        value={name}
        autoFocus
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      <textarea
        className="text-field selectable"
        aria-label="Memory"
        placeholder="What should ChatUI remember?"
        maxLength={2_000}
        rows={3}
        value={body}
        onChange={(event) => {
          setBody(event.currentTarget.value);
        }}
      />
      <div className="memory-form-actions">
        <button type="button" className="pill-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="pill-button pill-primary"
          disabled={busy || name.trim() === "" || body.trim() === ""}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * Settings → Memory (Phase 13b): the user's approved notes. Replies include
 * them whole until their prompt share is used; the rest are marked.
 * Suggestions from the model appear under its replies, never here, until the
 * user saves them.
 */
export function MemoryManager() {
  const { userId } = useChat();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const key = qk.memories(userId);
  const memories = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiJson<MemoryList>("/api/memories", { signal }),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const save = async (url: string, method: string, json: unknown, done: string) => {
    try {
      await apiJson<MemoryDto>(url, { method, json });
      toast(done);
      await refresh();
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the memory", "error");
      await refresh();
      return false;
    }
  };
  const list = memories.data?.memories ?? [];
  return (
    <div className="memory-manager">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Saved memories</span>
          <span className="settings-row-hint">
            Facts ChatUI keeps in mind in every chat. Models can suggest new ones; nothing is saved
            until you choose Save.
          </span>
        </div>
        <div className="settings-row-control">
          <button
            type="button"
            className="pill-button"
            onClick={() => {
              setAdding(true);
              setEditing(null);
            }}
          >
            <Plus size={16} aria-hidden />
            Add
          </button>
        </div>
      </div>
      {adding ? (
        <MemoryForm
          initial={{ name: "", body: "" }}
          submitLabel="Save memory"
          onSubmit={(value) => save("/api/memories", "POST", value, "Memory saved.")}
          onCancel={() => {
            setAdding(false);
          }}
        />
      ) : null}
      {memories.isPending ? <p className="settings-row-hint">Loading…</p> : null}
      {!memories.isPending && list.length === 0 && !adding ? (
        <p className="memory-empty settings-row-hint">No memories yet.</p>
      ) : null}
      <ul className="memory-list" aria-label="Memories">
        {list.map((memory) =>
          editing === memory.id ? (
            <li key={memory.id}>
              <MemoryForm
                initial={{ name: memory.name, body: memory.body }}
                submitLabel="Save changes"
                onSubmit={(value) =>
                  save(
                    `/api/memories/${memory.id}`,
                    "PATCH",
                    { ...value, expectedRevision: memory.revision },
                    "Memory updated.",
                  )
                }
                onCancel={() => {
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li key={memory.id} className="memory-item" data-testid="memory">
              <div className="memory-text">
                <span className="memory-name">
                  {memory.name}
                  {memory.omitted ? (
                    <span className="memory-badge" title="Over the space replies give to memories">
                      Not used in replies
                    </span>
                  ) : null}
                </span>
                <span className="memory-body selectable">{memory.body}</span>
              </div>
              <IconButton
                label={`Edit ${memory.name}`}
                onClick={() => {
                  setEditing(memory.id);
                  setAdding(false);
                }}
              >
                <Pencil size={16} aria-hidden />
              </IconButton>
              <IconButton
                label={`Delete ${memory.name}`}
                onClick={() => {
                  void (async () => {
                    const yes = await confirm({
                      title: "Delete this memory?",
                      body: `“${memory.name}” will no longer be used in replies.`,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!yes) return;
                    try {
                      await apiJson(`/api/memories/${memory.id}`, {
                        method: "DELETE",
                        json: { expectedRevision: memory.revision },
                      });
                      toast("Memory deleted.");
                    } catch (error) {
                      toast(error instanceof Error ? error.message : "Could not delete", "error");
                    }
                    await refresh();
                  })();
                }}
              >
                <Trash2 size={16} aria-hidden />
              </IconButton>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
