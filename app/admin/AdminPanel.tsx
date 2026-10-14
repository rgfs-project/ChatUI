import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import {
  LOG_LEVELS,
  LOG_RETENTION_DAYS,
  type AdminModelSettings,
  type AdminProviderDto,
  type AdminUserDto,
  type LogEntryDto,
  type LogLevel,
} from "@shared/admin";
import { Avatar } from "../components/AccountLabel";
import { ConfirmDialog, DialogClose, DialogFrame } from "../components/Dialogs";
import { Spinner } from "../components/Spinner";
import { useUserId } from "../lib/auth-store";
import { ApiError, apiJson } from "../lib/query";
import { adminKeys, adminQueries, adminWrite } from "./api";
import type { AdminSectionId } from "./sections";
import "./admin.css";

const TITLES: Record<AdminSectionId, string> = {
  users: "Users",
  providers: "Providers",
  models: "Models",
  instance: "Instance",
  maintenance: "Maintenance",
  logs: "Logs",
};

/**
 * Administration, as Settings sections (its own chunk, loaded when an
 * administrator opens one). Hiding controls is cosmetic: the server
 * authorizes every request (INV-24).
 */
export default function AdminSection({ section }: { section: AdminSectionId }) {
  return (
    <div className="admin" data-testid={`admin-section-${section}`}>
      {section === "logs" ? (
        <LogsSection />
      ) : (
        <>
          <h1 className="page-title">{TITLES[section]}</h1>
          {section === "users" ? (
            <UsersSection />
          ) : section === "providers" ? (
            <ProvidersSection />
          ) : section === "models" ? (
            <ModelsSection />
          ) : section === "instance" ? (
            <InstanceSection />
          ) : (
            <MaintenanceSection />
          )}
        </>
      )}
    </div>
  );
}

/** Runs an admin change and reports how it went in a live region. */
function useAction() {
  const client = useQueryClient();
  const userId = useUserId();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
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
      setMessage({ text: `${label}: done.`, ok: true });
      return result;
    } catch (error) {
      setMessage({
        text: `${label} failed: ${error instanceof ApiError ? error.message : "network error"}`,
        ok: false,
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  const status: ReactNode = (
    <p
      className={message && !message.ok ? "form-error" : "section-hint"}
      role="status"
      aria-live="polite"
      data-testid="admin-status"
    >
      {message?.text ?? ""}
    </p>
  );
  return { run, busy, status };
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** A labelled field in an admin form. */
function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="hint field-hint">{props.hint}</span> : null}
    </label>
  );
}

function FormActions(props: { submit: string; busy: boolean }) {
  return (
    <div className="dialog-actions">
      <DialogClose asChild>
        <button type="button" className="btn dialog">
          Cancel
        </button>
      </DialogClose>
      <button type="submit" className="btn dialog primary" disabled={props.busy}>
        {props.submit}
      </button>
    </div>
  );
}

// ---- Users -----------------------------------------------------------------------

