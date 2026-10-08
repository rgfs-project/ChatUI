import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { MEMORY_LIMITS, type MemoryDto, type MemoryList } from "@shared/memories";
import { ConfirmDialog } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { formatBytes } from "../lib/format";
import { keys } from "../lib/query";
import {
  ActionRow,
  FieldRow,
  formText,
  Group,
  LinkRow,
  Status,
  TextAreaRow,
  useSubPage,
} from "./parts";

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
  useSubPage(
    editing
      ? {
          title: editing === "new" ? "New memory" : editing.name,
          onBack: () => {
            setEditing(null);
          },
        }
      : null,
  );

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
        {
          method: "DELETE",
        },
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
      <form onSubmit={(e) => void save(e)}>
        <Group note="Included with every chat. Keep it short and factual.">
          <FieldRow
            label="Name"
            name="name"
            defaultValue={memory?.name ?? ""}
            required
            maxLength={MEMORY_LIMITS.nameMax}
          />
          <TextAreaRow
            label="Note"
            name="content"
            defaultValue={memory?.content ?? ""}
            required
            rows={6}
            maxLength={MEMORY_LIMITS.contentMaxBytes}
          />
        </Group>
        <Group>
          <button type="submit" className="row row-button action-row" disabled={busy}>
            <Check size={18} aria-hidden />
            <span>{memory ? "Save" : "Add memory"}</span>
          </button>
        </Group>
        {memory ? (
          <Group>
            <ActionRow
              danger
              icon={<Trash2 size={18} aria-hidden />}
              label="Delete memory"
              onClick={() => {
                setDeleting(true);
              }}
            />
          </Group>
        ) : null}
        <Status error={error} />
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
      </form>
    );
  }

  const data = memories.data;
  const omitted = new Set(data?.omittedIds ?? []);
  return (
    <>
      {data && data.memories.length > 0 ? (
        <Group
          note={`${String(data.memories.length)} of ${String(data.limits.maxCount)} · prompt budget ${formatBytes(data.promptBudgetBytes)}${
            omitted.size ? ` · ${String(omitted.size)} left out of prompts (over budget)` : ""
          }${data.unreadable ? ` · ${String(data.unreadable)} unreadable` : ""}`}
        >
          {data.memories.map((m) => (
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
      ) : null}
      <Group note="Notes the assistant keeps in every chat.">
        <ActionRow
          icon={<Plus size={18} aria-hidden />}
          label="Add a memory"
          onClick={() => {
            setEditing("new");
            setError(null);
          }}
        />
      </Group>
      <Status error={memories.isError ? "Couldn’t load your memories." : null} />
    </>
  );
}
