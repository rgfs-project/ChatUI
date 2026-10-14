import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ScrollText, Search } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { SKILL_LIMITS, type SkillDto } from "@shared/skills";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { ConfirmDialog } from "./Dialogs";
import "./skills.css";

/**
 * Settings → Skills: named instruction sets. An enabled skill is in the
 * composer's "/" list, and starting a message with "/name" applies it.
 */
export function SkillsSettings({ userId }: { userId: string }) {
  const skills = useQuery(queries.skills(userId));
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  if (editing) {
    const skill = editing.id ? skills.data?.find((s) => s.id === editing.id) : undefined;
    return (
      <SkillEditor
        key={editing.id ?? "new"}
        userId={userId}
        skill={skill}
        onDone={() => {
          setEditing(null);
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
        setEditing({ id });
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
          : apiJson<SkillDto>("/api/skills", { method: "POST", body: JSON.stringify(input.body) }),
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) =>
        apiJson(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
      onSettled: settle,
    }),
  };
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
  const any = (props.skills?.length ?? 0) > 0;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Skills</h1>
        {any ? (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              props.onOpen(null);
            }}
          >
            <Plus size={16} aria-hidden /> Add a skill
          </button>
        ) : null}
      </div>
      {props.loading ? (
        <p className="hint">Loading skills…</p>
      ) : props.error ? (
        <div className="alert danger" role="alert">
          <span className="alert-text">Skills couldn’t be loaded.</span>
          <button type="button" className="btn" onClick={props.onRetry}>
            Try again
          </button>
        </div>
      ) : !any ? (
        <section className="group" data-testid="skills-empty">
          <div className="row">
            <div className="row-text">
              <h2 className="row-label">Add your first skill</h2>
              <p className="row-hint">
                Instructions you can apply to any message. Type <kbd>/</kbd> in the message box and
                pick one.
              </p>
            </div>
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                props.onOpen(null);
              }}
            >
              Create a skill
            </button>
          </div>
        </section>
      ) : (
        <section className="section">
          <label className="search-field">
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
          <ul className="group" aria-label="Your skills">
            {shown.map((skill) => (
              <li key={skill.id} className="row skill-row">
                <button
                  type="button"
                  className="skill-open"
                  onClick={() => {
                    props.onOpen(skill.id);
                  }}
                >
                  <span className="file-icon" aria-hidden>
                    <ScrollText size={18} />
                  </span>
                  <span className="row-text">
                    <span className="row-label skill-name">/{skill.name}</span>
                    <span className="row-hint skill-description">
                      {skill.description || skill.instructions}
                    </span>
                  </span>
                </button>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  aria-label={`Enable ${skill.name}`}
                  checked={skill.enabled}
                  disabled={save.isPending}
                  onChange={(event) => {
                    save.mutate({ id: skill.id, body: { enabled: event.currentTarget.checked } });
                  }}
                />
              </li>
            ))}
            {shown.length === 0 ? <li className="row row-hint">No skills match.</li> : null}
          </ul>
        </section>
      )}
    </>
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
    <>
      <button type="button" className="back-link" onClick={props.onDone}>
        <ArrowLeft size={16} aria-hidden /> Skills
      </button>
      <h1 className="page-title">{skill ? `/${skill.name}` : "New skill"}</h1>
      <form className="section skill-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="skill-name">
            Name
          </label>
          <div className="input prefixed">
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
          <p className="hint field-hint" id="skill-name-hint">
            Lowercase letters, digits and hyphens.
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="skill-description">
            Description
          </label>
          <input
            id="skill-description"
            name="description"
            className="input"
            maxLength={SKILL_LIMITS.descriptionLength}
            defaultValue={skill?.description ?? ""}
            placeholder="Shown in the / list"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="skill-instructions">
            Instructions
          </label>
          <textarea
            id="skill-instructions"
            name="instructions"
            className="textarea"
            required
            rows={10}
            maxLength={SKILL_LIMITS.instructionsLength}
            defaultValue={skill?.instructions ?? ""}
            placeholder="What the model should do when you use this skill"
          />
        </div>
        <label className="check-line">
          <input
            type="checkbox"
            role="switch"
            className="switch"
            name="enabled"
            defaultChecked={skill?.enabled ?? true}
          />
          Show in the <kbd>/</kbd> list
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          {skill ? (
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
      {skill ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Delete /${skill.name}?`}
          description="It’s removed from the / list. Messages that used it keep their text."
          confirmLabel="Delete"
          onConfirm={() => {
            remove.mutate(skill.id, { onSuccess: props.onDone });
          }}
        />
      ) : null}
    </>
  );
}
