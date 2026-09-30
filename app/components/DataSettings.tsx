import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ExportResult, ImportItem, ImportPreview } from "@shared/portability";
import { currentSession } from "../lib/api";
import { formatBytes } from "../lib/format";
import { ApiError, apiJson } from "../lib/query";
import "./data.css";

const ACTION_LABEL: Record<ImportItem["action"], string> = {
  new: "New",
  identical: "Already present",
  conflict: "Conflict",
  copy: "Copy",
  skipped: "Skipped",
  degraded: "Imported with changes",
};

const KIND_LABEL: Record<ImportItem["kind"], string> = {
  conversation: "Chats",
  attachment: "Attachments",
  artifact: "Files",
  memory: "Memories",
  proposals: "Memory suggestions",
  skill: "Skills",
  preferences: "Preferences",
};

const SOURCE_LABELS: Record<ImportPreview["source"], string> = {
  chatui: "ChatUI export",
  claude: "Claude data export",
  duckai: "duck.ai chat",
};

/** When the source was made: a ChatUI export's date; the latest change otherwise. */
function sourceDate(preview: ImportPreview): string {
  const when = new Date(preview.exportCreatedAt).toLocaleString();
  return preview.source === "chatui" ? `Exported ${when}.` : `Latest change ${when}.`;
}

/** The browser's IANA time zone, for sources that record none (duck.ai). */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

/**
 * Uploads the file with progress (XHR: fetch has no upload progress). The
 * server detects the source; a non-ZIP goes as opaque bytes so no body
 * parser touches it.
 */
function uploadArchive(
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const tz = timeZone();
    xhr.open("POST", tz ? `/api/imports?tz=${encodeURIComponent(tz)}` : "/api/imports");
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader(
      "Content-Type",
      /\.zip$/i.test(file.name) || file.type === "application/zip"
        ? "application/zip"
        : "application/octet-stream",
    );
    const session = currentSession();
    if (session?.csrfToken && session.user) {
      xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
      xhr.setRequestHeader("X-Expected-User", session.user.id);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const body = xhr.response as (ImportPreview & { error?: { message?: string } }) | null;
      if (xhr.status === 201 && body) resolve(body);
      else
        reject(
          new Error(body?.error?.message ?? `The file couldn't be read (${String(xhr.status)})`),
        );
    };
    xhr.onerror = () => {
      reject(new Error("The upload failed. Check your connection and try again."));
    };
    xhr.onabort = () => {
      reject(new Error("Cancelled."));
    };
    signal.addEventListener("abort", () => {
      xhr.abort();
    });
    xhr.send(file);
  });
}

