import { useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { SKILL_LIMITS, type SkillDto } from "@shared/skills";
import { ConfirmDialog, Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { keys, useSkills } from "../lib/query";
import { Empty, Field, Group, LinkRow, Status, SubHeader, TextArea, formText } from "./parts";

export function Skills(props: { userId: string }) {
  const client = useQueryClient();
  const skills = useSkills(props.userId);
  const [editing, setEditing] = useState<SkillDto | "new" | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      <>
        <SubHeader
          title={skill ? `/${skill.name}` : "New skill"}
          backLabel="Skills"
          onBack={() => {
            setEditing(null);
          }}
        />
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <Field
            label="Name"
            name="name"
            defaultValue={skill?.name ?? ""}
            required
            maxLength={SKILL_LIMITS.nameLength}
            pattern="[a-z0-9][a-z0-9\-]*"
            hint="Type /name at the start of a message to use it. Lowercase letters, digits and hyphens."
            autoCapitalize="none"
            spellCheck={false}
          />
          <Field
            label="Description"
            name="description"
            defaultValue={skill?.description ?? ""}
            maxLength={SKILL_LIMITS.descriptionLength}
          />
          <TextArea
            label="Instructions"
            name="instructions"
            defaultValue={skill?.instructions ?? ""}
            required
            rows={10}
            maxLength={SKILL_LIMITS.instructionsLength}
            hint="Sent to the model with the message that uses this skill."
          />
          <div className="field inline">
            <span>Enabled</span>
            <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
          </div>
          <Status error={error} />
          <div className="form-actions">
            {skill ? (
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
          title="Delete skill?"
          description={`/${skill?.name ?? ""} will be deleted.`}
          confirm="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </>
    );
  }

  const list = skills.data ?? [];
  return (
    <>
      <div className="section-toolbar">
        <p className="muted">Saved instructions you apply with a slash command, like /summarize.</p>
        <button
          type="button"
          className="button primary small"
          onClick={() => {
            open("new");
          }}
        >
          New skill
        </button>
      </div>
      {skills.isSuccess && list.length === 0 ? (
        <Empty title="No skills yet">Create one, then type “/” in a message to use it.</Empty>
      ) : (
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
      )}
      <Status error={skills.isError ? "Couldn’t load your skills." : null} />
    </>
  );
}
