import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Brain, Plus } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { MEMORY_LIMITS, memoryNameProblem, type MemoryDto } from "@shared/memories";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { ConfirmDialog } from "./Dialogs";
import "./memories.css";
import "./skills.css";

/**
 * Settings → Memories (lazy): the notes you approved for the assistant to
 * read in every chat. Only you add, change or delete them, here or by saving
 * a suggestion. Notes over the prompt budget are marked as left out.
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
  const any = (list.data?.memories.length ?? 0) > 0;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Memories</h1>
        {any ? (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              setEditing({ id: null });
            }}
          >
            <Plus size={16} aria-hidden /> Add a memory
          </button>
        ) : null}
      </div>
      {list.isPending ? (
        <p className="hint">Loading memories…</p>
      ) : list.isError ? (
        <div className="alert danger" role="alert">
          <span className="alert-text">Memories couldn’t be loaded.</span>
          <button type="button" className="btn" onClick={() => void list.refetch()}>
            Try again
          </button>
        </div>
      ) : !any ? (
        <section className="group" data-testid="memories-empty">
          <div className="row">
            <div className="row-text">
              <h2 className="row-label">Add your first memory</h2>
              <p className="row-hint">The assistant reads your notes in every chat.</p>
            </div>
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                setEditing({ id: null });
              }}
            >
              Add a memory
            </button>
          </div>
        </section>
      ) : (
        <section className="section">
          <p className="section-hint">
            The assistant reads these in every chat. It may suggest more; nothing is saved until you
            save it.
          </p>
          {omitted.size > 0 ? (
            <p className="section-hint" role="note">
              {String(omitted.size)} {omitted.size === 1 ? "note doesn’t" : "notes don’t"} fit in
              the space chats keep for memories, so {omitted.size === 1 ? "it’s" : "they’re"} left
              out.
            </p>
          ) : null}
          <ul className="group" aria-label="Your memories">
            {list.data.memories.map((memory) => (
              <li key={memory.id} className="row" data-testid="memory-row">
                <span className="file-icon" aria-hidden>
                  <Brain size={18} />
                </span>
                <div className="row-text memory-text">
                  <p className="row-label">{memory.name}</p>
                  <p className="row-hint">{memory.content}</p>
                  {omitted.has(memory.id) ? (
                    <span className="badge">Not included in chats (over the limit)</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn sm"
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
        </section>
      )}
      {list.data?.unreadable ? (
        <p className="section-hint">
          {String(list.data.unreadable)} memory file{list.data.unreadable === 1 ? "" : "s"} couldn’t
          be read and {list.data.unreadable === 1 ? "isn’t" : "aren’t"} used.
        </p>
      ) : null}
    </>
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
    <>
      <button type="button" className="back-link" onClick={props.onDone}>
        <ArrowLeft size={16} aria-hidden /> Memories
      </button>
      <h1 className="page-title">{memory ? memory.name : "New memory"}</h1>
      <form className="section skill-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="memory-name">
            Name
          </label>
          <input
            id="memory-name"
            name="name"
            className="input"
            required
            maxLength={MEMORY_LIMITS.nameMax}
            defaultValue={memory?.name ?? ""}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="memory-content">
            Note
          </label>
          <textarea
            id="memory-content"
            name="content"
            className="textarea"
            required
            rows={6}
            maxLength={MEMORY_LIMITS.contentMaxBytes}
            defaultValue={memory?.content ?? ""}
          />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          {memory ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Delete
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={props.onDone}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      {memory ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete this memory?"
          description="The assistant won’t see this note any more. You can’t undo this."
          confirmLabel="Delete"
          onConfirm={() => {
            remove.mutate(memory);
          }}
        />
      ) : null}
    </>
  );
}
