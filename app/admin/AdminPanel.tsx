import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import type { AdminModelSettings, AdminProviderDto, AdminUserDto } from "@shared/admin";
import { ConfirmDialog } from "../components/Dialogs";
import { Spinner } from "../components/Spinner";
import { useUserId } from "../lib/auth-store";
import { ApiError, apiJson } from "../lib/query";
import { adminKeys, adminQueries, adminWrite } from "./api";
import type { AdminSectionId } from "./sections";
import "./admin.css";

const TITLES: Record<AdminSectionId, { title: string; hint: string }> = {
  users: {
    title: "Users",
    hint: "Accounts on this server, their role and whether they can sign in.",
  },
  providers: {
    title: "Providers",
    hint: "Model servers ChatUI connects to. Keys stay on the server and are never shown again.",
  },
  models: {
    title: "Models",
    hint: "What users can choose in the composer, and each model's sampling and system prompt.",
  },
  instance: {
    title: "Instance settings",
    hint: "Registration, the default model, the time zone and generation limits.",
  },
  maintenance: { title: "Maintenance", hint: "Safe repairs of derived data." },
  audit: { title: "Audit log", hint: "Every administrative change: who, what and the outcome." },
};

/**
 * Administration (Phase 10), shown as Settings sections. Its own chunk, loaded
 * only when an administrator opens one. Hiding controls is cosmetic: the
 * server authorizes every request (INV-24).
 */
export default function AdminSection({ section }: { section: AdminSectionId }) {
  const { title, hint } = TITLES[section];
  const headingId = `admin-${section}-title`;
  return (
    <section
      className="settings-body admin-section"
      aria-labelledby={headingId}
      data-testid={`admin-section-${section}`}
    >
      <header className="settings-header">
        <h2 id={headingId}>{title}</h2>
        <p className="settings-hint">{hint}</p>
      </header>
      {section === "users" ? (
        <UsersTab />
      ) : section === "providers" ? (
        <ProvidersTab />
      ) : section === "models" ? (
        <ModelsTab />
      ) : section === "instance" ? (
        <SettingsTab />
      ) : section === "maintenance" ? (
        <MaintenanceTab />
      ) : (
        <AuditTab />
      )}
    </section>
  );
}