function UsersSection() {
  const userId = useUserId();
  const users = useQuery(adminQueries.users(userId));
  const { run, busy, status } = useAction();
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState<AdminUserDto | null>(null);
  const [deleting, setDeleting] = useState<AdminUserDto | null>(null);
  const [confirmName, setConfirmName] = useState("");

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Accounts</h2>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus size={16} aria-hidden /> Add user
          </button>
        </div>
        {users.isPending ? <Spinner label="Loading users…" /> : null}
        <ul className="group" data-testid="admin-users" hidden={users.isPending}>
          {(users.data ?? []).map((u) => (
            <li key={u.id} className="row admin-row">
              <Avatar name={u.username} className="lg" />
              <div className="row-text grow">
                <span className="row-label">{u.username}</span>
                <span className="row-hint">
                  {u.conversationCount} chat{u.conversationCount === 1 ? "" : "s"} · joined{" "}
                  {new Date(u.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="row-actions">
                <select
                  className="select"
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
                <select
                  className="select"
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
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setPassword(u);
                  }}
                >
                  Set password
                </button>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => {
                    setConfirmName("");
                    setDeleting(u);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {status}
      </section>

      <DialogFrame
        open={adding}
        onOpenChange={setAdding}
        title="Add user"
        description="They sign in with this username and password."
      >
        <form
          className="dialog-body"
          aria-label="Create user"
          onSubmit={(event: SyntheticEvent<HTMLFormElement>) => {
            event.preventDefault();
            const element = event.currentTarget;
            const form = new FormData(element);
            void run("Create user", "POST", "/api/admin/users", {
              username: formValue(form, "username"),
              password: formValue(form, "password"),
              role: formValue(form, "role"),
            }).then((created) => {
              if (created) setAdding(false);
            });
          }}
        >
          <Field label="Username">
            <input className="input" name="username" required autoComplete="off" />
          </Field>
          <Field label="Initial password" hint="At least 10 characters.">
            <input
              className="input"
              name="password"
              type="password"
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label="Role">
            <select className="select" name="role" defaultValue="user">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <FormActions submit="Create user" busy={busy} />
        </form>
      </DialogFrame>

      <DialogFrame
        open={password !== null}
        onOpenChange={(open) => {
          if (!open) setPassword(null);
        }}
        title={`New password for ${password?.username ?? ""}`}
        description="They’ll be signed out everywhere."
      >
        <form
          className="dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (!password) return;
            void run("Set password", "POST", `/api/admin/users/${password.id}/password`, {
              password: formValue(form, "password"),
            }).then((done) => {
              if (done) setPassword(null);
            });
          }}
        >
          <Field label="New password">
            <input
              className="input"
              name="password"
              type="password"
              required
              autoComplete="new-password"
            />
          </Field>
          <FormActions submit="Save password" busy={busy} />
        </form>
      </DialogFrame>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.username ?? ""}?`}
        description={
          <>
            Their chats and data are removed for good. Type <strong>{deleting?.username}</strong> to
            confirm.
            <input
              className="input confirm-input"
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
    </>
  );
}

// ---- Providers ---------------------------------------------------------------------

function ProvidersSection() {
  const userId = useUserId();
  const providers = useQuery(adminQueries.providers(userId));
  const { run, busy, status } = useAction();
  const [editing, setEditing] = useState<AdminProviderDto | "new" | null>(null);
  const [removing, setRemoving] = useState<AdminProviderDto | null>(null);
  const current = editing === "new" ? null : editing;

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
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
    const done = current
      ? await run("Save provider", "PATCH", `/api/admin/providers/${current.id}`, {
          ...common,
          ...(apiKey ? { apiKey } : {}),
          ...(form.get("clearApiKey") === "on" ? { clearApiKey: true } : {}),
        })
      : await run("Add provider", "POST", "/api/admin/providers", {
          id: formValue(form, "id"),
          ...common,
          ...(apiKey ? { apiKey } : {}),
        });
    if (done) setEditing(null);
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Model servers</h2>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setEditing("new");
            }}
          >
            <Plus size={16} aria-hidden /> Add provider
          </button>
        </div>
        {providers.isPending ? <Spinner label="Loading providers…" /> : null}
        <ul className="group" data-testid="admin-providers" hidden={providers.isPending}>
          {(providers.data ?? []).length === 0 && !providers.isPending ? (
            <li className="row row-hint">No providers yet.</li>
          ) : null}
          {(providers.data ?? []).map((p) => (
            <li key={p.id} className="row admin-row">
              <div className="row-text grow">
                <span className="row-label">
                  {p.name}{" "}
                  {p.status === "enabled" ? null : <span className="badge danger">Invalid</span>}
                </span>
                <span className="row-hint">{p.problem ?? `${p.id} · ${p.baseUrl}`}</span>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    void run("Test connection", "POST", `/api/admin/providers/${p.id}/test`)
                  }
                >
                  Test
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setEditing(p);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => {
                    setRemoving(p);
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        {status}
      </section>

      <DialogFrame
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={current ? `Edit ${current.name}` : "Add provider"}
        description="Each save checks the address against the network policy. Keys are never shown again."
        wide
      >
        <form
          key={current?.id ?? "new"}
          className="dialog-body"
          aria-label={current ? `Edit ${current.name}` : "Add provider"}
          onSubmit={(e) => void save(e)}
        >
          {current ? null : (
            <Field label="Id" hint="Lowercase letters, digits, - and _.">
              <input className="input" name="id" required pattern="[a-z0-9][a-z0-9_-]{0,63}" />
            </Field>
          )}
          <Field label="Name">
            <input className="input" name="name" required defaultValue={current?.name ?? ""} />
          </Field>
          <Field label="Base URL">
            <input
              className="input"
              name="baseUrl"
              required
              defaultValue={current?.baseUrl ?? ""}
            />
          </Field>
          <Field label={`API key ${current?.hasApiKey ? "(leave empty to keep)" : "(optional)"}`}>
            <input className="input" name="apiKey" type="password" autoComplete="off" />
          </Field>
          <div className="group">
            {current?.hasApiKey ? (
              <label className="row">
                <span>Remove the stored key</span>
                <input className="switch" role="switch" name="clearApiKey" type="checkbox" />
              </label>
            ) : null}
            <label className="row">
              <span>llama.cpp sampling (top-k, min-p, repeat penalty)</span>
              <input
                className="switch"
                role="switch"
                name="samplingExtensions"
                type="checkbox"
                defaultChecked={current?.samplingExtensions ?? true}
              />
            </label>
            <label className="row">
              <span>Accepts images</span>
              <input
                className="switch"
                role="switch"
                name="image"
                type="checkbox"
                defaultChecked={current?.capabilities.inputModalities.includes("image") ?? false}
              />
            </label>
            <label className="row">
              <span>Reasoning</span>
              <input
                className="switch"
                role="switch"
                name="reasoning"
                type="checkbox"
                defaultChecked={current?.capabilities.reasoning ?? false}
              />
            </label>
          </div>
          <FormActions submit={current ? "Save provider" : "Add provider"} busy={busy} />
        </form>
      </DialogFrame>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ""}?`}
        description="Its models leave the model list straight away."
        confirmLabel="Remove provider"
        onConfirm={() => {
          if (removing)
            void run("Remove provider", "DELETE", `/api/admin/providers/${removing.id}`);
        }}
      />
    </>
  );
}

