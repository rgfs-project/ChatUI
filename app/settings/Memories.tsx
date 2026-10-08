import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { MEMORY_LIMITS, type MemoryDto, type MemoryList } from "@shared/memories";
import { ConfirmDialog } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { formatBytes } from "../lib/format";
import { keys } from "../lib/query";
import { Empty, Field, Group, LinkRow, Status, SubHeader, TextArea, formText } from "./parts";

export function Memories(props: { userId: string }) {
  const client = useQueryClient();
  const memories = useQuery({
    queryKey: keys.memories(props.userId),
    queryFn: ({ signal }) => api<MemoryList>("/api/memories", { signal }),
  });
  const [editing, setEditing] = useState<MemoryDto | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: keys.memories(props.userId) });

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const name = formText(form, "name");
    const content = formText(form, "content");
    setBusy(true);
    setError(null);
    try {
      if (editing === "new")
        await api("/api/memories", { method: "POST", body: { name, content } });
      else
        await api(`/api/memories/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body: { name, content, expectedRevision: editing.revision },
        });
      await refresh();
      setEditing(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || editing === "new") return;
    setBusy(true);
    try {
      await api(
        `/api/memories/${encodeURIComponent(editing.id)}?expectedRevision=${editing.revision}`,
        { method: "DELETE" },
      );
      await refresh();
      setDeleting(false);
      setEditing(null);
    } catch (e) {
      setError(messageOf(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const memory = editing === "new" ? null : editing;
    return (
      <>
        <SubHeader
          title={memory?.name ?? "New memory"}
          backLabel="Memories"
          onBack={() => {
            setEditing(null);
          }}
        />
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <Field
            label="Name"
            name="name"
            defaultValue={memory?.name ?? ""}
            required
            maxLength={MEMORY_LIMITS.nameMax}
          />
          <TextArea
            label="Note"
            name="content"
            defaultValue={memory?.content ?? ""}
            required
            rows={8}
            maxLength={MEMORY_LIMITS.contentMaxBytes}
            hint="Included with every chat. Keep it short and factual."
          />
          <Status error={error} />
          <div className="form-actions">
            {memory ? (
              <button
                type="button"
                className="button danger-soft"
                onClick={() => {
                  setDeleting(true);
                }}
              >
                Delete
              </button>
            ) : null}
            <span className="spacer" />
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditing(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete memory?"
          description={`“${memory?.name ?? ""}” will be forgotten.`}
          confirm="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </>
    );
  }

  const data = memories.data;
  const omitted = new Set(data?.omittedIds ?? []);
  return (
    <>
      <div className="section-toolbar">
        <p className="muted">
          Notes you approve, included with every chat. Models can suggest them; nothing is saved
          without you.
        </p>
        <button
          type="button"
          className="button primary small"
          onClick={() => {
            setEditing("new");
            setError(null);
          }}
        >
          New memory
        </button>
      </div>
      {data?.memories.length === 0 ? (
        <Empty title="No memories yet">Add one, or save a suggestion from a reply.</Empty>
      ) : (
        <Group
          note={
            data
              ? `${String(data.memories.length)} of ${String(data.limits.maxCount)} · prompt budget ${formatBytes(data.promptBudgetBytes)}${
                  omitted.size ? ` · ${String(omitted.size)} left out of prompts (over budget)` : ""
                }${data.unreadable ? ` · ${String(data.unreadable)} unreadable` : ""}`
              : undefined
          }
        >
          {data?.memories.map((m) => (
            <LinkRow
              key={m.id}
              label={m.name}
              hint={m.content}
              value={omitted.has(m.id) ? "Left out" : undefined}
              onClick={() => {
                setEditing(m);
                setError(null);
              }}
            />
          ))}
        </Group>
      )}
      <Status error={memories.isError ? "Couldn’t load your memories." : null} />
    </>
  );
}
