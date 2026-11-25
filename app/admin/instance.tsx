import { RefreshCw, Wrench } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AdminSettings, AuditEntryDto } from "@shared/admin";
import { useChat } from "../chat/chat-context";
import { ModelMenu } from "../chat/model-picker";
import { apiJson } from "../lib/api";
import { FormActions, Row } from "../settings/row";
import { field, useAdminAction, useAdminQuery } from "./data";

const toMb = (bytes: number | null) =>
  bytes === null ? "" : String(Math.round((bytes / 1_048_576) * 100) / 100);

export function InstanceSection() {
  const { userId, groups, modelsState } = useChat();
  const settings = useAdminQuery<AdminSettings>(userId, "settings", "/api/admin/settings");
  const act = useAdminAction(userId);
  const [defaultModel, setDefaultModel] = useState<AdminSettings["defaultModel"] | undefined>(
    undefined,
  );
  const data = settings.data;
  if (!data) return <p className="settings-row-hint">Loading…</p>;
  const chosen = defaultModel === undefined ? data.defaultModel : defaultModel;

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const mode = field(form, "registrationMode");
    const tokens = field(form, "maxOutputTokens").trim();
    const notice = field(form, "notice").trim();
    const megabytes = (name: string) => {
      const value = field(form, name).trim();
      return value === "" ? null : Math.round(Number(value) * 1_048_576);
    };
    await act(
      () =>
        apiJson("/api/admin/settings", {
          method: "PATCH",
          json: {
            registrationMode: mode === "open" || mode === "closed" ? mode : null,
            notice: notice === "" ? null : notice,
            maxOutputTokens: tokens === "" ? null : Number(tokens),
            timeZone: field(form, "timeZone") || "UTC",
            defaultModel: chosen,
            maxAttachmentBytes: megabytes("maxAttachmentMb"),
            userQuotaBytes: megabytes("userQuotaMb"),
          },
        }),
      { done: "Instance settings saved.", refresh: ["settings", "audit"] },
    );
  }

  return (
    <form
      className="settings-card"
      aria-label="Instance settings"
      onSubmit={(event) => void save(event)}
    >
      <Row label="Registration" hint="Who can create an account." labelFor="admin-registration">
        <select
          id="admin-registration"
          name="registrationMode"
          className="pill-button pill-select native-select"
          defaultValue={data.registrationMode ?? "env"}
        >
          <option value="env">As configured on the server</option>
          <option value="closed">Closed: admins create accounts</option>
          <option value="open">Open: anyone can sign up</option>
        </select>
      </Row>
      <Row label="Default model for new chats" hint="Members can still pick another.">
        <ModelMenu
          label="Instance default model"
          triggerClassName="pill-button pill-select"
          groups={groups}
          selected={chosen ? [chosen.providerId, chosen.modelId] : null}
          loading={modelsState === "loading"}
          extraOption="None (first available)"
          onSelect={(pair) => {
            setDefaultModel(pair ? { providerId: pair[0], modelId: pair[1] } : null);
          }}
        />
      </Row>
      <Row
        label="Notice for everyone (optional)"
        hint="Shown above the chat until each member dismisses it."
        labelFor="admin-notice"
        stacked
      >
        <textarea
          id="admin-notice"
          name="notice"
          className="text-field settings-textarea selectable"
          rows={2}
          maxLength={500}
          defaultValue={data.notice ?? ""}
        />
      </Row>
      <Row label="Output limit (tokens)" labelFor="admin-tokens">
        <input
          id="admin-tokens"
          name="maxOutputTokens"
          type="number"
          min={16}
          className="text-field settings-input"
          defaultValue={data.maxOutputTokens ?? ""}
          placeholder="Server default"
        />
      </Row>
      <Row label="Time zone" hint="Used for dates in chats." labelFor="admin-time-zone">
        <input
          id="admin-time-zone"
          name="timeZone"
          className="text-field settings-input selectable"
          defaultValue={data.timeZone}
        />
      </Row>
      <Row label="Largest file (MB)" labelFor="admin-attachment">
        <input
          id="admin-attachment"
          name="maxAttachmentMb"
          type="number"
          min={1}
          step="any"
          className="text-field settings-input"
          defaultValue={toMb(data.maxAttachmentBytes)}
          placeholder="Server default"
        />
      </Row>
      <Row label="Storage per account (MB)" labelFor="admin-quota">
        <input
          id="admin-quota"
          name="userQuotaMb"
          type="number"
          min={1}
          step="any"
          className="text-field settings-input"
          defaultValue={toMb(data.userQuotaBytes)}
          placeholder="Server default"
        />
      </Row>
      <FormActions>
        <button type="submit" className="pill-button pill-primary">
          Save
        </button>
      </FormActions>
    </form>
  );
}

export function MaintenanceSection() {
  const { userId } = useChat();
  const act = useAdminAction(userId);
  return (
    <>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Rebuild chat indexes</span>
            <span className="settings-row-hint">
              Re-reads every account's Markdown files. Nothing is lost.
            </span>
          </div>
          <button
            type="button"
            className="pill-button"
            onClick={() =>
              void act(
                () => apiJson("/api/admin/maintenance/rebuild-index", { method: "POST", json: {} }),
                { done: "Indexes rebuilt.", refresh: ["users", "audit"] },
              )
            }
          >
            <Wrench size={16} aria-hidden /> Rebuild
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Refresh model discovery</span>
            <span className="settings-row-hint">Asks every provider for its models now.</span>
          </div>
          <button
            type="button"
            className="pill-button"
            onClick={() =>
              void act(() => apiJson("/api/admin/models/refresh", { method: "POST" }), {
                done: "Models refreshed.",
                refresh: ["models", "audit"],
              })
            }
          >
            <RefreshCw size={16} aria-hidden /> Refresh
          </button>
        </div>
      </div>
      <p className="settings-row-hint admin-note">
        Operator commands (create users, reset passwords, rebuild indexes):{" "}
        <kbd>node server/cli.ts help</kbd>
      </p>
    </>
  );
}

export function AuditSection() {
  const { userId } = useChat();
  const audit = useAdminQuery<{ entries: AuditEntryDto[] }>(userId, "audit", "/api/admin/audit");
  return (
    <div className="settings-card">
      <table className="admin-table" aria-label="Audit log">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {audit.data?.entries.map((entry, i) => (
            <tr key={`${entry.at}-${String(i)}`}>
              <td className="selectable">{entry.at.replace("T", " ").slice(0, 19)}</td>
              <td>{entry.actor.username}</td>
              <td className="selectable">
                {entry.action}
                {entry.target.id ? (
                  <span className="admin-muted"> · {entry.target.id.slice(0, 12)}</span>
                ) : null}
              </td>
              <td className={entry.outcome === "ok" ? "" : "admin-error"}>{entry.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {audit.data?.entries.length === 0 ? (
        <p className="settings-row-hint admin-empty">No changes yet.</p>
      ) : null}
    </div>
  );
}
