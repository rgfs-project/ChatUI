import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { SKILL_LIMITS, type SkillDto } from "@shared/skills";
import { ConfirmDialog, Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { keys, useSkills } from "../lib/query";
import {
  ActionRow,
  FieldRow,
  formText,
  Group,
  LinkRow,
  Row,
  Status,
  TextAreaRow,
  useSubPage,
} from "./parts";

export function Skills(props: { userId: string }) {
  const client = useQueryClient();
  const skills = useSkills(props.userId);
  const [editing, setEditing] = useState<SkillDto | "new" | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useSubPage(
    editing
      ? {
          title: editing === "new" ? "New skill" : `/${editing.name}`,
          onBack: () => {
            setEditing(null);
          },
        }
      : null,
  );

  const refresh = () => client.invalidateQueries({ queryKey: keys.skills(props.userId) });
  const open = (skill: SkillDto | "new") => {
    setEditing(skill);
    setEnabled(skill === "new" ? true : skill.enabled);
    setError(null);
  };

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const body = {
      name: formText(form, "name").trim(),
      description: formText(form, "description"),
      instructions: formText(form, "instructions"),
      enabled,
    };
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") await api("/api/skills", { method: "POST", body });
      else await api(`/api/skills/${encodeURIComponent(editing.id)}`, { method: "PATCH", body });
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
      await api(`/api/skills/${encodeURIComponent(editing.id)}`, { method: "DELETE" });
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
    const skill = editing === "new" ? null : editing;
    return (
      <form onSubmit={(e) => void save(e)}>
        <Group note="Lowercase letters, digits and hyphens. Instructions go to the model with the message that uses the skill.">
          <FieldRow
            label="Name"
            name="name"
            defaultValue={skill?.name ?? ""}
            required
            maxLength={SKILL_LIMITS.nameLength}
            pattern="[a-z0-9][a-z0-9\-]*"
            placeholder="summarize"
            autoCapitalize="none"
            spellCheck={false}
          />
          <FieldRow
            label="Description"
            name="description"
            defaultValue={skill?.description ?? ""}
            maxLength={SKILL_LIMITS.descriptionLength}
            placeholder="Optional"
          />
          <TextAreaRow
            label="Instructions"
            name="instructions"
            defaultValue={skill?.instructions ?? ""}
            required
            rows={8}
            maxLength={SKILL_LIMITS.instructionsLength}
          />
          <Row label="Enabled">
            <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
          </Row>
        </Group>
        <Group>
          <button type="submit" className="row row-button action-row" disabled={busy}>
            <Check size={18} aria-hidden />
            <span>{skill ? "Save" : "Create skill"}</span>
          </button>
        </Group>
        {skill ? (
          <Group>
            <ActionRow
              danger
              icon={<Trash2 size={18} aria-hidden />}
              label="Delete skill"
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
          title="Delete skill?"
          description={`/${skill?.name ?? ""} will be deleted.`}
          confirm="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </form>
    );
  }

  const list = skills.data ?? [];
  return (
    <>
      {list.length > 0 ? (
        <Group>
          {list.map((s) => (
            <LinkRow
              key={s.id}
              label={`/${s.name}`}
              hint={s.description || undefined}
              value={s.enabled ? undefined : "Off"}
              onClick={() => {
                open(s);
              }}
            />
          ))}
        </Group>
      ) : null}
      <Group note="Apply one to a message by typing /name.">
        <ActionRow
          icon={<Plus size={18} aria-hidden />}
          label="Create a skill"
          onClick={() => {
            open("new");
          }}
        />
      </Group>
      <Status error={skills.isError ? "Couldn’t load your skills." : null} />
    </>
  );
}
