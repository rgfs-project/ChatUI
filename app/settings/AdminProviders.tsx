import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import type { AdminProviderDto } from "@shared/admin";
import { ConfirmDialog, Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { keys } from "../lib/query";
import { Field, Group, LinkRow, Status, SubHeader, parseOptionalNumber, formText } from "./parts";

type Modality = "text" | "image" | "audio";

export function AdminProviders(props: { userId: string }) {
  const client = useQueryClient();
  const key = keys.admin(props.userId, "providers");
  const providers = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<{ providers: AdminProviderDto[] }>("/api/admin/providers", { signal }),
    select: (d) => d.providers,
  });
  const [view, setView] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [modalities, setModalities] = useState<Modality[]>(["text"]);
  const [reasoning, setReasoning] = useState(false);
  const [tools, setTools] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [clearKey, setClearKey] = useState(false);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: key });
    await client.invalidateQueries({ queryKey: keys.models(props.userId) });
    await client.invalidateQueries({ queryKey: keys.admin(props.userId, "models") });
  };

  const open = (p: AdminProviderDto | "new") => {
    setError(null);
    setOk(null);
    setClearKey(false);
    if (p === "new") {
      setModalities(["text"]);
      setReasoning(false);
      setTools(false);
      setSampling(false);
      setView("new");
    } else {
      setModalities(p.capabilities.inputModalities);
      setReasoning(p.capabilities.reasoning);
      setTools(p.capabilities.tools);
      setSampling(p.samplingExtensions);
      setView(p.id);
    }
  };

  const provider = view && view !== "new" ? providers.data?.find((p) => p.id === view) : undefined;

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => formText(form, name).trim();
    const numbers = {
      timeoutMs: parseOptionalNumber(text("timeoutSec")),
      maxActiveGenerations: parseOptionalNumber(text("maxActive")),
      contextTokens: parseOptionalNumber(text("contextTokens")),
    };
    if (Object.values(numbers).some((n) => Number.isNaN(n))) {
      setError("Numbers only, or leave empty.");
      return;
    }
    const body: Record<string, unknown> = {
      name: text("name"),
      baseUrl: text("baseUrl"),
      timeoutMs: numbers.timeoutMs === null ? null : numbers.timeoutMs * 1000,
      maxActiveGenerations: numbers.maxActiveGenerations,
      contextTokens: numbers.contextTokens,
      samplingExtensions: sampling,
      capabilities: { inputModalities: modalities, reasoning, tools },
    };
    const apiKey = formText(form, "apiKey");
    if (apiKey) body.apiKey = apiKey;
    else if (clearKey) body.clearApiKey = true;
    setBusy(true);
    setError(null);
    try {
      if (view === "new") {
        const created = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
        await api("/api/admin/providers", { method: "POST", body: { id: text("id"), ...created } });
      } else if (provider) {
        await api(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
          method: "PATCH",
          body,
        });
      }
      await refresh();
      setView(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!provider) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const result = await api<{ ok: boolean; models: number; problem: string | null }>(
        `/api/admin/providers/${encodeURIComponent(provider.id)}/test`,
        { method: "POST" },
      );
      if (result.ok) setOk(`Connected. ${String(result.models)} models found.`);
      else setError(result.problem ?? "The provider didn’t answer.");
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!provider) return;
    setBusy(true);
    try {
      await api(`/api/admin/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      await refresh();
      setDeleting(false);
      setView(null);
    } catch (e) {
      setError(messageOf(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  }

  const toggleModality = (m: Modality, on: boolean) => {
    setModalities((list) => (on ? [...new Set([...list, m])] : list.filter((x) => x !== m)));
  };

  if (view === "new" || provider) {
    const p = provider;
    return (
      <>
        <SubHeader
          title={p?.name ?? "New provider"}
          backLabel="Providers"
          onBack={() => {
            setView(null);
          }}
        />
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          {p ? null : (
            <Field
              label="ID"
              name="id"
              required
              maxLength={64}
              pattern="[a-z0-9][a-z0-9\-_]*"
              hint="A short, permanent identifier, like “local”."
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
          <Field label="Name" name="name" defaultValue={p?.name ?? ""} required maxLength={100} />
          <Field
            label="Base URL"
            name="baseUrl"
            defaultValue={p?.baseUrl ?? ""}
            required
            placeholder="http://127.0.0.1:8080/v1"
            hint="An OpenAI-compatible endpoint."
            inputMode="url"
            spellCheck={false}
          />
          <Field
            label="API key"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={p?.hasApiKey ? "Saved — leave empty to keep" : "Optional"}
          />
          {p?.hasApiKey ? (
            <div className="field inline">
              <span>Remove the saved key</span>
              <Switch label="Remove the saved key" checked={clearKey} onChange={setClearKey} />
            </div>
          ) : null}
          <Field
            label="Timeout (seconds)"
            name="timeoutSec"
            inputMode="numeric"
            defaultValue={p?.timeoutMs ? String(p.timeoutMs / 1000) : ""}
            placeholder="Default"
          />
          <Field
            label="Replies at once"
            name="maxActive"
            inputMode="numeric"
            defaultValue={p?.maxActiveGenerations?.toString() ?? ""}
            placeholder="No limit"
          />
          <Field
            label="Context window (tokens)"
            name="contextTokens"
            inputMode="numeric"
            defaultValue={p?.contextTokens?.toString() ?? ""}
            placeholder="Discovered or default"
          />
          <h3 className="group-heading">Capabilities</h3>
          <div className="group">
            {(["image", "audio"] as const).map((m) => (
              <div className="row" key={m}>
                <span>{m === "image" ? "Image input" : "Audio input"}</span>
                <Switch
                  label={m === "image" ? "Image input" : "Audio input"}
                  checked={modalities.includes(m)}
                  onChange={(on) => {
                    toggleModality(m, on);
                  }}
                />
              </div>
            ))}
            <div className="row">
              <span>Reasoning</span>
              <Switch label="Reasoning" checked={reasoning} onChange={setReasoning} />
            </div>
            <div className="row">
              <span>Tools (memory suggestions)</span>
              <Switch label="Tools" checked={tools} onChange={setTools} />
            </div>
            <div className="row">
              <span>Extra sampling settings (top-k, min-p, repeat penalty)</span>
              <Switch label="Extra sampling settings" checked={sampling} onChange={setSampling} />
            </div>
          </div>
          <p className="field-hint">Used when the provider doesn’t report them itself.</p>
          {p?.problem ? <p className="error">{p.problem}</p> : null}
          <Status error={error} ok={ok} />
          <div className="form-actions sticky">
            {p ? (
              <>
                <button
                  type="button"
                  className="button danger-soft"
                  onClick={() => {
                    setDeleting(true);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void test()}
                >
                  Test connection
                </button>
              </>
            ) : null}
            <span className="spacer" />
            <button
              type="button"
              className="button"
              onClick={() => {
                setView(null);
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
          title="Delete provider?"
          description={`${p?.name ?? ""} and its model settings will be removed. Existing chats are kept.`}
          confirm="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </>
    );
  }

  return (
    <>
      <div className="section-toolbar">
        <p className="muted">
          Where models come from: OpenAI-compatible servers such as llama.cpp.
        </p>
        <button
          type="button"
          className="button primary small"
          onClick={() => {
            open("new");
          }}
        >
          Add provider
        </button>
      </div>
      <Group>
        {providers.data?.length === 0 ? <p className="row muted">No providers yet.</p> : null}
        {providers.data?.map((p) => (
          <LinkRow
            key={p.id}
            label={p.name}
            hint={p.baseUrl}
            value={p.status === "invalid" ? "Problem" : undefined}
            onClick={() => {
              open(p);
            }}
          />
        ))}
      </Group>
      <Status error={providers.isError ? "Couldn’t load providers." : null} />
    </>
  );
}
