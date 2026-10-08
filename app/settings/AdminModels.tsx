import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AdminModelSettings } from "@shared/admin";
import type { ModelDto, ProviderModelsDto } from "@shared/generations";
import { Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { modelLabel } from "../lib/models";
import { keys } from "../lib/query";
import {
  Field,
  Group,
  LinkRow,
  Status,
  SubHeader,
  TextArea,
  parseOptionalNumber,
  formText,
} from "./parts";

interface AdminModels {
  providers: ProviderModelsDto[];
  settings: AdminModelSettings[];
}

const NUMBERS = [
  { key: "temperature", label: "Temperature" },
  { key: "topP", label: "Top-p" },
  { key: "topK", label: "Top-k" },
  { key: "minP", label: "Min-p" },
  { key: "repeatPenalty", label: "Repeat penalty" },
] as const;

export function AdminModelsSection(props: { userId: string }) {
  const client = useQueryClient();
  const key = keys.admin(props.userId, "models");
  const [refreshing, setRefreshing] = useState(false);
  const models = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<AdminModels>("/api/admin/models", { signal }),
  });
  const [open, setOpen] = useState<ModelDto | null>(null);
  const [hidden, setHidden] = useState(false);
  const [timeContext, setTimeContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const settingsOf = (m: ModelDto) =>
    models.data?.settings.find((s) => s.providerId === m.providerId && s.modelId === m.id) ?? null;

  async function refresh() {
    setRefreshing(true);
    try {
      client.setQueryData(key, await api<AdminModels>("/api/admin/models?refresh=1"));
      await client.invalidateQueries({ queryKey: keys.models(props.userId) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      providerId: open.providerId,
      modelId: open.id,
      hidden,
      timeContext,
    };
    for (const { key: k, label } of NUMBERS) {
      const value = parseOptionalNumber(formText(form, k));
      if (Number.isNaN(value)) {
        setError(`${label}: numbers only, or leave empty.`);
        return;
      }
      body[k] = value;
    }
    const prompt = formText(form, "systemPrompt");
    body.systemPrompt = prompt.trim() === "" ? null : prompt;
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/model-settings", { method: "PUT", body });
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: keys.models(props.userId) });
      setOpen(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    const s = settingsOf(open);
    return (
      <>
        <SubHeader
          title={modelLabel(open.id)}
          backLabel="Models"
          onBack={() => {
            setOpen(null);
          }}
        />
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <Group>
            <div className="row">
              <span>Hidden from members</span>
              <Switch label="Hidden from members" checked={hidden} onChange={setHidden} />
            </div>
            <div className="row">
              <span className="row-label">
                <span>Tell the model the date and time</span>
              </span>
              <Switch
                label="Tell the model the date and time"
                checked={timeContext}
                onChange={setTimeContext}
              />
            </div>
          </Group>
          <p className="muted small">
            {open.providerId} · {open.id} · {open.contextTokens.toLocaleString()} tokens of context
          </p>
          <h3 className="group-heading">Sampling (empty: the model’s default)</h3>
          <div className="field-grid">
            {NUMBERS.map(({ key: k, label }) => (
              <Field
                key={k}
                label={label}
                name={k}
                inputMode="decimal"
                defaultValue={s?.[k]?.toString() ?? ""}
              />
            ))}
          </div>
          <TextArea
            label="System prompt"
            name="systemPrompt"
            rows={6}
            defaultValue={s?.systemPrompt ?? ""}
            hint="Sent before every chat with this model."
          />
          <Status error={error} />
          <div className="form-actions sticky">
            <span className="spacer" />
            <button
              type="button"
              className="button"
              onClick={() => {
                setOpen(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <div className="section-toolbar">
        <p className="muted">Models your providers offer. Hide one, or tune how it answers.</p>
        <button
          type="button"
          className="button small"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} aria-hidden />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {models.data?.providers.map((group) => (
        <Group
          key={group.provider.id}
          heading={`${group.provider.name}${group.stale ? " · may be out of date" : ""}`}
        >
          {group.models.length === 0 ? <p className="row muted">No models found.</p> : null}
          {group.models.map((m) => {
            const s = settingsOf(m);
            return (
              <LinkRow
                key={m.id}
                label={modelLabel(m.id)}
                hint={modelLabel(m.id) === m.id ? undefined : m.id}
                value={s?.hidden ? "Hidden" : undefined}
                onClick={() => {
                  setHidden(s?.hidden ?? false);
                  setTimeContext(s?.timeContext ?? false);
                  setError(null);
                  setOpen(m);
                }}
              />
            );
          })}
        </Group>
      ))}
      {models.data?.providers.length === 0 ? <p className="muted">Add a provider first.</p> : null}
      <Status error={error ?? (models.isError ? "Couldn’t load models." : null)} />
    </>
  );
}
