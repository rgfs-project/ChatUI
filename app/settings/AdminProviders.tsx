import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plug, Plus, Trash2 } from "lucide-react";
import { useState, type FocusEvent, type SyntheticEvent } from "react";
import type { AdminProviderDto } from "@shared/admin";
import { ConfirmDialog, Switch } from "../components/ui";
import { api, messageOf } from "../lib/api";
import { keys } from "../lib/query";
import { ActionRow, FieldRow, formText, Group, LinkRow, Row, Status, useSubPage } from "./parts";

type Modality = "text" | "image" | "audio";
type Capabilities = AdminProviderDto["capabilities"];

const NEW_CAPS: Capabilities = { inputModalities: ["text"], reasoning: false, tools: false };

/** The capability switches, shared by a new and an existing provider. */
function CapabilityRows(props: {
  caps: Capabilities;
  sampling: boolean;
  onCaps: (caps: Capabilities) => void;
  onSampling: (on: boolean) => void;
  disabled?: boolean;
}) {
  const modality = (m: Modality, on: boolean) => {
    const list = props.caps.inputModalities.filter((x) => x !== m);
    props.onCaps({ ...props.caps, inputModalities: on ? [...list, m] : list });
  };
  return (
    <Group
      heading="Capabilities"
      note="Used when the provider doesn’t report them. llama.cpp sampling adds top-k, min-p and repeat penalty."
    >
      <Row label="Images">
        <Switch
          label="Images"
          disabled={props.disabled}
          checked={props.caps.inputModalities.includes("image")}
          onChange={(on) => {
            modality("image", on);
          }}
        />
      </Row>
      <Row label="Audio">
        <Switch
          label="Audio"
          disabled={props.disabled}
          checked={props.caps.inputModalities.includes("audio")}
          onChange={(on) => {
            modality("audio", on);
          }}
        />
      </Row>
      <Row label="Reasoning">
        <Switch
          label="Reasoning"
          disabled={props.disabled}
          checked={props.caps.reasoning}
          onChange={(on) => {
            props.onCaps({ ...props.caps, reasoning: on });
          }}
        />
      </Row>
      <Row label="Tools (memory suggestions)">
        <Switch
          label="Tools"
          disabled={props.disabled}
          checked={props.caps.tools}
          onChange={(on) => {
            props.onCaps({ ...props.caps, tools: on });
          }}
        />
      </Row>
      <Row label="llama.cpp sampling">
        <Switch
          label="llama.cpp sampling"
          disabled={props.disabled}
          checked={props.sampling}
          onChange={props.onSampling}
        />
      </Row>
    </Group>
  );
}

