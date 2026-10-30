import { Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AdminProvider } from "@shared/admin";
import { useChat } from "../chat/chat-context";
import { apiJson } from "../lib/api";
import { Dialog, useConfirm } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { field, useAdminAction, useAdminQuery } from "./data";

type Editing = { mode: "create" } | { mode: "edit"; provider: AdminProvider };

function numberOrUndefined(value: FormDataEntryValue | null): number | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : Number(text);
}

export function ProvidersSection() {
  const { userId } = useChat();
  const providers = useAdminQuery<{ providers: AdminProvider[] }>(
    userId,
    "providers",
    "/api/admin/providers",
  );
  const act = useAdminAction(userId);
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const modalities = [
      "text",
      ...(form.get("image") ? ["image"] : []),
      ...(form.get("audio") ? ["audio"] : []),
    ];
    const common = {
      name: field(form, "name"),
      baseUrl: field(form, "baseUrl"),
      capabilities: {
        inputModalities: modalities,
        reasoning: form.get("reasoning") !== null,
        tools: form.get("tools") !== null,
      },
      timeoutMs: numberOrUndefined(form.get("timeoutMs")),
      maxActiveGenerations: numberOrUndefined(form.get("maxActive")),
      contextTokens: numberOrUndefined(form.get("contextTokens")),
    };
    const apiKey = field(form, "apiKey");
    const json =
      editing.mode === "create"
        ? {
            id: field(form, "id"),
            kind: "openai-compatible",
            ...common,
            ...(apiKey ? { apiKey } : {}),
          }
        : {
            ...common,
            ...(apiKey ? { apiKey } : {}),
            ...(form.get("clearApiKey") ? { clearApiKey: true } : {}),
          };
    const clean = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
    const ok = await act(
      () =>
        editing.mode === "create"
          ? apiJson("/api/admin/providers", { method: "POST", json: clean })
          : apiJson(`/api/admin/providers/${editing.provider.id}`, {
              method: "PATCH",
              json: clean,
            }),
      { done: "Provider saved.", refresh: ["providers", "models", "audit"] },
    );
    if (ok) setEditing(null);
  }

  async function test(provider: AdminProvider) {
    const result = await act(
      () =>
        apiJson<{ ok: boolean; models: number; message: string }>(
          `/api/admin/providers/${provider.id}/test`,
          { method: "POST" },
        ),
      { refresh: ["audit"] },
    );
    if (result)
      toast(
        result.ok ? `Connected: ${String(result.models)} model(s).` : result.message,
        result.ok ? "info" : "error",
      );
  }

  async function remove(provider: AdminProvider) {
    const yes = await confirm({
      title: `Remove ${provider.name}?`,
      body: "Its models stop being available. Existing chats keep their history.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (yes)
      await act(() => apiJson(`/api/admin/providers/${provider.id}`, { method: "DELETE" }), {
        done: "Provider removed.",
        refresh: ["providers", "models", "audit"],
      });
  }

  const current = editing?.mode === "edit" ? editing.provider : null;
  return (
    <>
      <div className="admin-toolbar">
        <button
          type="button"
          className="pill-button"
          onClick={() => {
            setEditing({ mode: "create" });
          }}
        >
          <Plus size={16} aria-hidden /> Add provider
        </button>
      </div>
      <table className="admin-table" aria-label="Providers">
        <thead>
          <tr>
            <th>Name</th>
            <th>Endpoint</th>
            <th>API key</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {providers.data?.providers.map((provider) => (
            <tr key={provider.id}>
              <td>
                {provider.name}
                <span className="admin-muted"> · {provider.id}</span>
              </td>
              <td className="selectable admin-url">{provider.baseUrl}</td>
              <td>{provider.hasApiKey ? "Set" : "None"}</td>
              <td className="admin-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Test ${provider.name}`}
                  onClick={() => void test(provider)}
                >
                  <Plug size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${provider.name}`}
                  onClick={() => {
                    setEditing({ mode: "edit", provider });
                  }}
                >
                  <Pencil size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${provider.name}`}
                  onClick={() => void remove(provider)}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={current ? `Edit ${current.name}` : "Add provider"}
        className="admin-dialog"
      >
        <form className="dialog-form admin-provider-form" onSubmit={(event) => void save(event)}>
          {current ? null : (
            <label>
              Id (a–z, 0–9, _ -)
              <input
                name="id"
                className="text-field selectable"
                required
                pattern="[a-z0-9][a-z0-9_-]{0,63}"
              />
            </label>
          )}
          <label>
            Name
            <input
              name="name"
              className="text-field selectable"
              required
              defaultValue={current?.name}
            />
          </label>
          <label>
            Base URL (OpenAI-compatible)
            <input
              name="baseUrl"
              className="text-field selectable"
              required
              defaultValue={current?.baseUrl}
              placeholder="http://llama:8080"
            />
          </label>
          <label>
            API key {current?.hasApiKey ? "(set: leave empty to keep it)" : "(optional)"}
            <input
              name="apiKey"
              type="password"
              className="text-field selectable"
              autoComplete="off"
            />
          </label>
          {current?.hasApiKey ? (
            <label className="admin-check">
              <input type="checkbox" name="clearApiKey" /> Remove the stored key
            </label>
          ) : null}
          <fieldset className="admin-checks">
            <legend>Capabilities</legend>
            <label className="admin-check">
              <input
                type="checkbox"
                name="image"
                defaultChecked={current?.capabilities.inputModalities.includes("image")}
              />{" "}
              Images
            </label>
            <label className="admin-check">
              <input
                type="checkbox"
                name="audio"
                defaultChecked={current?.capabilities.inputModalities.includes("audio")}
              />{" "}
              Audio
            </label>
            <label className="admin-check">
              <input
                type="checkbox"
                name="reasoning"
                defaultChecked={current?.capabilities.reasoning}
              />{" "}
              Reasoning
            </label>
            <label className="admin-check">
              <input type="checkbox" name="tools" defaultChecked={current?.capabilities.tools} />{" "}
              Tools
            </label>
          </fieldset>
          <div className="admin-fields">
            <label>
              Timeout (ms)
              <input
                name="timeoutMs"
                type="number"
                min={1000}
                className="text-field"
                defaultValue={current?.timeoutMs ?? ""}
              />
            </label>
            <label>
              Parallel replies
              <input
                name="maxActive"
                type="number"
                min={1}
                className="text-field"
                defaultValue={current?.maxActiveGenerations ?? ""}
              />
            </label>
            <label>
              Context tokens
              <input
                name="contextTokens"
                type="number"
                min={256}
                className="text-field"
                defaultValue={current?.contextTokens ?? ""}
              />
            </label>
          </div>
          <div className="dialog-actions">
            <button type="submit" className="pill-button pill-primary">
              Save
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
