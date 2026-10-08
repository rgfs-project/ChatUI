import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ExportResult, ImportPreview } from "@shared/portability";
import { ConfirmDialog, Switch } from "../components/ui";
import { api, apiFetch, ensureOk, messageOf } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { keys } from "../lib/query";
import { ActionRow, Choice, Group, Row, Status } from "./parts";

const SOURCE = {
  chatui: "ChatUI archive",
  claude: "Claude export",
  duckai: "duck.ai chats",
} as const;
const ACTION: Record<string, string> = {
  new: "New",
  identical: "Already here",
  conflict: "Conflicts",
  copy: "Copied",
  skipped: "Skipped",
  degraded: "Imported, partly",
};

function countsLine(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${String(n)} ${kind}${n === 1 ? "" : "s"}`)
    .join(", ");
}

async function uploadArchive(file: File): Promise<ImportPreview> {
  let tz: string;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = "";
  }
  const response = await apiFetch(
    tz ? `/api/imports?tz=${encodeURIComponent(tz)}` : "/api/imports",
    {
      method: "POST",
      headers: {
        "Content-Type":
          /\.zip$/i.test(file.name) || file.type === "application/zip"
            ? "application/zip"
            : "application/octet-stream",
      },
      body: file,
    },
  );
  await ensureOk(response);
  return (await response.json()) as ImportPreview;
}

export function Data(props: { userId: string }) {
  const client = useQueryClient();
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [uploading, setUploading] = useState(false);
  const [conflicts, setConflicts] = useState<"skip" | "copy">("skip");
  const [memoryIds, setMemoryIds] = useState<string[]>([]);
  const [repeatOk, setRepeatOk] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function runExport() {
    setExporting(true);
    setError(null);
    try {
      setExported(await api<ExportResult>("/api/exports", { method: "POST", body: {} }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setExporting(false);
    }
  }

  async function chooseFile(f: File) {
    setUploading(true);
    setError(null);
    setPreview(null);
    try {
      const p = await uploadArchive(f);
      setPreview(p);
      setMemoryIds([]);
      setRepeatOk(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setUploading(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setError(null);
    try {
      setPreview(
        await api<ImportPreview>(`/api/imports/${encodeURIComponent(preview.importId)}/commit`, {
          method: "POST",
          body: { conflicts, memoryIds, allowRepeat: repeatOk },
        }),
      );
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function cancel() {
    if (!preview) return;
    try {
      await api(`/api/imports/${encodeURIComponent(preview.importId)}`, { method: "DELETE" });
    } catch {
      // Already gone.
    }
    setPreview(null);
    setCancelOpen(false);
  }

  // While an import runs, poll it; when it ends, refresh what it touched.
  const committing = preview?.state === "committing";
  const importId = preview?.importId;
  useEffect(() => {
    if (!committing || !importId) return;
    const timer = setInterval(() => {
      void api<ImportPreview>(`/api/imports/${encodeURIComponent(importId)}`).then(
        setPreview,
        () => undefined,
      );
    }, 600);
    return () => {
      clearInterval(timer);
    };
  }, [committing, importId]);
  const done =
    preview?.state === "committed" ||
    preview?.state === "failed" ||
    preview?.state === "rolled_back";
  useEffect(() => {
    if (done) void client.invalidateQueries({ queryKey: keys.user(props.userId) });
  }, [done, client, props.userId]);

  const conflictCount = preview?.items.filter((i) => i.action === "conflict").length ?? 0;

  return (
    <>
      <Group
        note={
          exported
            ? `${formatBytes(exported.size)} · ${countsLine(exported.counts)}`
            : "Chats, files, memories, skills and settings, in one archive."
        }
      >
        {exported ? (
          <a
            className="row row-button action-row"
            href={`/api/exports/${encodeURIComponent(exported.exportId)}/download`}
          >
            <Download size={18} aria-hidden />
            <span>Download archive</span>
          </a>
        ) : (
          <ActionRow
            icon={<Download size={18} aria-hidden />}
            label={exporting ? "Preparing…" : "Export all data"}
            disabled={exporting}
            onClick={() => void runExport()}
          />
        )}
      </Group>
      <Group
        note={
          uploading
            ? "Reading the file…"
            : "From a ChatUI, Claude or duck.ai export. Nothing is overwritten."
        }
      >
        <ActionRow
          icon={<Upload size={18} aria-hidden />}
          label="Import chats"
          disabled={uploading || committing}
          onClick={() => file.current?.click()}
        />
      </Group>
      <input
        ref={file}
        type="file"
        hidden
        accept=".zip,.json,.txt,.md,.html,application/zip,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void chooseFile(f);
        }}
      />

      {preview ? (
        <>
          <Group
            heading={`${SOURCE[preview.source]}${preview.exportCreatedAt ? ` · ${formatDateTime(preview.exportCreatedAt)}` : ""}`}
            note={
              committing
                ? `Importing… ${String(preview.progress.done)} of ${String(preview.progress.total)}`
                : preview.state === "committed"
                  ? "Import finished."
                  : preview.warnings.length > 0
                    ? preview.warnings.join(" ")
                    : undefined
            }
          >
            {Object.entries(preview.counts).map(([kind, byAction]) => (
              <Row
                key={kind}
                label={(kind[0]?.toUpperCase() ?? "") + kind.slice(1)}
                hint={Object.entries(byAction)
                  .filter(([, n]) => n > 0)
                  .map(([a, n]) => `${ACTION[a] ?? a}: ${String(n)}`)
                  .join(" · ")}
              />
            ))}
            {preview.state === "previewed" && conflictCount > 0 ? (
              <Row
                label="Conflicting items"
                hint={`${String(conflictCount)} differ from what you have`}
                id="imp-conf"
              >
                <Choice
                  labelledBy="imp-conf"
                  value={conflicts}
                  options={[
                    { value: "skip", label: "Skip them" },
                    { value: "copy", label: "Import as copies" },
                  ]}
                  onChange={setConflicts}
                />
              </Row>
            ) : null}
            {preview.state === "previewed" && preview.previousImport ? (
              <Row
                label="Import again"
                hint={`This file was imported on ${formatDateTime(preview.previousImport.committedAt)}.`}
              >
                <Switch label="Import again" checked={repeatOk} onChange={setRepeatOk} />
              </Row>
            ) : null}
          </Group>
          {preview.state === "previewed" && preview.memories.length > 0 ? (
            <Group heading="Memories (choose which to import)">
              {preview.memories.map((m) => (
                <Row
                  key={m.id}
                  label={m.name}
                  hint={
                    m.action === "new"
                      ? m.content
                      : `${ACTION[m.action] ?? m.action} · ${m.content}`
                  }
                >
                  <Switch
                    label={`Import memory ${m.name}`}
                    checked={memoryIds.includes(m.id)}
                    disabled={m.action === "identical"}
                    onChange={(on) => {
                      setMemoryIds((ids) =>
                        on ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                      );
                    }}
                  />
                </Row>
              ))}
            </Group>
          ) : null}
          <Status error={preview.report?.error ?? null} />
          {preview.state !== "previewed" && !done ? null : (
            <Group>
              {preview.state === "previewed" ? (
                <>
                  <ActionRow
                    icon={<Upload size={18} aria-hidden />}
                    label="Import"
                    disabled={preview.previousImport !== null && !repeatOk}
                    onClick={() => void commit()}
                  />
                  <ActionRow
                    danger
                    icon={<span className="action-spacer" />}
                    label="Cancel import"
                    onClick={() => {
                      setCancelOpen(true);
                    }}
                  />
                </>
              ) : done ? (
                <ActionRow
                  icon={<span className="action-spacer" />}
                  label="Done"
                  onClick={() => {
                    setPreview(null);
                  }}
                />
              ) : null}
            </Group>
          )}
        </>
      ) : null}
      <Status error={error} />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this import?"
        description="Nothing from this file has been imported yet."
        confirm="Cancel import"
        onConfirm={() => void cancel()}
      />
    </>
  );
}