function Summary({ counts }: { counts: ImportPreview["counts"] }) {
  const kinds = Object.keys(counts) as ImportItem["kind"][];
  if (kinds.length === 0)
    return <p className="settings-hint">Nothing in this file can be imported.</p>;
  return (
    <table className="data-summary">
      <caption className="visually-hidden">What the file contains</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">New</th>
          <th scope="col">Already present</th>
          <th scope="col">Conflicts</th>
          <th scope="col">Other</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => {
          const c = counts[kind] ?? {};
          const other = (c.skipped ?? 0) + (c.degraded ?? 0) + (c.copy ?? 0);
          return (
            <tr key={kind}>
              <th scope="row">{KIND_LABEL[kind]}</th>
              <td>{c.new ?? 0}</td>
              <td>{c.identical ?? 0}</td>
              <td>{c.conflict ?? 0}</td>
              <td>{other}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ItemList({ items, title }: { items: readonly ImportItem[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <details className="data-items">
      <summary>
        {title} ({items.length})
      </summary>
      <ul>
        {items.map((i) => (
          <li key={`${i.kind}:${i.id}`}>
            <span className="data-item-kind">{KIND_LABEL[i.kind]}</span> {i.label} —{" "}
            {ACTION_LABEL[i.action]}
            {i.reason ? ` (${i.reason})` : ""}
            {i.rewritten ? " · references rewritten" : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Settings → Data (Phase 13d, lazy): export everything as a portable
 * archive, and import one, a Claude data export or a duck.ai chat (13e;
 * the server detects which). An import is previewed first (counts, conflicts,
 * skipped items), needs explicit confirmation, can be cancelled before it
 * commits, and ends with a report.
 */
export default function DataSettings({ userId }: { userId: string }) {
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [uploading, setUploading] = useState<{
    fraction: number;
    controller: AbortController;
  } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<"skip" | "copy">("skip");
  const [memoryIds, setMemoryIds] = useState<string[]>([]);
  const [again, setAgain] = useState(false);

  const exportAll = useMutation({
    mutationFn: () => apiJson<ExportResult>("/api/exports", { method: "POST", body: "{}" }),
    onSuccess: setExported,
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "The export failed. Try again.");
    },
  });

  const commit = useMutation({
    mutationFn: (id: string) =>
      apiJson<ImportPreview>(`/api/imports/${encodeURIComponent(id)}/commit`, {
        method: "POST",
        body: JSON.stringify({ conflicts, memoryIds, allowRepeat: again }),
      }),
    onSuccess: setPreview,
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : "The import couldn't start.");
    },
  });

  // Bounded progress: poll while the commit runs, then refresh what it touched.
  const committing = preview?.state === "committing";
  const previewId = preview?.importId;
  useEffect(() => {
    if (!committing || !previewId) return;
    const timer = setInterval(() => {
      void apiJson<ImportPreview>(`/api/imports/${encodeURIComponent(previewId)}`).then(
        (next) => {
          setPreview(next);
        },
        () => undefined,
      );
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [committing, previewId]);
  const finished = preview?.state === "committed";
  useEffect(() => {
    if (!finished) return;
    for (const family of [
      "conversations",
      "conversation",
      "memories",
      "artifacts",
      "preferences",
      "skills",
      "search",
    ])
      void client.invalidateQueries({ queryKey: ["user", userId, family] });
  }, [finished, client, userId]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    setMemoryIds([]);
    setAgain(false);
    const controller = new AbortController();
    setUploading({ fraction: 0, controller });
    try {
      setPreview(
        await uploadArchive(
          file,
          (fraction) => {
            setUploading((u) => (u ? { ...u, fraction } : u));
          },
          controller.signal,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file couldn't be read.");
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const cancel = async () => {
    if (!preview) return;
    await apiJson(`/api/imports/${encodeURIComponent(preview.importId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    setPreview(null);
  };

  const conflictItems = preview?.items.filter((i) => i.action === "conflict") ?? [];
  const skippedItems =
    preview?.items.filter((i) => i.action === "skipped" || i.action === "degraded") ?? [];
  const report = preview?.report;
  return (
    <section className="settings-body" tabIndex={0} aria-labelledby={headingId}>
      <h2 id={headingId}>Data</h2>

      <h3 className="data-heading">Export</h3>
      <p className="settings-hint">
        One archive with your chats, attachments, files, memories, memory suggestions, skills and
        preferences. Your password and sign-in sessions are not included. To save a single chat, use
        “Export as Markdown” in its title menu (text only, no attachments).
      </p>
      <div className="data-row">
        <button
          type="button"
          disabled={exportAll.isPending}
          onClick={() => {
            exportAll.mutate();
          }}
        >
          <Download size={16} aria-hidden />{" "}
          {exportAll.isPending ? "Preparing…" : "Export all data"}
        </button>
        {exported ? (
          <a
            className="button-link secondary"
            href={`/api/exports/${encodeURIComponent(exported.exportId)}/download`}
            download
            data-testid="export-download"
          >
            Download ({formatBytes(exported.size)})
          </a>
        ) : null}
      </div>

      <h3 className="data-heading">Import</h3>
      <p className="settings-hint">
        Import a ChatUI export, a Claude data export (the ZIP files from Claude’s Settings → Privacy
        → Export data, or their conversations.json), or a chat downloaded from duck.ai. Nothing
        changes until you confirm, and nothing you have is ever overwritten.
      </p>
      <div className="data-row">
        <label className="button-link secondary data-file">
          <Upload size={16} aria-hidden /> Choose file…
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.json,.txt,application/zip,application/json,text/plain"
            className="visually-hidden"
            disabled={uploading !== null || committing}
            onChange={(event) => void choose(event.currentTarget.files?.[0])}
          />
        </label>
        {uploading ? (
          <>
            <progress max={1} value={uploading.fraction} aria-label="Uploading file" />
            <button
              type="button"
              className="secondary"
              onClick={() => {
                uploading.controller.abort();
              }}
            >
              Cancel
            </button>
          </>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {preview?.state === "previewed" ? (
        <div className="data-preview" data-testid="import-preview">
          <h4>Preview: {SOURCE_LABELS[preview.source]}</h4>
          <p className="settings-hint">{sourceDate(preview)}</p>
          <Summary counts={preview.counts} />
          {preview.warnings.map((w) => (
            <p key={w} className="settings-hint">
              {w}
            </p>
          ))}
          <ItemList items={conflictItems} title="Conflicts" />
          <ItemList items={skippedItems} title="Skipped or changed" />
          {conflictItems.length > 0 ? (
            <fieldset className="data-choice">
              <legend>Items that differ from yours</legend>
              <label>
                <input
                  type="radio"
                  name="conflicts"
                  checked={conflicts === "skip"}
                  onChange={() => {
                    setConflicts("skip");
                  }}
                />{" "}
                Skip them (keep yours)
              </label>
              <label>
                <input
                  type="radio"
                  name="conflicts"
                  checked={conflicts === "copy"}
                  onChange={() => {
                    setConflicts("copy");
                  }}
                />{" "}
                Import them as copies
              </label>
            </fieldset>
          ) : null}
          {preview.memories.length > 0 ? (
            <fieldset className="data-choice">
              <legend>Memories to import (none unless you choose)</legend>
              {preview.memories.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={memoryIds.includes(m.id)}
                    disabled={m.action !== "new"}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setMemoryIds((ids) =>
                        on ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                      );
                    }}
                  />{" "}
                  <strong>{m.name}</strong>
                  {m.action === "identical"
                    ? " (already saved)"
                    : m.action === "conflict"
                      ? " (a memory with this name exists)"
                      : ""}
                </label>
              ))}
            </fieldset>
          ) : null}
          {preview.previousImport ? (
            <label className="data-again">
              <input
                type="checkbox"
                checked={again}
                onChange={(event) => {
                  setAgain(event.currentTarget.checked);
                }}
              />{" "}
              This export was imported on{" "}
              {new Date(preview.previousImport.committedAt).toLocaleString()}. Import it again
            </label>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => void cancel()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={commit.isPending || (preview.previousImport !== null && !again)}
              onClick={() => {
                commit.mutate(preview.importId);
              }}
            >
              Import
            </button>
          </div>
        </div>
      ) : null}

      {preview && committing ? (
        <div className="data-preview" role="status">
          Importing…{" "}
          <progress
            max={Math.max(1, preview.progress.total)}
            value={preview.progress.done}
            aria-label="Import progress"
          />
        </div>
      ) : null}

      {preview && report ? (
        <div className="data-preview" data-testid="import-report" role="status">
          <h4>{preview.state === "committed" ? "Import complete" : "Import failed"}</h4>
          {report.error ? <p className="form-error">{report.error}</p> : null}
          {preview.state === "committed" ? (
            <p className="settings-hint">
              {
                report.items.filter(
                  (i) => i.action === "new" || i.action === "copy" || i.action === "degraded",
                ).length
              }{" "}
              items imported, {report.items.filter((i) => i.action === "identical").length} already
              present,{" "}
              {report.items.filter((i) => i.action === "conflict" || i.action === "skipped").length}{" "}
              skipped.
            </p>
          ) : null}
          <ItemList items={report.items.filter((i) => i.action !== "identical")} title="Details" />
        </div>
      ) : null}
    </section>
  );
}
