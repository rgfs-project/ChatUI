import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

function sourceDate(preview: ImportPreview): string {
  const when = new Date(preview.exportCreatedAt).toLocaleString();
  return preview.source === "chatui" ? `Exported ${when}.` : `Latest change ${when}.`;
}

/** The browser's time zone, for sources that record none (duck.ai). */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

/**
 * Uploads with progress (XHR: fetch reports no upload progress). The server
 * works out the source; a non-ZIP goes as opaque bytes no body parser reads.
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
  if (kinds.length === 0) return <p className="row-hint">Nothing in this file can be imported.</p>;
  return (
    <table className="data-table">
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
            <span className="data-kind">{KIND_LABEL[i.kind]}</span> {i.label} —{" "}
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
 * Settings → Data (lazy): export everything as one archive, and import a
 * ChatUI export, a Claude data export or a duck.ai chat. An import is shown
 * first, needs confirming, can be cancelled before it commits, and ends with
 * a report.
 */
export default function DataSettings({ userId }: { userId: string }) {
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
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

  // Poll while the commit runs, then refresh everything it may have touched.
  const committing = preview?.state === "committing";
  const previewId = preview?.importId;
  useEffect(() => {
    if (!committing || !previewId) return;
    const timer = setInterval(() => {
      void apiJson<ImportPreview>(`/api/imports/${encodeURIComponent(previewId)}`).then(
        setPreview,
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
      "projects",
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
    <>
      <h1 className="page-title">Data</h1>
      <section className="section">
        <h2 className="section-title">Export</h2>
        <div className="group">
          <div className="row">
            <div className="row-text">
              <span className="row-label">All your data</span>
              <span className="row-hint">
                Chats, files, memories, skills and preferences in one archive. Your password isn’t
                included.
              </span>
            </div>
            <div className="row-actions">
              {exported ? (
                <a
                  className="btn sm outline"
                  href={`/api/exports/${encodeURIComponent(exported.exportId)}/download`}
                  download
                  data-testid="export-download"
                >
                  Download ({formatBytes(exported.size)})
                </a>
              ) : null}
              <button
                className="btn sm primary"
                type="button"
                disabled={exportAll.isPending}
                onClick={() => {
                  exportAll.mutate();
                }}
              >
                <Download size={16} aria-hidden />
                {exportAll.isPending ? "Preparing…" : "Export all data"}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Import</h2>
        <div className="group">
          <div className="row">
            <div className="row-text">
              <span className="row-label">Import chats</span>
              <span className="row-hint">
                A ChatUI export, a Claude data export or a duck.ai chat. Nothing changes until you
                confirm, and nothing is overwritten.
              </span>
            </div>
            <div className="row-actions">
              {uploading ? (
                <>
                  <progress max={1} value={uploading.fraction} aria-label="Uploading file" />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      uploading.controller.abort();
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <label className="btn sm outline file-pick">
                  <Upload size={16} aria-hidden /> Choose file…
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".zip,.json,.txt,application/zip,application/json,text/plain"
                    className="visually-hidden"
                    disabled={committing}
                    onChange={(event) => void choose(event.currentTarget.files?.[0])}
                  />
                </label>
              )}
            </div>
          </div>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {preview?.state === "previewed" ? (
        <section className="section" data-testid="import-preview">
          <h2 className="section-title">Preview: {SOURCE_LABELS[preview.source]}</h2>
          <div className="group data-card">
            <p className="row-hint">{sourceDate(preview)}</p>
            <Summary counts={preview.counts} />
            {preview.warnings.map((w) => (
              <p key={w} className="row-hint">
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
                  />
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
                  />
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
                    />
                    <span>
                      {m.name}
                      {m.action === "identical"
                        ? " (already saved)"
                        : m.action === "conflict"
                          ? " (a memory with this name exists)"
                          : ""}
                    </span>
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
                />
                <span>
                  This export was imported on{" "}
                  {new Date(preview.previousImport.committedAt).toLocaleString()}. Import it again
                </span>
              </label>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="btn dialog-btn" onClick={() => void cancel()}>
                Cancel
              </button>
              <button
                className="btn dialog-btn primary"
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
        </section>
      ) : null}

      {preview && committing ? (
        <div className="group data-card" role="status">
          <span>Importing…</span>
          <progress
            max={Math.max(1, preview.progress.total)}
            value={preview.progress.done}
            aria-label="Import progress"
          />
        </div>
      ) : null}

      {preview && report ? (
        <section className="section" data-testid="import-report" role="status">
          <h2 className="section-title">
            {preview.state === "committed" ? "Import complete" : "Import failed"}
          </h2>
          <div className="group data-card">
            {report.error ? <p className="form-error">{report.error}</p> : null}
            {preview.state === "committed" ? (
              <p className="row-hint">
                {
                  report.items.filter(
                    (i) => i.action === "new" || i.action === "copy" || i.action === "degraded",
                  ).length
                }{" "}
                items imported, {report.items.filter((i) => i.action === "identical").length}{" "}
                already present,{" "}
                {
                  report.items.filter((i) => i.action === "conflict" || i.action === "skipped")
                    .length
                }{" "}
                skipped.
              </p>
            ) : null}
            <ItemList
              items={report.items.filter((i) => i.action !== "identical")}
              title="Details"
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
