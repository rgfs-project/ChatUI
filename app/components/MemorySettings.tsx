import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { MEMORY_LIMITS, memoryNameProblem, type MemoryDto } from "@shared/memories";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { ConfirmDialog } from "./Dialogs";
import "./memories.css";

/**
 * Settings → Customize → Memories (Phase 13b, contracts §12): the notes the
 * user approved for the assistant to remember. Loaded lazily with its tab.
 * Only the user creates, edits or deletes them here or by saving a
 * suggestion; notes over the prompt budget are marked as not included.
 */
export default function MemorySettings({ userId }: { userId: string }) {
  const list = useQuery(queries.memories(userId));
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  if (editing) {
    const memory = editing.id ? list.data?.memories.find((m) => m.id === editing.id) : undefined;
    return (
      <MemoryEditor
        key={editing.id ?? "new"}
        userId={userId}
        memory={memory}
        onDone={() => {
          setEditing(null);
        }}
      />
    );
  }
  const omitted = new Set(list.data?.omittedIds ?? []);
  return (
    <section className="settings-body" aria-labelledby="settings-memories">
      <div className="skills-head">
        <h2 id="settings-memories">Memories</h2>
        <button
          type="button"
          onClick={() => {
            setEditing({ id: null });
          }}
        >
          <Plus size={16} aria-hidden /> Add
        </button>
      </div>
      <p className="settings-hint">
        Notes you approved for the assistant to remember in every chat. The assistant can suggest
        notes, but nothing is saved unless you save it.
      </p>
      {list.isPending ? (
        <p className="settings-hint">Loading memories…</p>
      ) : list.isError ? (
        <p className="settings-hint" role="alert">
          Memories couldn’t be loaded.{" "}
          <button type="button" className="link-button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : list.data.memories.length === 0 ? (
        <p className="settings-hint" data-testid="memories-empty">
          No memories yet.
        </p>
      ) : (
        <>
          {omitted.size > 0 ? (
            <p className="settings-hint" role="note">
              {String(omitted.size)} {omitted.size === 1 ? "note doesn’t" : "notes don’t"} fit in
              the space chats reserve for memories and {omitted.size === 1 ? "is" : "are"} left out.
            </p>
          ) : null}
          <ul className="memory-list" aria-label="Your memories">
            {list.data.memories.map((memory) => (
              <li key={memory.id} className="memory-row" data-testid="memory-row">
                <div className="memory-row-text">
                  <p className="memory-row-name">{memory.name}</p>
                  <p className="memory-row-content">{memory.content}</p>
                  {omitted.has(memory.id) ? (
                    <span className="memory-omitted">Not included in chats (over the limit)</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Edit ${memory.name}`}
                  onClick={() => {
                    setEditing({ id: memory.id });
                  }}
                >
                  Edit
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {list.data?.unreadable ? (
        <p className="settings-hint">
          {String(list.data.unreadable)} memory file(s) couldn’t be read and are not used.
        </p>
      ) : null}
    </section>
  );
}

function MemoryEditor(props: {
  userId: string;
  memory: MemoryDto | undefined;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const memory = props.memory;
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const settle = () => client.invalidateQueries({ queryKey: queryKeys.memories(props.userId) });
  const failed = (e: unknown, fallback: string) => {
    setError(e instanceof ApiError ? e.message : fallback);
    void settle();
  };
  const save = useMutation({
    mutationFn: (body: { name: string; content: string }) =>
      memory
        ? apiJson<MemoryDto>(`/api/memories/${encodeURIComponent(memory.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ ...body, expectedRevision: memory.revision }),
          })
        : apiJson<MemoryDto>("/api/memories", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await settle();
      props.onDone();
    },
    onError: (e) => {
      failed(e, "The memory couldn’t be saved.");
    },
  });
  const remove = useMutation({
    mutationFn: (m: MemoryDto) =>
      apiJson(
        `/api/memories/${encodeURIComponent(m.id)}?expectedRevision=${encodeURIComponent(m.revision)}`,
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      await settle();
      props.onDone();
    },
    onError: (e) => {
      failed(e, "The memory couldn’t be deleted.");
    },
  });

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    const name = field("name");
    const content = field("content");
    const problem = memoryNameProblem(name);
    if (problem) {
      setError(`The name ${problem}.`);
      return;
    }
    setError(null);
    save.mutate({ name: name.trim(), content });
  }

  return (
    <section className="settings-body" aria-labelledby="memory-editor-title">
      <button type="button" className="link-back" onClick={props.onDone}>
        <ArrowLeft size={16} aria-hidden /> Your memories
      </button>
      <h2 id="memory-editor-title">{memory ? memory.name : "New memory"}</h2>
      <form className="memory-form" onSubmit={submit}>
        <label htmlFor="memory-name">Name</label>
        <input
          id="memory-name"
          name="name"
          required
          maxLength={MEMORY_LIMITS.nameMax}
          defaultValue={memory?.name ?? ""}
          autoComplete="off"
        />
        <label htmlFor="memory-content">Note</label>
        <textarea
          id="memory-content"
          name="content"
          required
          rows={6}
          maxLength={MEMORY_LIMITS.contentMaxBytes}
          defaultValue={memory?.content ?? ""}
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          {memory ? (
            <button
              type="button"
              className="ghost danger"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Delete
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={props.onDone}>
            Cancel
          </button>
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      {memory ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete this memory?"
          description="The assistant will no longer see this note. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            remove.mutate(memory);
          }}
        />
      ) : null}
    </section>
  );
}