const numberOrNull = (text: string) => (text.trim() === "" ? null : Number(text));

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
  const [removing, setRemoving] = useState(false);
  const [newCaps, setNewCaps] = useState<Capabilities>(NEW_CAPS);
  const [newSampling, setNewSampling] = useState(false);
  const provider = view && view !== "new" ? providers.data?.find((p) => p.id === view) : undefined;
  const back = () => {
    setView(null);
    setError(null);
    setOk(null);
  };
  useSubPage(
    view === "new"
      ? { title: "New provider", onBack: back }
      : provider
        ? { title: provider.name, onBack: back }
        : null,
  );

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: key });
    await client.invalidateQueries({ queryKey: keys.models(props.userId) });
    await client.invalidateQueries({ queryKey: keys.admin(props.userId, "models") });
  };

  async function patch(body: Record<string, unknown>, success?: string) {
    if (!provider) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api(`/api/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        body,
      });
      await refresh();
      if (success) setOk(success);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  /** Saves one field when it loses focus, if it changed. */
  const saveOnBlur =
    (field: string, current: string, toValue: (text: string) => unknown = (t) => t.trim()) =>
    (e: FocusEvent<HTMLInputElement>) => {
      const text = e.currentTarget.value;
      if (text === current) return;
      const value = toValue(text);
      if (typeof value === "number" && Number.isNaN(value)) {
        setError("Numbers only, or leave it empty.");
        return;
      }
      void patch({ [field]: value });
    };

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const apiKey = formText(form, "apiKey");
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/providers", {
        method: "POST",
        body: {
          id: formText(form, "id").trim(),
          name: formText(form, "name").trim(),
          baseUrl: formText(form, "baseUrl").trim(),
          capabilities: newCaps,
          samplingExtensions: newSampling,
          ...(apiKey ? { apiKey } : {}),
        },
      });
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
      setRemoving(false);
      setView(null);
    } catch (e) {
      setError(messageOf(e));
      setRemoving(false);
    } finally {
      setBusy(false);
    }
  }

  if (view === "new")
    return (
      <form onSubmit={(e) => void create(e)}>
        <Group note="The ID is short and permanent, like “local”. The URL is an OpenAI-compatible endpoint.">
          <FieldRow
            label="ID"
            name="id"
            required
            maxLength={64}
            pattern="[a-z0-9][a-z0-9\-_]*"
            placeholder="local"
            autoCapitalize="none"
            spellCheck={false}
          />
          <FieldRow label="Name" name="name" required maxLength={100} placeholder="llama.cpp" />
          <FieldRow
            label="Base URL"
            name="baseUrl"
            required
            placeholder="http://127.0.0.1:8080/v1"
            inputMode="url"
            spellCheck={false}
          />
          <FieldRow
            label="API key"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder="None"
          />
        </Group>
        <CapabilityRows
          caps={newCaps}
          sampling={newSampling}
          onCaps={setNewCaps}
          onSampling={setNewSampling}
        />
        <Group>
          <button type="submit" className="row row-button action-row" disabled={busy}>
            <Plus size={18} aria-hidden />
            <span>Add provider</span>
          </button>
        </Group>
        <Status error={error} />
      </form>
    );

  if (provider) {
    const p = provider;
    return (
      <>
        <Group note={p.problem ?? "Leave the key empty to keep it."}>
          <FieldRow
            key={`name-${p.name}`}
            label="Name"
            defaultValue={p.name}
            maxLength={100}
            onBlur={saveOnBlur("name", p.name)}
          />
          <FieldRow
            key={`url-${p.baseUrl}`}
            label="Base URL"
            defaultValue={p.baseUrl}
            spellCheck={false}
            onBlur={saveOnBlur("baseUrl", p.baseUrl)}
          />
          <FieldRow
            label="API key"
            type="password"
            autoComplete="off"
            placeholder={p.hasApiKey ? "Saved" : "None"}
            onBlur={(e) => {
              const value = e.currentTarget.value;
              if (!value) return;
              e.currentTarget.value = "";
              void patch({ apiKey: value }, "Key saved.");
            }}
          />
        </Group>
        <CapabilityRows
          caps={p.capabilities}
          sampling={p.samplingExtensions}
          disabled={busy}
          onCaps={(caps) => void patch({ capabilities: caps })}
          onSampling={(on) => void patch({ samplingExtensions: on })}
        />
        <Group heading="Limits" note="Empty: the default (or what the provider reports).">
          <FieldRow
            key={`t-${String(p.timeoutMs)}`}
            label="Timeout (seconds)"
            inputMode="numeric"
            placeholder="Default"
            defaultValue={p.timeoutMs ? String(p.timeoutMs / 1000) : ""}
            onBlur={saveOnBlur("timeoutMs", p.timeoutMs ? String(p.timeoutMs / 1000) : "", (t) => {
              const n = numberOrNull(t);
              return n === null ? null : Math.round(n * 1000);
            })}
          />
          <FieldRow
            key={`a-${String(p.maxActiveGenerations)}`}
            label="Replies at once"
            inputMode="numeric"
            placeholder="No limit"
            defaultValue={p.maxActiveGenerations?.toString() ?? ""}
            onBlur={saveOnBlur(
              "maxActiveGenerations",
              p.maxActiveGenerations?.toString() ?? "",
              numberOrNull,
            )}
          />
          <FieldRow
            key={`c-${String(p.contextTokens)}`}
            label="Context window (tokens)"
            inputMode="numeric"
            placeholder="Discovered"
            defaultValue={p.contextTokens?.toString() ?? ""}
            onBlur={saveOnBlur("contextTokens", p.contextTokens?.toString() ?? "", numberOrNull)}
          />
        </Group>
        <Group>
          <ActionRow
            icon={<Plug size={18} aria-hidden />}
            label="Test connection"
            disabled={busy}
            onClick={() => void test()}
          />
          {p.hasApiKey ? (
            <ActionRow
              icon={<KeyRound size={18} aria-hidden />}
              label="Forget the saved key"
              disabled={busy}
              onClick={() => void patch({ clearApiKey: true }, "Key removed.")}
            />
          ) : null}
        </Group>
        <Group>
          <ActionRow
            danger
            icon={<Trash2 size={18} aria-hidden />}
            label="Remove provider"
            onClick={() => {
              setRemoving(true);
            }}
          />
        </Group>
        <Status error={error} ok={ok} />
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title="Remove provider?"
          description={`${p.name} and its model settings will be removed. Existing chats are kept.`}
          confirm="Remove"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </>
    );
  }

  return (
    <>
      {providers.data && providers.data.length > 0 ? (
        <Group>
          {providers.data.map((p) => (
            <LinkRow
              key={p.id}
              label={p.name}
              value={p.status === "invalid" ? "Problem" : "Enabled"}
              onClick={() => {
                setError(null);
                setOk(null);
                setView(p.id);
              }}
            />
          ))}
        </Group>
      ) : null}
      <Group note="Keys stay on the server and are never shown again.">
        <ActionRow
          icon={<Plus size={18} aria-hidden />}
          label="Add provider"
          onClick={() => {
            setNewCaps(NEW_CAPS);
            setNewSampling(false);
            setError(null);
            setView("new");
          }}
        />
      </Group>
      <Status error={providers.isError ? "Couldn’t load providers." : null} />
    </>
  );
}
