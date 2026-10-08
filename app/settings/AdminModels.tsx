import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AdminModelSettings, AdminProviderDto } from "@shared/admin";
import type { ModelDto, ProviderModelsDto } from "@shared/generations";
import { Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { modelLabel } from "../lib/models";
import { keys } from "../lib/query";
import {
  ActionRow,
  Group,
  LinkRow,
  NumberChoice,
  Row,
  Status,
  TextAreaRow,
  useSubPage,
} from "./parts";

interface AdminModels {
  providers: ProviderModelsDto[];
  settings: AdminModelSettings[];
}

type SamplingKey = "temperature" | "topP" | "topK" | "minP" | "repeatPenalty";

const SAMPLING: { key: SamplingKey; label: string; presets: number[]; extended?: boolean }[] = [
  { key: "temperature", label: "Temperature", presets: [0.2, 0.7, 1, 1.5] },
  { key: "topP", label: "Top-p", presets: [0.8, 0.9, 0.95, 1] },
  { key: "topK", label: "Top-k", presets: [20, 40, 64, 100], extended: true },
  { key: "minP", label: "Min-p", presets: [0, 0.05, 0.1], extended: true },
  { key: "repeatPenalty", label: "Repeat penalty", presets: [1, 1.05, 1.1, 1.2], extended: true },
];

export function AdminModelsSection(props: { userId: string }) {
  const client = useQueryClient();
  const key = keys.admin(props.userId, "models");
  const [refreshing, setRefreshing] = useState(false);
  const models = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<AdminModels>("/api/admin/models", { signal }),
  });
  const providers = useQuery({
    queryKey: keys.admin(props.userId, "providers"),
    queryFn: ({ signal }) =>
      api<{ providers: AdminProviderDto[] }>("/api/admin/providers", { signal }),
    select: (d) => d.providers,
  });
  const [open, setOpen] = useState<ModelDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useSubPage(
    open
      ? {
          title: modelLabel(open.id),
          onBack: () => {
            setOpen(null);
            setError(null);
          },
        }
      : null,
  );

  const settingsOf = (m: ModelDto) =>
    models.data?.settings.find((s) => s.providerId === m.providerId && s.modelId === m.id) ?? null;

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      client.setQueryData(key, await api<AdminModels>("/api/admin/models?refresh=1"));
      await client.invalidateQueries({ queryKey: keys.models(props.userId) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setRefreshing(false);
    }
  }

  /** Saves one or more overrides at once; null removes an override. */
  async function save(m: ModelDto, change: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/model-settings", {
        method: "PUT",
        body: { providerId: m.providerId, modelId: m.id, ...change },
      });
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: keys.models(props.userId) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    const s = settingsOf(open);
    const extended =
      providers.data?.find((p) => p.id === open.providerId)?.samplingExtensions ?? false;
    return (
      <>
        <Group
          note={`${open.providerId} · ${open.id} · ${open.contextTokens.toLocaleString()} tokens of context`}
        >
          <Row label="Shown to users">
            <Switch
              label="Shown to users"
              checked={!(s?.hidden ?? false)}
              disabled={busy}
              onChange={(on) => void save(open, { hidden: !on })}
            />
          </Row>
        </Group>
        <Group
          heading="Sampling"
          note={
            extended
              ? "Default: the provider’s own value."
              : "Default: the provider’s own value. Top-k, min-p and repeat penalty need llama.cpp sampling on the provider."
          }
        >
          {SAMPLING.map(({ key: k, label, presets, extended: ext }) => (
            <Row key={k} label={label} id={`m-${k}`}>
              <NumberChoice
                labelledBy={`m-${k}`}
                value={s?.[k] ?? null}
                presets={presets}
                format={String}
                nullLabel="Default"
                disabled={busy || (ext === true && !extended)}
                onChange={(v) => void save(open, { [k]: v })}
              />
            </Row>
          ))}
        </Group>
        <Group heading="System prompt">
          <TextAreaRow
            key={s?.systemPrompt ?? ""}
            label="System prompt"
            rows={3}
            placeholder="None"
            defaultValue={s?.systemPrompt ?? ""}
            onBlur={(e) => {
              const text = e.currentTarget.value;
              if (text === (s?.systemPrompt ?? "")) return;
              void save(open, { systemPrompt: text.trim() === "" ? null : text });
            }}
          />
          <Row label="Tell the model the time">
            <Switch
              label="Tell the model the time"
              checked={s?.timeContext ?? false}
              disabled={busy}
              onChange={(on) => void save(open, { timeContext: on })}
            />
          </Row>
        </Group>
        <Status error={error} />
      </>
    );
  }

  return (
    <>
      {models.data?.providers.map((group) => (
        <Group
          key={group.provider.id}
          heading={`${group.provider.name}${group.stale ? " · may be out of date" : ""}`}
        >
          {group.models.length === 0 ? <Row label="No models found." /> : null}
          {group.models.map((m) => (
            <LinkRow
              key={m.id}
              label={modelLabel(m.id)}
              hint={modelLabel(m.id) === m.id ? undefined : m.id}
              value={settingsOf(m)?.hidden ? "Hidden" : undefined}
              onClick={() => {
                setError(null);
                setOpen(m);
              }}
            />
          ))}
        </Group>
      ))}
      <Group note={models.data?.providers.length === 0 ? "Add a provider first." : undefined}>
        <ActionRow
          icon={<RefreshCw size={18} aria-hidden />}
          label={refreshing ? "Refreshing…" : "Refresh discovery"}
          disabled={refreshing}
          onClick={() => void refresh()}
        />
      </Group>
      <Status error={error ?? (models.isError ? "Couldn’t load models." : null)} />
    </>
  );
}
