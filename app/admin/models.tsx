import { Pencil } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AdminModel } from "@shared/admin";
import { useChat } from "../chat/chat-context";
import { apiJson } from "../lib/api";
import { Dialog } from "../ui/dialog";
import { field, useAdminAction, useAdminQuery } from "./data";

const SAMPLING = [
  { key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.05 },
  { key: "topP", label: "Top P", min: 0.01, max: 1, step: 0.01 },
  { key: "topK", label: "Top K", min: 0, max: 1000, step: 1 },
  { key: "minP", label: "Min P", min: 0, max: 1, step: 0.01 },
  { key: "repeatPenalty", label: "Repeat penalty", min: 0.5, max: 2, step: 0.05 },
] as const;

export function ModelsSection() {
  const { userId } = useChat();
  const models = useAdminQuery<{ models: AdminModel[] }>(userId, "models", "/api/admin/models");
  const act = useAdminAction(userId);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<AdminModel | null>(null);

  const put = (settings: AdminModel["settings"]) =>
    act(() => apiJson("/api/admin/models", { method: "PUT", json: settings }), {
      done: "Model settings saved.",
      refresh: ["models", "audit"],
    });

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const sampling: Record<string, number> = {};
    for (const s of SAMPLING) {
      const raw = field(form, s.key).trim();
      if (raw !== "") sampling[s.key] = Number(raw);
    }
    const prompt = field(form, "systemPrompt");
    const ok = await put({
      ...editing.settings,
      sampling,
      systemPrompt: prompt.trim() === "" ? null : prompt,
    });
    if (ok) setEditing(null);
  }

  return (
    <>
      <table className="admin-table" aria-label="Models">
        <thead>
          <tr>
            <th>Model</th>
            <th>Provider</th>
            <th>Visible</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {models.data?.models.map((model) => (
            <tr key={`${model.providerId}/${model.modelId}`}>
              <td className="selectable">
                {model.modelId}
                {model.settings.systemPrompt ? <span className="admin-badge">prompt</span> : null}
              </td>
              <td>{model.providerName}</td>
              <td>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  aria-label={`Show ${model.modelId} to members`}
                  checked={
                    !(override[`${model.providerId}/${model.modelId}`] ?? model.settings.hidden)
                  }
                  onChange={(event) => {
                    const hidden = !event.target.checked;
                    // Optimistic and synchronous: a controlled switch must not snap back.
                    setOverride((o) => ({
                      ...o,
                      [`${model.providerId}/${model.modelId}`]: hidden,
                    }));
                    void put({ ...model.settings, hidden }).finally(() => {
                      setOverride((o) => {
                        const { [`${model.providerId}/${model.modelId}`]: _done, ...rest } = o;
                        return rest;
                      });
                    });
                  }}
                />
              </td>
              <td className="admin-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Configure ${model.modelId}`}
                  onClick={() => {
                    setEditing(model);
                  }}
                >
                  <Pencil size={16} aria-hidden />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {models.data?.models.length === 0 ? (
        <p className="settings-row-hint">No models discovered yet. Check the providers.</p>
      ) : null}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing ? editing.modelId : ""}
        className="admin-dialog"
      >
        {editing ? (
          <form className="dialog-form" onSubmit={(event) => void save(event)}>
            <div className="admin-fields">
              {SAMPLING.map((s) => (
                <label key={s.key}>
                  {s.label}
                  <input
                    name={s.key}
                    type="number"
                    className="text-field"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    placeholder="model default"
                    defaultValue={editing.settings.sampling[s.key] ?? ""}
                  />
                </label>
              ))}
            </div>
            <label htmlFor="admin-system-prompt">System prompt</label>
            <textarea
              id="admin-system-prompt"
              name="systemPrompt"
              className="text-field admin-textarea selectable"
              rows={6}
              defaultValue={editing.settings.systemPrompt ?? ""}
            />
            <p className="settings-row-hint">
              Variables: {"{{username}}"}, {"{{date}}"}, {"{{timezone}}"}, and {"{{time}}"} (sent
              next to the newest message, so the prompt prefix stays cacheable).
            </p>
            <div className="dialog-actions">
              <button type="submit" className="pill-button pill-primary">
                Save
              </button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