// ---- Models ---------------------------------------------------------------------------

function ModelsSection() {
  const userId = useUserId();
  const client = useQueryClient();
  const models = useQuery(adminQueries.models(userId));
  const { run, busy, status } = useAction();
  const [editing, setEditing] = useState<{ providerId: string; modelId: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const settingsFor = (providerId: string, modelId: string): AdminModelSettings | undefined =>
    models.data?.settings.find((s) => s.providerId === providerId && s.modelId === modelId);
  const current = editing ? settingsFor(editing.providerId, editing.modelId) : undefined;
  const numberOrNull = (form: FormData, name: string): number | null => {
    const raw = formValue(form, name).trim();
    return raw === "" ? null : Number(raw);
  };
  const groups = models.data?.providers ?? [];

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Available models</h2>
          <button
            type="button"
            className="btn sm"
            disabled={busy || refreshing}
            onClick={() => {
              setRefreshing(true);
              void apiJson<NonNullable<typeof models.data>>("/api/admin/models?refresh=1")
                .then(
                  (data) => {
                    client.setQueryData(adminKeys.models(userId), data);
                  },
                  () => undefined,
                )
                .finally(() => {
                  setRefreshing(false);
                });
            }}
          >
            <RefreshCw size={16} aria-hidden /> {refreshing ? "Refreshing…" : "Refresh discovery"}
          </button>
        </div>
        {models.isPending ? <Spinner label="Loading models…" /> : null}
        <ul className="group" data-testid="admin-models" hidden={models.isPending}>
          {groups.every((g) => g.models.length === 0) && !models.isPending ? (
            <li className="row row-hint">No models found. Add a provider first.</li>
          ) : null}
          {groups.flatMap((group) =>
            group.models.map((m) => {
              const s = settingsFor(m.providerId, m.id);
              return (
                <li key={`${m.providerId}/${m.id}`} className="row admin-row">
                  <div className="row-text grow">
                    <span className="row-label">{m.id}</span>
                    <span className="row-hint">{group.provider.name}</span>
                  </div>
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Edit ${m.id}`}
                    onClick={() => {
                      setEditing({ providerId: m.providerId, modelId: m.id });
                    }}
                  >
                    Edit
                  </button>
                  {/* Uncontrolled (toggles at once), re-synced by key when the server answers. */}
                  <input
                    key={String(s?.hidden === true)}
                    type="checkbox"
                    className="switch"
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
                </li>
              );
            }),
          )}
        </ul>
        {status}
      </section>

      <DialogFrame
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.modelId ?? "Model"}
        description="Sampling and the system prompt for this model. Blank uses the server default."
        wide
      >
        {editing ? (
          <form
            key={`${editing.providerId}/${editing.modelId}`}
            className="dialog-body"
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
            <div className="field-grid">
              {(
                [
                  ["temperature", "Temperature (0–2)", "0.05"],
                  ["topP", "Top-p (0–1]", "0.01"],
                  ["topK", "Top-k", "1"],
                  ["minP", "Min-p (0–1)", "0.01"],
                  ["repeatPenalty", "Repeat penalty (0.5–2)", "0.05"],
                ] as const
              ).map(([name, label, step]) => (
                <Field key={name} label={label}>
                  <input
                    className="input"
                    name={name}
                    type="number"
                    step={step}
                    defaultValue={current?.[name] ?? ""}
                  />
                </Field>
              ))}
            </div>
            <Field label="System prompt" hint="Variables: {{username}}, {{date}}, {{timezone}}.">
              <textarea
                className="textarea"
                name="systemPrompt"
                rows={4}
                defaultValue={current?.systemPrompt ?? ""}
              />
            </Field>
            <label className="group">
              <span className="row">
                <span>Tell the model the current time</span>
                <input
                  className="switch"
                  role="switch"
                  name="timeContext"
                  type="checkbox"
                  defaultChecked={current?.timeContext ?? false}
                />
              </span>
            </label>
            <FormActions submit="Save settings" busy={busy} />
          </form>
        ) : null}
      </DialogFrame>
    </>
  );
}

// ---- Instance -------------------------------------------------------------------------

const MIB = 1024 * 1024;
const mib = (value: number | null) => (value === null ? null : Math.round(value * MIB));
const toMib = (bytes: number) => String(Math.round((bytes / MIB) * 1000) / 1000);

function InstanceSection() {
  const userId = useUserId();
  const settings = useQuery(adminQueries.settings(userId));
  const models = useQuery(adminQueries.models(userId));
  const { run, busy, status } = useAction();
  const s = settings.data;
  if (!s) return <Spinner label="Loading settings…" />;
  const pairs = (models.data?.providers ?? []).flatMap((g) =>
    g.models.map((m) => JSON.stringify([m.providerId, m.id])),
  );
  const row = (label: string, control: ReactNode, hint?: string) => (
    <label className="row">
      <span className="row-text">
        <span className="row-label">{label}</span>
        {hint ? <span className="row-hint">{hint}</span> : null}
      </span>
      {control}
    </label>
  );
  return (
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
          // Blank fields fall back to the environment defaults (the placeholders).
          attachments: {
            maxFileBytes: mib(num("maxFileMiB")),
            maxPerMessage: num("maxPerMessage"),
            quotaBytes: mib(num("quotaMiB")),
            textInlineBytes: num("textInlineBytes"),
          },
        });
      }}
    >
      {s.problem ? (
        <div className="alert danger" role="alert">
          <span className="alert-text">
            settings.json couldn’t be read ({s.problem}); the defaults are in effect.
          </span>
        </div>
      ) : null}
      <section className="section">
        <h2 className="section-title">Access</h2>
        <div className="group">
          {row(
            "Registration",
            <select className="select" name="registrationMode" defaultValue={s.registrationMode}>
              <option value="closed">Closed</option>
              <option value="open">Open</option>
            </select>,
            s.registrationModeSource === "settings" ? "Saved setting" : "From the environment",
          )}
        </div>
      </section>
      <section className="section">
        <h2 className="section-title">Chats</h2>
        <div className="group">
          {row(
            "Default model",
            <select
              className="select"
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
            </select>,
          )}
          {row(
            "Time zone",
            <input className="input compact" name="timezone" defaultValue={s.timezone} />,
            "An IANA name, like Europe/Lisbon",
          )}
          {row(
            "Replies at once per user",
            <input
              className="input compact"
              name="maxActivePerUser"
              type="number"
              min={1}
              max={32}
              defaultValue={s.generation.maxActivePerUser ?? ""}
            />,
          )}
          {row(
            "Longest reply (tokens)",
            <input
              className="input compact"
              name="maxOutputTokens"
              type="number"
              min={16}
              max={65536}
              defaultValue={s.generation.maxOutputTokens ?? ""}
            />,
          )}
        </div>
      </section>
      <section className="section">
        <h2 className="section-title">Attachments</h2>
        <p className="section-hint">Blank uses the environment default, shown in grey.</p>
        <div className="group">
          {row(
            "Largest file (MiB)",
            <input
              className="input compact"
              name="maxFileMiB"
              type="number"
              min={0.001}
              step="any"
              placeholder={toMib(s.attachmentDefaults.maxFileBytes)}
              defaultValue={s.attachments.maxFileBytes ? toMib(s.attachments.maxFileBytes) : ""}
            />,
          )}
          {row(
            "Files per message",
            <input
              className="input compact"
              name="maxPerMessage"
              type="number"
              min={1}
              max={10}
              placeholder={String(s.attachmentDefaults.maxPerMessage)}
              defaultValue={s.attachments.maxPerMessage ?? ""}
            />,
          )}
          {row(
            "Storage per user (MiB)",
            <input
              className="input compact"
              name="quotaMiB"
              type="number"
              min={0.001}
              step="any"
              placeholder={toMib(s.attachmentDefaults.quotaBytes)}
              defaultValue={s.attachments.quotaBytes ? toMib(s.attachments.quotaBytes) : ""}
            />,
          )}
          {row(
            "Text sent per file (bytes)",
            <input
              className="input compact"
              name="textInlineBytes"
              type="number"
              min={256}
              max={10000000}
              placeholder={String(s.attachmentDefaults.textInlineBytes)}
              defaultValue={s.attachments.textInlineBytes ?? ""}
            />,
          )}
        </div>
      </section>
      <div className="form-actions">
        {status}
        <span className="spacer" />
        <button className="btn primary" type="submit" disabled={busy}>
          Save settings
        </button>
      </div>
    </form>
  );
}

// ---- Maintenance ------------------------------------------------------------------------

function MaintenanceSection() {
  const userId = useUserId();
  const users = useQuery(adminQueries.users(userId));
  const { run, busy, status } = useAction();
  const [confirm, setConfirm] = useState(false);
  const [target, setTarget] = useState("");
  return (
    <section className="section">
      <h2 className="section-title">Repairs</h2>
      <div className="group">
        <div className="row admin-row">
          <div className="row-text grow">
            <span className="row-label">Rebuild the conversation index</span>
            <span className="row-hint">
              Chat lists are worked out again from the chat files. Always safe.
            </span>
          </div>
          <div className="row-actions">
            <select
              className="select"
              aria-label="Rebuild the index for"
              value={target}
              onChange={(event) => {
                setTarget(event.currentTarget.value);
              }}
            >
              <option value="">Every user</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
            <button
              className="btn sm"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirm(true);
              }}
            >
              Rebuild index
            </button>
          </div>
        </div>
      </div>
      {status}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Rebuild the conversation index?"
        description="Chat lists are worked out again from the chat files."
        confirmLabel="Rebuild"
        tone="primary"
        onConfirm={() =>
          void run(
            "Rebuild index",
            "POST",
            "/api/admin/maintenance/rebuild-index",
            target ? { userId: target } : {},
          )
        }
      />
    </section>
  );
}

// ---- Logs ---------------------------------------------------------------------------------

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "Debug",
  info: "Info",
  warn: "Warning",
  error: "Error",
};

const SOURCE_LABEL: Record<LogEntryDto["source"], string> = {
  auth: "Sign-in",
  providers: "Providers",
  admin: "Administration",
  generations: "Replies",
  reports: "Problem reports",
  system: "System",
};

function timeOf(iso: string, withSeconds = false): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
  if (today) return withSeconds ? `Today, ${time}` : time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function LogsSection() {
  const [open, setOpen] = useState<string | null>(null);
  return open ? (
    <LogDetail
      id={open}
      onBack={() => {
        setOpen(null);
      }}
    />
  ) : (
    <LogList onOpen={setOpen} />
  );
}

function LogList({ onOpen }: { onOpen: (id: string) => void }) {
  const userId = useUserId();
  const logs = useQuery(adminQueries.logs(userId));
  const { run, busy, status } = useAction();
  const [clearing, setClearing] = useState(false);
  const settings = logs.data?.settings;
  return (
    <>
      <h1 className="page-title">Logs</h1>
      <section className="section">
        <h2 className="section-title">Logging</h2>
        <div className="group">
          <label className="row">
            <span className="row-label">Log level</span>
            <select
              className="select"
              value={settings?.level ?? "info"}
              disabled={!settings || busy}
              onChange={(event) =>
                void run("Log level", "PATCH", "/api/admin/settings", {
                  logging: { level: event.currentTarget.value },
                })
              }
            >
              {LOG_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {LEVEL_LABEL[level]}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            <span className="row-label">Keep logs for</span>
            <select
              className="select"
              value={String(settings?.retentionDays ?? 30)}
              disabled={!settings || busy}
              onChange={(event) =>
                void run("Log retention", "PATCH", "/api/admin/settings", {
                  logging: { retentionDays: Number(event.currentTarget.value) },
                })
              }
            >
              {LOG_RETENTION_DAYS.map((days) => (
                <option key={days} value={String(days)}>
                  {days === 365 ? "1 year" : `${String(days)} days`}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <span className="row-label">Export logs</span>
            <a className="btn sm" href="/api/admin/logs/export" download>
              Download
            </a>
          </div>
        </div>
      </section>
      <section className="section">
        <h2 className="section-title">Recent activity</h2>
        {logs.isPending ? <Spinner label="Loading logs…" /> : null}
        {logs.isError ? (
          <div className="alert danger" role="alert">
            <span className="alert-text">The logs couldn’t be loaded.</span>
            <button type="button" className="btn" onClick={() => void logs.refetch()}>
              Try again
            </button>
          </div>
        ) : null}
        {logs.data ? (
          <ul className="group" data-testid="admin-logs">
            {logs.data.entries.length === 0 ? (
              <li className="row row-hint">Nothing logged yet.</li>
            ) : null}
            {logs.data.entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="row"
                  onClick={() => {
                    onOpen(entry.id);
                  }}
                >
                  <span className="row-text">
                    <span className="row-label">{entry.message}</span>
                    <span className="visually-hidden">, {LEVEL_LABEL[entry.level]}</span>
                  </span>
                  <span className="row-value log-time">
                    <time dateTime={entry.time}>{timeOf(entry.time)}</time>
                    <ChevronRight size={16} aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="group">
        <div className="row">
          <span className="row-label">Clear all logs</span>
          <button
            type="button"
            className="btn sm danger"
            disabled={busy}
            onClick={() => {
              setClearing(true);
            }}
          >
            Clear logs
          </button>
        </div>
      </section>
      {status}
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Clear all logs?"
        description="Every log entry is deleted. The audit trail of admin changes is kept."
        confirmLabel="Clear logs"
        onConfirm={() => void run("Clear logs", "DELETE", "/api/admin/logs")}
      />
    </>
  );
}

function CopyDetails({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn primary pill-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy details"}
    </button>
  );
}

function LogDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const userId = useUserId();
  const entry = useQuery(adminQueries.log(userId, id));
  const e = entry.data;
  const copy = e
    ? [
        e.message,
        `Level: ${LEVEL_LABEL[e.level]}`,
        `Time: ${e.time}`,
        `Source: ${SOURCE_LABEL[e.source]}`,
        `User: ${e.user?.username ?? "System"}`,
        ...(e.requestId ? [`Request ID: ${e.requestId}`] : []),
        ...(e.details ? ["", e.details] : []),
      ].join("\n")
    : "";
  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden /> Logs
      </button>
      {entry.isPending ? <Spinner label="Loading the entry…" /> : null}
      {entry.isError ? (
        <div className="alert danger" role="alert">
          <span className="alert-text">This entry isn’t available any more.</span>
        </div>
      ) : null}
      {e ? (
        <>
          <h1 className="page-title tall">{e.message}</h1>
          <section className="group" data-testid="log-detail">
            <div className="row">
              <span>Level</span>
              <span
                className={`badge${e.level === "error" ? " danger" : e.level === "warn" ? " warn" : ""}`}
              >
                {LEVEL_LABEL[e.level]}
              </span>
            </div>
            <div className="row">
              <span>Time</span>
              <span className="row-value">
                <time dateTime={e.time}>{timeOf(e.time, true)}</time>
              </span>
            </div>
            <div className="row">
              <span>Source</span>
              <span className="row-value">{SOURCE_LABEL[e.source]}</span>
            </div>
            <div className="row">
              <span>User</span>
              <span className="row-value">{e.user?.username ?? "System"}</span>
            </div>
            {e.requestId ? (
              <div className="row">
                <span>Request ID</span>
                <span className="row-value">{e.requestId}</span>
              </div>
            ) : null}
          </section>
          {e.details ? (
            <section className="section">
              <h2 className="section-title">Details</h2>
              <pre className="pre-card">{e.details}</pre>
            </section>
          ) : null}
          <div className="form-actions">
            <CopyDetails text={copy} />
          </div>
        </>
      ) : null}
    </>
  );
}
