import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseZap } from "lucide-react";
import { useState } from "react";
import type { AdminSettingsDto, AuditEntryDto } from "@shared/admin";
import { api, messageOf } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { allModels, modelLabel } from "../lib/models";
import { keys, useModels } from "../lib/query";
import { ActionRow, Choice, Group, NumberChoice, Row, Status } from "./parts";

const MIB = 1024 * 1024;
const ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Toronto",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function AdminInstance(props: { userId: string }) {
  const client = useQueryClient();
  const key = keys.admin(props.userId, "settings");
  const settings = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<AdminSettingsDto>("/api/admin/settings", { signal }),
  });
  const models = useModels(props.userId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const s = settings.data;
  if (!s) return <Status error={settings.isError ? "Couldn’t load settings." : null} />;

  async function save(change: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      client.setQueryData(
        key,
        await api<AdminSettingsDto>("/api/admin/settings", { method: "PATCH", body: change }),
      );
      await client.invalidateQueries({ queryKey: keys.models(props.userId) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const modelOptions = [
    { value: "", label: "None" },
    ...allModels(models.data).map((m) => ({
      value: JSON.stringify([m.providerId, m.id]),
      label: modelLabel(m.id),
    })),
  ];
  const currentModel = s.defaultModel
    ? JSON.stringify([s.defaultModel.providerId, s.defaultModel.modelId])
    : "";
  const zones = [...new Set([s.timezone, browserZone(), ...ZONES])].map((z) => ({
    value: z,
    label: z,
  }));
  const d = s.attachmentDefaults;
  const a = s.attachments;
  const attach = (field: string) => (v: number | null) =>
    void save({ attachments: { [field]: v } });

  return (
    <>
      <Group
        heading="Sign-up and defaults"
        note={
          s.registrationModeSource === "environment"
            ? "Registration is set by the environment until you change it here."
            : undefined
        }
      >
        <Row label="Registration" id="i-reg">
          <Choice
            labelledBy="i-reg"
            value={s.registrationMode}
            disabled={busy}
            options={[
              { value: "closed", label: "Closed" },
              { value: "open", label: "Open" },
            ]}
            onChange={(v) => void save({ registrationMode: v })}
          />
        </Row>
        <Row label="Default model" id="i-model">
          <Choice
            labelledBy="i-model"
            value={currentModel}
            disabled={busy}
            options={modelOptions}
            onChange={(v) => {
              const [providerId, modelId] = v ? (JSON.parse(v) as [string, string]) : [];
              void save({ defaultModel: providerId && modelId ? { providerId, modelId } : null });
            }}
          />
        </Row>
        <Row label="Time zone" id="i-tz">
          <Choice
            labelledBy="i-tz"
            value={s.timezone}
            disabled={busy}
            options={zones}
            onChange={(v) => void save({ timezone: v })}
          />
        </Row>
      </Group>
      <Group heading="Generation">
        <Row label="Active per user" id="i-active">
          <NumberChoice
            labelledBy="i-active"
            value={s.generation.maxActivePerUser}
            presets={[1, 2, 4, 8]}
            format={String}
            nullLabel="Default"
            disabled={busy}
            onChange={(v) => void save({ generation: { maxActivePerUser: v } })}
          />
        </Row>
        <Row label="Max output tokens" id="i-tokens">
          <NumberChoice
            labelledBy="i-tokens"
            value={s.generation.maxOutputTokens}
            presets={[1024, 4096, 8192, 16384, 32768]}
            format={(n) => n.toLocaleString()}
            nullLabel="Default"
            disabled={busy}
            onChange={(v) => void save({ generation: { maxOutputTokens: v } })}
          />
        </Row>
      </Group>
      <Group heading="Attachments" note="Shown at the server’s defaults until you change them.">
        <Row label="Max file size" id="i-size">
          <NumberChoice
            labelledBy="i-size"
            value={a.maxFileBytes}
            presets={[5, 10, 20, 50, 100].map((n) => n * MIB)}
            format={formatBytes}
            nullLabel={formatBytes(d.maxFileBytes)}
            scale={MIB}
            unit="MB"
            disabled={busy}
            onChange={attach("maxFileBytes")}
          />
        </Row>
        <Row label="Files per message" id="i-files">
          <NumberChoice
            labelledBy="i-files"
            value={a.maxPerMessage}
            presets={[1, 2, 3, 5, 10]}
            format={String}
            nullLabel={String(d.maxPerMessage)}
            disabled={busy}
            onChange={attach("maxPerMessage")}
          />
        </Row>
        <Row label="Storage per user" id="i-quota">
          <NumberChoice
            labelledBy="i-quota"
            value={a.quotaBytes}
            presets={[100, 500, 1024, 5120, 10240].map((n) => n * MIB)}
            format={formatBytes}
            nullLabel={formatBytes(d.quotaBytes)}
            scale={MIB}
            unit="MB"
            disabled={busy}
            onChange={attach("quotaBytes")}
          />
        </Row>
        <Row label="Text inlined" id="i-inline">
          <NumberChoice
            labelledBy="i-inline"
            value={a.textInlineBytes}
            presets={[16, 64, 100, 256, 1024].map((n) => n * 1024)}
            format={formatBytes}
            nullLabel={formatBytes(d.textInlineBytes)}
            scale={1024}
            unit="KB"
            disabled={busy}
            onChange={attach("textInlineBytes")}
          />
        </Row>
      </Group>
      <Status error={error ?? s.problem} />
    </>
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
      <Group note="Always safe: the index comes from the chat files.">
        <ActionRow
          icon={<DatabaseZap size={18} aria-hidden />}
          label={busy ? "Rebuilding…" : "Rebuild the conversation index"}
          disabled={busy}
          onClick={() => void rebuild()}
        />
      </Group>
      <Status error={error} ok={result} />
    </>
  );
}

const ACTIONS: Record<string, string> = {
  "user.create": "Create user",
  "user.update": "Change user",
  "user.password": "Set password",
  "user.delete": "Delete user",
  "provider.create": "Add provider",
  "provider.update": "Change provider",
  "provider.delete": "Remove provider",
  "provider.test": "Test connection",
  "model.settings": "Change model",
  "settings.update": "Change instance",
  "maintenance.rebuild-index": "Rebuild index",
};

export function AdminAudit(props: { userId: string }) {
  const audit = useQuery({
    queryKey: keys.admin(props.userId, "audit"),
    queryFn: ({ signal }) =>
      api<{ entries: AuditEntryDto[] }>("/api/admin/audit?limit=200", { signal }),
    select: (d) => d.entries,
  });
  if (audit.data?.length === 0) return <p className="settings-empty-text">Nothing yet.</p>;
  return (
    <>
      {audit.data ? (
        <Group>
          {audit.data.map((e, i) => {
            const target = e.target.label ?? e.target.id;
            return (
              <Row
                key={`${e.time}-${String(i)}`}
                label={
                  <>
                    {ACTIONS[e.action] ?? e.action}
                    {target ? <span className="row-value"> · {target}</span> : null}
                  </>
                }
                hint={`${formatDateTime(e.time)} · ${e.actor.username}`}
              >
                <span className={e.outcome === "success" ? "row-value" : "danger-text"}>
                  {e.outcome === "success" ? "Succeeded" : "Failed"}
                </span>
              </Row>
            );
          })}
        </Group>
      ) : null}
      <Status error={audit.isError ? "Couldn’t load the audit log." : null} />
    </>
  );
}
