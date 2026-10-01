import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ScrollText, Search } from "lucide-react";
import "./skills.css";
import { useState, type SyntheticEvent } from "react";
import { SKILL_LIMITS, type SkillDto } from "@shared/skills";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";

/**
 * Settings → Customize → Skills (user request, Phase 10): the user's named
 * instruction sets. An enabled skill appears in the composer's "/" list;
 * starting a message with "/name" applies it to that message.
 */
export function SkillsSettings({ userId }: { userId: string }) {
  const skills = useQuery(queries.skills(userId));
  const [view, setView] = useState<{ kind: "list" } | { kind: "edit"; id: string | null }>({
    kind: "list",
  });
  if (view.kind === "edit") {
    const skill = view.id ? skills.data?.find((s) => s.id === view.id) : undefined;
    return (
      <SkillEditor
        key={view.id ?? "new"}
        userId={userId}
        skill={skill}
        onDone={() => {
          setView({ kind: "list" });
        }}
      />
    );
  }
  return (
    <SkillList
      userId={userId}
      skills={skills.data}
      loading={skills.isPending}
      error={skills.isError && !skills.data}
      onRetry={() => void skills.refetch()}
      onOpen={(id) => {
        setView({ kind: "edit", id });
      }}
    />
  );
}

function useSkillMutations(userId: string) {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries({ queryKey: queryKeys.skills(userId) });
  return {
    save: useMutation({
      mutationFn: (input: { id: string | null; body: Record<string, unknown> }) =>
        input.id
          ? apiJson<SkillDto>(`/api/skills/${encodeURIComponent(input.id)}`, {
              method: "PATCH",
              body: JSON.stringify(input.body),
            })
          : apiJson<SkillDto>("/api/skills", {
              method: "POST",
              body: JSON.stringify(input.body),
            }),
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) =>
        apiJson(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
      onSettled: settle,
    }),
  };
}

function Switch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="switch"
      disabled={props.disabled}
      onClick={() => {
        props.onChange(!props.checked);
      }}
    >
      <span className="switch-thumb" aria-hidden />
    </button>
  );
}

function SkillList(props: {
  userId: string;
  skills: SkillDto[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpen: (id: string | null) => void;
}) {
  const { save } = useSkillMutations(props.userId);
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const shown = (props.skills ?? []).filter(
    (s) => q === "" || s.name.includes(q) || s.description.toLowerCase().includes(q),
  );
  return (
    <section className="settings-body" aria-labelledby="settings-skills">
      <div className="skills-head">
        <h2 id="settings-skills">Skills</h2>
        <label className="skills-search">
          <Search size={16} aria-hidden />
          <span className="visually-hidden">Search skills</span>
          <input
            type="search"
            placeholder="Search skills"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
          />
        </label>
        {props.skills?.length === 0 ? null : (
          <button
            type="button"
            onClick={() => {
              props.onOpen(null);
            }}
          >
            <Plus size={16} aria-hidden /> Add
          </button>
        )}
      </div>
      {props.loading ? (
        <p className="settings-hint">Loading skills…</p>
      ) : props.error ? (
        <p className="settings-hint" role="alert">
          Skills couldn’t be loaded.{" "}
          <button type="button" className="link-button" onClick={props.onRetry}>
            Try again
          </button>
        </p>
      ) : props.skills?.length === 0 ? (
        <div className="skills-empty" data-testid="skills-empty">
          <h3>Add your first skill</h3>
          <p>
            Skills are instructions you can apply to any message. Type <kbd>/</kbd> in the message
            box and pick one, or start a message with <code>/name</code>.
          </p>
          <button
            type="button"
            onClick={() => {
              props.onOpen(null);
            }}
          >
            Create a skill
          </button>
        </div>
      ) : (
        <ul className="skills-list" aria-label="Your skills">
          {shown.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                className="skill-row"
                onClick={() => {
                  props.onOpen(skill.id);
                }}
              >
                <span className="skill-icon" aria-hidden>
                  <ScrollText size={18} />
                </span>
                <span className="skill-text">
                  <span className="skill-name">/{skill.name}</span>
                  <span className="skill-description">
                    {skill.description || skill.instructions}
                  </span>
                </span>
              </button>
              <Switch
                checked={skill.enabled}
                label={`Enable ${skill.name}`}
                disabled={save.isPending}
                onChange={(enabled) => {
                  save.mutate({ id: skill.id, body: { enabled } });
                }}
              />
            </li>
          ))}
          {shown.length === 0 ? <li className="settings-hint">No skills match.</li> : null}
        </ul>
      )}
    </section>
  );
}

function SkillEditor(props: { userId: string; skill: SkillDto | undefined; onDone: () => void }) {
  const { save, remove } = useSkillMutations(props.userId);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const skill = props.skill;

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    setError(null);
    save.mutate(
      {
        id: skill?.id ?? null,
        body: {
          name: text("name").trim().replace(/^\//, ""),
          description: text("description"),
          instructions: text("instructions"),
          enabled: form.get("enabled") === "on",
        },
      },
      {
        onSuccess: props.onDone,
        onError: (e) => {
          setError(e instanceof ApiError ? e.message : "The skill couldn’t be saved.");
        },
      },
    );
  }

  return (
    <section className="settings-body" aria-labelledby="skill-editor-title">
      <button type="button" className="link-back" onClick={props.onDone}>
        <ArrowLeft size={16} aria-hidden /> Your skills
      </button>
      <h2 id="skill-editor-title">{skill ? `/${skill.name}` : "New skill"}</h2>
      <form className="skill-form" onSubmit={submit}>
        <label htmlFor="skill-name">Name</label>
        <div className="skill-name-field">
          <span aria-hidden>/</span>
          <input
            id="skill-name"
            name="name"
            required
            maxLength={SKILL_LIMITS.nameLength}
            pattern="[a-z0-9][a-z0-9\-]*"
            defaultValue={skill?.name ?? ""}
            aria-describedby="skill-name-hint"
            autoComplete="off"
          />
        </div>
        <p className="settings-hint" id="skill-name-hint">
          Lowercase letters, digits and hyphens. You’ll type it as <code>/name</code>.
        </p>
        <label htmlFor="skill-description">Description</label>
        <input
          id="skill-description"
          name="description"
          maxLength={SKILL_LIMITS.descriptionLength}
          defaultValue={skill?.description ?? ""}
          placeholder="Shown in the / list"
        />
        <label htmlFor="skill-instructions">Instructions</label>
        <textarea
          id="skill-instructions"
          name="instructions"
          required
          rows={10}
          maxLength={SKILL_LIMITS.instructionsLength}
          defaultValue={skill?.instructions ?? ""}
          placeholder="What the model should do when you use this skill"
        />
        <label className="skill-enabled">
          <input type="checkbox" name="enabled" defaultChecked={skill?.enabled ?? true} />
          Show in the <kbd>/</kbd> list
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          {skill ? (
            confirming ? (
              <button
                type="button"
                className="secondary danger-outline"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(skill.id, { onSuccess: props.onDone });
                }}
              >
                Confirm delete
              </button>
            ) : (
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Delete
              </button>
            )
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
    </section>
  );
}