/** Runs an admin action and reports its outcome in a live region. */
function useAction() {
  const client = useQueryClient();
  const userId = useUserId();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(
    label: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<T | undefined> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await adminWrite<T>(client, userId, method, url, body);
      setMessage(`${label}: done.`);
      return result;
    } catch (error) {
      setMessage(`${label} failed: ${error instanceof ApiError ? error.message : "network error"}`);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  const status: ReactNode = (
    <p className="admin-note" role="status" aria-live="polite" data-testid="admin-status">
      {message ?? ""}
    </p>
  );
  return { run, busy, status };
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

// ---- users ---------------------------------------------------------------

function UsersTab() {
  const userId = useUserId();
  const users = useQuery(adminQueries.users(userId));
  const { run, busy, status } = useAction();
  const [password, setPassword] = useState<AdminUserDto | null>(null);
  const [deleting, setDeleting] = useState<AdminUserDto | null>(null);
  const [confirmName, setConfirmName] = useState("");

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    // currentTarget is null once the event has been dispatched: keep the element.
    const element = event.currentTarget;
    const form = new FormData(element);
    const created = await run("Create user", "POST", "/api/admin/users", {
      username: formValue(form, "username"),
      password: formValue(form, "password"),
      role: formValue(form, "role"),
    });
    if (created) element.reset();
  }

  return (
    <div className="admin-pane">
      {status}
      {users.isPending ? <Spinner label="Loading users…" /> : null}
      <div className="admin-table-wrap" hidden={users.isPending}>
        <table className="admin-table stack" data-testid="admin-users">
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col" className="col-end">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>
                  <select
                    aria-label={`Role of ${u.username}`}
                    value={u.role}
                    disabled={busy}
                    onChange={(event) =>
                      void run("Change role", "PATCH", `/api/admin/users/${u.id}`, {
                        role: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`Status of ${u.username}`}
                    value={u.status}
                    disabled={busy}
                    onChange={(event) =>
                      void run("Change status", "PATCH", `/api/admin/users/${u.id}`, {
                        status: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </td>
                <td className="admin-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setPassword(u);
                    }}
                  >
                    Set password
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirmName("");
                      setDeleting(u);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="admin-form" onSubmit={(e) => void create(e)} aria-label="Create user">
        <label>
          Username
          <input name="username" required autoComplete="off" />
        </label>
        <label>
          Initial password
          <input name="password" type="password" required autoComplete="new-password" />
        </label>
        <label>
          Role
          <select name="role" defaultValue="user">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Create user
        </button>
      </form>
      {password ? (
        <form
          className="admin-form"
          aria-label={`New password for ${password.username}`}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run("Set password", "POST", `/api/admin/users/${password.id}/password`, {
              password: formValue(form, "password"),
            }).then((done) => {
              if (done) setPassword(null);
            });
          }}
        >
          <label>
            New password for {password.username} (signs them out everywhere)
            <input name="password" type="password" required autoComplete="new-password" />
          </label>
          <button type="submit" disabled={busy}>
            Save password
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPassword(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.username ?? ""}?`}
        description={
          <>
            All of this account’s conversations and data are permanently removed. Type{" "}
            <strong>{deleting?.username}</strong> to confirm.
            <input
              aria-label="Type the username to confirm"
              value={confirmName}
              onChange={(event) => {
                setConfirmName(event.currentTarget.value);
              }}
            />
          </>
        }
        confirmLabel="Delete account"
        onConfirm={() => {
          if (deleting)
            void run("Delete user", "DELETE", `/api/admin/users/${deleting.id}`, {
              confirmUsername: confirmName,
            });
        }}
      />
    </div>
  );
}

// ---- providers -------------------------------------------------------------

function ProvidersTab() {
  const userId = useUserId();
  const providers = useQuery(adminQueries.providers(userId));
  const { run, busy, status } = useAction();
  const [editing, setEditing] = useState<AdminProviderDto | null>(null);
  // The form stays hidden until "Add provider" or a row's "Edit".
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<AdminProviderDto | null>(null);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const apiKey = formValue(form, "apiKey");
    const common = {
      name: formValue(form, "name"),
      baseUrl: formValue(form, "baseUrl"),
      samplingExtensions: form.get("samplingExtensions") === "on",
      capabilities: {
        inputModalities: ["text", ...(form.get("image") === "on" ? ["image"] : [])],
        reasoning: form.get("reasoning") === "on",
        tools: false,
      },
    };
    const done = editing
      ? await run("Save provider", "PATCH", `/api/admin/providers/${editing.id}`, {
          ...common,
          ...(apiKey ? { apiKey } : {}),
          ...(form.get("clearApiKey") === "on" ? { clearApiKey: true } : {}),
        })
      : await run("Add provider", "POST", "/api/admin/providers", {
          id: formValue(form, "id"),
          ...common,
          ...(apiKey ? { apiKey } : {}),
        });
    if (done) {
      setEditing(null);
      setFormOpen(false);
      element.reset();
    }
  }

  return (
    <div className="admin-pane">
      {status}
      {providers.isPending ? <Spinner label="Loading providers…" /> : null}
      <div className="admin-table-wrap" hidden={providers.isPending}>
        <table className="admin-table stack" data-testid="admin-providers">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Status</th>
              <th scope="col" className="col-end">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {(providers.data ?? []).map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="cell-title">{p.name}</span>
                  <span className="cell-meta">{p.id}</span>
                </td>
                <td>
                  {p.status === "enabled" ? (
                    "Enabled"
                  ) : (
                    <>
                      <span className="cell-title">Invalid</span>
                      {p.problem ? <span className="cell-meta">{p.problem}</span> : null}
                    </>
                  )}
                </td>
                <td className="admin-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run("Test connection", "POST", `/api/admin/providers/${p.id}/test`)
                    }
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setEditing(p);
                      setFormOpen(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setRemoving(p);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {formOpen ? null : (
        <div className="admin-after-table">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            Add provider
          </button>
        </div>
      )}
      {formOpen ? (
        <form
          key={editing?.id ?? "new"}
          className="admin-form"
          aria-label={editing ? `Edit ${editing.name}` : "Add provider"}
          onSubmit={(e) => void save(e)}
        >
          {editing ? null : (
            <label>
              Id
              <input name="id" required pattern="[a-z0-9][a-z0-9_-]{0,63}" />
            </label>
          )}
          <label>
            Name
            <input name="name" required defaultValue={editing?.name ?? ""} />
          </label>
          <label>
            Base URL
            <input name="baseUrl" required defaultValue={editing?.baseUrl ?? ""} />
          </label>
          <label>
            API key {editing?.hasApiKey ? "(leave empty to keep)" : "(optional)"}
            <input name="apiKey" type="password" autoComplete="off" />
          </label>
          {editing?.hasApiKey ? (
            <label className="toggle-row">
              <span>Remove the stored key</span>
              <input className="toggle" name="clearApiKey" type="checkbox" />
            </label>
          ) : null}
          <label className="toggle-row">
            <span>llama.cpp sampling (top-k, min-p, repeat penalty)</span>
            <input
              className="toggle"
              name="samplingExtensions"
              type="checkbox"
              defaultChecked={editing?.samplingExtensions ?? true}
            />
          </label>
          <label className="toggle-row">
            <span>Accepts images</span>
            <input
              className="toggle"
              name="image"
              type="checkbox"
              defaultChecked={editing?.capabilities.inputModalities.includes("image") ?? false}
            />
          </label>
          <label className="toggle-row">
            <span>Reasoning</span>
            <input
              className="toggle"
              name="reasoning"
              type="checkbox"
              defaultChecked={editing?.capabilities.reasoning ?? false}
            />
          </label>
          <button type="submit" disabled={busy}>
            {editing ? "Save provider" : "Add provider"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEditing(null);
              setFormOpen(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {formOpen ? (
        <p className="admin-note">
          Every save re-checks the endpoint against the network policy; keys are never shown again.
        </p>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ""}?`}
        description="Its models disappear from the model list immediately."
        confirmLabel="Remove provider"
        onConfirm={() => {
          if (removing)
            void run("Remove provider", "DELETE", `/api/admin/providers/${removing.id}`);
        }}
      />
    </div>
  );
}

// ---- models ------------------------------------------------------------------

function ModelsTab() {
  const userId = useUserId();
  const client = useQueryClient();
  const models = useQuery(adminQueries.models(userId));
  const { run, busy, status } = useAction();
  const [editing, setEditing] = useState<{ providerId: string; modelId: string } | null>(null);
  const settingsFor = (providerId: string, modelId: string): AdminModelSettings | undefined =>
    models.data?.settings.find((s) => s.providerId === providerId && s.modelId === modelId);
  const current = editing ? settingsFor(editing.providerId, editing.modelId) : undefined;

  function numberOrNull(form: FormData, name: string): number | null {
    const raw = formValue(form, name).trim();
    return raw === "" ? null : Number(raw);
  }

  return (
    <div className="admin-pane">
      {status}
      {models.isPending ? <Spinner label="Loading models…" /> : null}
      <div className="admin-table-wrap" hidden={models.isPending}>
        <table className="admin-table" data-testid="admin-models">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="col-end">
                <span className="visually-hidden">Settings</span>
              </th>
              <th scope="col" className="col-end">
                Visible
              </th>
            </tr>
          </thead>
          <tbody>
            {(models.data?.providers ?? []).flatMap((group) =>
              group.models.map((m) => {
                const s = settingsFor(m.providerId, m.id);
                return (
                  <tr key={`${m.providerId}/${m.id}`}>
                    <td>
                      <span className="cell-title">{m.id}</span>
                      <span className="cell-meta">{group.provider.name}</span>
                    </td>
                    <td className="col-end">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setEditing({ providerId: m.providerId, modelId: m.id });
                        }}
                      >
                        Edit
                      </button>
                    </td>
                    <td className="col-end">
                      {/* Uncontrolled (toggles at once), re-synced by key when the server answers. */}
                      <input
                        key={String(s?.hidden === true)}
                        type="checkbox"
                        className="toggle"
                        // Takes effect at once: a switch, not a form checkbox.
                        role="switch"
                        aria-label={`${m.id} (${group.provider.name}) visible to users`}
                        defaultChecked={s?.hidden !== true}
                        disabled={busy}
                        onChange={(event) =>
                          void run("Visibility", "PUT", "/api/admin/model-settings", {
                            providerId: m.providerId,
                            modelId: m.id,
                            hidden: !event.currentTarget.checked,
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
      <div className="admin-after-table">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            // Forces discovery on every provider, then shows the fresh lists.
            void apiJson<NonNullable<typeof models.data>>("/api/admin/models?refresh=1").then(
              (data) => {
                client.setQueryData(adminKeys.models(userId), data);
              },
              () => undefined,
            );
          }}
        >
          Refresh discovery
        </button>
      </div>
      {editing ? (
        <form
          key={`${editing.providerId}/${editing.modelId}`}
          className="admin-form"
          aria-label={`Settings for ${editing.modelId}`}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const systemPrompt = formValue(form, "systemPrompt");
            void run("Save model settings", "PUT", "/api/admin/model-settings", {
              providerId: editing.providerId,
              modelId: editing.modelId,
              temperature: numberOrNull(form, "temperature"),
              topP: numberOrNull(form, "topP"),
              topK: numberOrNull(form, "topK"),
              minP: numberOrNull(form, "minP"),
              repeatPenalty: numberOrNull(form, "repeatPenalty"),
              systemPrompt: systemPrompt === "" ? null : systemPrompt,
              timeContext: form.get("timeContext") === "on",
            }).then((done) => {
              if (done) setEditing(null);
            });
          }}
        >
          {(
            [
              ["temperature", "Temperature (0–2)", "0.05"],
              ["topP", "Top-p (0–1]", "0.01"],
              ["topK", "Top-k", "1"],
              ["minP", "Min-p (0–1)", "0.01"],
              ["repeatPenalty", "Repeat penalty (0.5–2)", "0.05"],
            ] as const
          ).map(([name, label, step]) => (
            <label key={name}>
              {label}
              <input name={name} type="number" step={step} defaultValue={current?.[name] ?? ""} />
            </label>
          ))}
          <label style={{ gridColumn: "1 / -1" }}>
            System prompt (variables: {"{{username}}"}, {"{{date}}"}, {"{{timezone}}"})
            <textarea name="systemPrompt" rows={4} defaultValue={current?.systemPrompt ?? ""} />
          </label>
          <label className="toggle-row">
            <span>Tell the model the current time</span>
            <input
              className="toggle"
              name="timeContext"
              type="checkbox"
              defaultChecked={current?.timeContext ?? false}
            />
          </label>
          <button type="submit" disabled={busy}>
            Save settings
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEditing(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
    </div>
  );
}

// ---- settings ----------------------------------------------------------------

function SettingsTab() {
  const userId = useUserId();
  const settings = useQuery(adminQueries.settings(userId));
  const models = useQuery(adminQueries.models(userId));
  const { run, busy, status } = useAction();
  const s = settings.data;
  if (!s) return <Spinner label="Loading settings…" />;
  const pairs = (models.data?.providers ?? []).flatMap((g) =>
    g.models.map((m) => JSON.stringify([m.providerId, m.id])),
  );
  return (
    <div className="admin-pane">
      {status}
      {s.problem ? (
        <p role="alert">settings.json could not be read ({s.problem}); defaults are in effect.</p>
      ) : null}
      <form
        key={JSON.stringify(s)}
        className="admin-form"
        aria-label="Instance settings"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const model = formValue(form, "defaultModel");
          const parsed = model ? (JSON.parse(model) as [string, string]) : null;
          const num = (name: string) => {
            const raw = formValue(form, name).trim();
            return raw === "" ? null : Number(raw);
          };
          void run("Save settings", "PATCH", "/api/admin/settings", {
            registrationMode: formValue(form, "registrationMode"),
            defaultModel: parsed ? { providerId: parsed[0], modelId: parsed[1] } : null,
            timezone: formValue(form, "timezone"),
            generation: {
              maxActivePerUser: num("maxActivePerUser"),
              maxOutputTokens: num("maxOutputTokens"),
            },
            // Blank fields fall back to the environment defaults (shown as placeholders).
            attachments: {
              maxFileBytes: mib(num("maxFileMiB")),
              maxPerMessage: num("maxPerMessage"),
              quotaBytes: mib(num("quotaMiB")),
              textInlineBytes: num("textInlineBytes"),
            },
          });
        }}
      >
        <label>
          Registration (
          {s.registrationModeSource === "settings" ? "saved setting" : "from environment"})
          <select name="registrationMode" defaultValue={s.registrationMode}>
            <option value="closed">Closed</option>
            <option value="open">Open</option>
          </select>
        </label>
        <label>
          Default model
          <select
            name="defaultModel"
            defaultValue={
              s.defaultModel
                ? JSON.stringify([s.defaultModel.providerId, s.defaultModel.modelId])
                : ""
            }
          >
            <option value="">None</option>
            {pairs.map((p) => (
              <option key={p} value={p}>
                {(JSON.parse(p) as [string, string]).join(" / ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Time zone (IANA)
          <input name="timezone" defaultValue={s.timezone} />
        </label>
        <label>
          Max active generations per user
          <input
            name="maxActivePerUser"
            type="number"
            min={1}
            max={32}
            defaultValue={s.generation.maxActivePerUser ?? ""}
          />
        </label>
        <label>
          Max output tokens
          <input
            name="maxOutputTokens"
            type="number"
            min={16}
            max={65536}
            defaultValue={s.generation.maxOutputTokens ?? ""}
          />
        </label>
        <fieldset className="admin-fieldset">
          <legend>Attachments (blank: environment default)</legend>
          <label>
            Max file size (MiB)
            <input
              name="maxFileMiB"
              type="number"
              min={0.001}
              step="any"
              placeholder={toMib(s.attachmentDefaults.maxFileBytes)}
              defaultValue={s.attachments.maxFileBytes ? toMib(s.attachments.maxFileBytes) : ""}
            />
          </label>
          <label>
            Max attachments per message
            <input
              name="maxPerMessage"
              type="number"
              min={1}
              max={10}
              placeholder={String(s.attachmentDefaults.maxPerMessage)}
              defaultValue={s.attachments.maxPerMessage ?? ""}
            />
          </label>
          <label>
            Storage per user (MiB)
            <input
              name="quotaMiB"
              type="number"
              min={0.001}
              step="any"
              placeholder={toMib(s.attachmentDefaults.quotaBytes)}
              defaultValue={s.attachments.quotaBytes ? toMib(s.attachments.quotaBytes) : ""}
            />
          </label>
          <label>
            Text inlined per attachment (bytes)
            <input
              name="textInlineBytes"
              type="number"
              min={256}
              max={10000000}
              placeholder={String(s.attachmentDefaults.textInlineBytes)}
              defaultValue={s.attachments.textInlineBytes ?? ""}
            />
          </label>
        </fieldset>
        <button type="submit" disabled={busy}>
          Save settings
        </button>
      </form>
    </div>
  );
}

const MIB = 1024 * 1024;
const mib = (value: number | null) => (value === null ? null : Math.round(value * MIB));
const toMib = (bytes: number) => String(Math.round((bytes / MIB) * 1000) / 1000);

// ---- maintenance and audit ----------------------------------------------------

function MaintenanceTab() {
  const userId = useUserId();
  const users = useQuery(adminQueries.users(userId));
  const { run, busy, status } = useAction();
  const [confirm, setConfirm] = useState(false);
  const [target, setTarget] = useState("");
  return (
    <div className="admin-pane">
      {status}
      <form
        className="admin-form"
        aria-label="Rebuild conversation index"
        onSubmit={(event) => {
          event.preventDefault();
          setTarget(formValue(new FormData(event.currentTarget), "userId"));
          setConfirm(true);
        }}
      >
        <label>
          Rebuild the conversation index for
          <select name="userId" defaultValue="">
            <option value="">Every user</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Rebuild index
        </button>
      </form>
      <p className="admin-note">
        The index is derived from the conversation files and is always safe to rebuild.
      </p>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Rebuild the conversation index?"
        description="Conversation lists are recomputed from the canonical files."
        confirmLabel="Rebuild"
        onConfirm={() =>
          void run(
            "Rebuild index",
            "POST",
            "/api/admin/maintenance/rebuild-index",
            target ? { userId: target } : {},
          )
        }
      />
    </div>
  );
}

function AuditTab() {
  const userId = useUserId();
  const audit = useQuery(adminQueries.audit(userId));
  return (
    <div className="admin-pane">
      {audit.isPending ? <Spinner label="Loading the audit log…" /> : null}
      <div className="admin-table-wrap" hidden={audit.isPending}>
        <table className="admin-table stack" data-testid="admin-audit">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Admin</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data ?? []).map((e) => (
              <tr key={`${e.time}-${e.action}-${e.target.id ?? ""}`}>
                <td>{e.time.replace("T", " ").slice(0, 19)}</td>
                <td>{e.actor.username}</td>
                <td>
                  {e.action}
                  {e.fields ? <span className="admin-note"> ({e.fields.join(", ")})</span> : null}
                </td>
                <td>{e.target.label ?? e.target.id ?? e.target.type}</td>
                <td>{e.outcome === "success" ? "Succeeded" : `Failed (${e.code ?? "error"})`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
