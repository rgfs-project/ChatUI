import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import type { AdminSettingsDto, AuditEntryDto } from "@shared/admin";
import { api, messageOf } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { allModels, modelLabel } from "../lib/models";
import { keys, useModels } from "../lib/query";
import { Choice, Field, Group, Row, Status, parseOptionalNumber, formText } from "./parts";

export function AdminInstance(props: { userId: string }) {
  const client = useQueryClient();
  const key = keys.admin(props.userId, "settings");
  const settings = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<AdminSettingsDto>("/api/admin/settings", { signal }),
  });
  const models = useModels(props.userId);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState<"open" | "closed" | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);

  const s = settings.data;
  if (!s) return <Status error={settings.isError ? "Couldn’t load settings." : null} />;

  const modelOptions = [
    { value: "", label: "None" },
    ...allModels(models.data).map((m) => ({
      value: JSON.stringify([m.providerId, m.id]),
      label: modelLabel(m.id),
    })),
  ];
  const currentModel =
    defaultModel ??
    (s.defaultModel ? JSON.stringify([s.defaultModel.providerId, s.defaultModel.modelId]) : "");

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const num = (name: string, scale = 1) => {
      const v = parseOptionalNumber(formText(form, name));
      return v === null || Number.isNaN(v) ? v : Math.round(v * scale);
    };
    const fields = {
      maxActivePerUser: num("maxActivePerUser"),
      maxOutputTokens: num("maxOutputTokens"),
      maxFileBytes: num("maxFileMb", 1024 * 1024),
      maxPerMessage: num("maxPerMessage"),
      quotaBytes: num("quotaMb", 1024 * 1024),
      textInlineBytes: num("textInlineKb", 1024),
    };
    if (Object.values(fields).some((v) => Number.isNaN(v))) {
      setError("Numbers only, or leave empty for the default.");
      return;
    }
    const [providerId, modelId] = currentModel
      ? (JSON.parse(currentModel) as [string, string])
      : [];
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const next = await api<AdminSettingsDto>("/api/admin/settings", {
        method: "PATCH",
        body: {
          ...(registration ? { registrationMode: registration } : {}),
          defaultModel: providerId && modelId ? { providerId, modelId } : null,
          timezone: formText(form, "timezone").trim(),
          generation: {
            maxActivePerUser: fields.maxActivePerUser,
            maxOutputTokens: fields.maxOutputTokens,
          },
          attachments: {
            maxFileBytes: fields.maxFileBytes,
            maxPerMessage: fields.maxPerMessage,
            quotaBytes: fields.quotaBytes,
            textInlineBytes: fields.textInlineBytes,
          },
        },
      });
      client.setQueryData(key, next);
      await client.invalidateQueries({ queryKey: keys.models(props.userId) });
      setOk("Saved.");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const d = s.attachmentDefaults;
  const mb = (bytes: number | null) =>
    bytes === null ? "" : String(Math.round((bytes / 1024 / 1024) * 100) / 100);
  return (
    <form className="settings-form" onSubmit={(e) => void save(e)}>
      {s.problem ? <p className="error">{s.problem}</p> : null}
      <Group heading="Access">
        <Row
          label="New accounts"
          id="i-reg"
          hint={
            s.registrationModeSource === "environment"
              ? "Set by the server environment until changed here."
              : undefined
          }
        >
          <Choice
            labelledBy="i-reg"
            value={registration ?? s.registrationMode}
            options={[
              { value: "closed", label: "Administrators create them" },
              { value: "open", label: "Anyone can sign up" },
            ]}
            onChange={setRegistration}
          />
        </Row>
        <Row label="Default model" id="i-model">
          <Choice
            labelledBy="i-model"
            value={currentModel}
            options={modelOptions}
            onChange={setDefaultModel}
          />
        </Row>
      </Group>
      <h3 className="group-heading">Replies</h3>
      <div className="field-grid">
        <Field label="Time zone" name="timezone" defaultValue={s.timezone} placeholder="UTC" />
        <Field
          label="Replies at once per user"
          name="maxActivePerUser"
          inputMode="numeric"
          defaultValue={s.generation.maxActivePerUser?.toString() ?? ""}
          placeholder="Default"
        />
        <Field
          label="Longest reply (tokens)"
          name="maxOutputTokens"
          inputMode="numeric"
          defaultValue={s.generation.maxOutputTokens?.toString() ?? ""}
          placeholder="Default"
        />
      </div>
      <h3 className="group-heading">Attachments (empty: the default)</h3>
      <div className="field-grid">
        <Field
          label="Largest file (MB)"
          name="maxFileMb"
          inputMode="decimal"
          defaultValue={mb(s.attachments.maxFileBytes)}
          placeholder={formatBytes(d.maxFileBytes)}
        />
        <Field
          label="Files per message"
          name="maxPerMessage"
          inputMode="numeric"
          defaultValue={s.attachments.maxPerMessage?.toString() ?? ""}
          placeholder={String(d.maxPerMessage)}
        />
        <Field
          label="Storage per user (MB)"
          name="quotaMb"
          inputMode="decimal"
          defaultValue={mb(s.attachments.quotaBytes)}
          placeholder={formatBytes(d.quotaBytes)}
        />
        <Field
          label="Text sent inline (KB)"
          name="textInlineKb"
          inputMode="decimal"
          defaultValue={
            s.attachments.textInlineBytes === null
              ? ""
              : String(s.attachments.textInlineBytes / 1024)
          }
          placeholder={formatBytes(d.textInlineBytes)}
        />
      </div>
      <Status error={error} ok={ok} />
      <div className="form-actions sticky">
        <span className="spacer" />
        <button type="submit" className="button primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

export function AdminMaintenance() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function rebuild() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ conversations: number }>("/api/admin/maintenance/rebuild-index", {
        method: "POST",
        body: {},
      });
      setResult(`Rebuilt. ${String(r.conversations)} conversations indexed.`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Group note="Rereads every conversation file to rebuild the chat lists and search. Safe to run at any time; it can take a while on large instances.">
        <Row label="Rebuild the conversation index">
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => void rebuild()}
          >
            {busy ? "Rebuilding…" : "Rebuild"}
          </button>
        </Row>
      </Group>
      <Status error={error} ok={result} />
    </>
  );
}

export function AdminAudit(props: { userId: string }) {
  const audit = useQuery({
    queryKey: keys.admin(props.userId, "audit"),
    queryFn: ({ signal }) =>
      api<{ entries: AuditEntryDto[] }>("/api/admin/audit?limit=200", { signal }),
    select: (d) => d.entries,
  });
  return (
    <>
      <p className="muted section-intro">
        Administrative changes, newest first. Values are never recorded.
      </p>
      <Group>
        {audit.data?.length === 0 ? <p className="row muted">Nothing yet.</p> : null}
        {audit.data?.map((e, i) => (
          <Row
            key={`${e.time}-${String(i)}`}
            label={
              <>
                {e.action}
                {e.target.label || e.target.id ? ` · ${e.target.label ?? e.target.id ?? ""}` : ""}
              </>
            }
            hint={`${formatDateTime(e.time)} · ${e.actor.username}${e.fields?.length ? ` · ${e.fields.join(", ")}` : ""}`}
          >
            <span className={e.outcome === "success" ? "muted" : "danger-text"}>
              {e.outcome === "success" ? "Done" : `Failed${e.code ? ` (${e.code})` : ""}`}
            </span>
          </Row>
        ))}
      </Group>
      {audit.isError ? <Status error="Couldn’t load the audit log." /> : null}
    </>
  );
}
