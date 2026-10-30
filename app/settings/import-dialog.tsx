import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ImportPreview, ImportReport } from "@shared/portability";
import { useChat } from "../chat/chat-context";
import { ApiError, apiJson, apiUpload } from "../lib/api";
import { Dialog } from "../ui/dialog";

type Step =
  | { kind: "uploading"; progress: number }
  | { kind: "preview"; preview: ImportPreview }
  | { kind: "importing"; preview: ImportPreview }
  | { kind: "done"; report: ImportReport }
  | { kind: "failed"; message: string };

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/** An archive upload started from the file picker (an event handler, not a render). */
export class PendingUpload {
  readonly file: File;
  readonly promise: Promise<ImportPreview>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(fraction: number) => void>();

  constructor(file: File) {
    this.file = file;
    this.promise = apiUpload<ImportPreview>("/api/import", file, file.name, {
      signal: this.controller.signal,
      onProgress: (fraction) => {
        for (const listener of this.listeners) listener(fraction);
      },
    });
  }

  onProgress(listener: (fraction: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  abort(): void {
    this.controller.abort();
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }
}

/**
 * Import a ChatUI archive (Phase 13d): upload, review what would change,
 * choose how to treat conflicts and which memories to add, then confirm.
 * Nothing is imported before the confirmation; Cancel discards the upload.
 */
export default function ImportDialog({
  upload,
  onClose,
}: {
  upload: PendingUpload;
  onClose: () => void;
}) {
  const file = upload.file;
  const { userId } = useChat();
  const client = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "uploading", progress: 0 });
  const [conflicts, setConflicts] = useState<"skip" | "copy">("skip");
  const [memories, setMemories] = useState<string[]>([]);
  const [preferences, setPreferences] = useState(false);
  useEffect(() => {
    let live = true;
    const stop = upload.onProgress((progress) => {
      if (live) setStep((s) => (s.kind === "uploading" ? { kind: "uploading", progress } : s));
    });
    upload.promise.then(
      (preview) => {
        if (live) setStep({ kind: "preview", preview });
      },
      (error: unknown) => {
        if (!live || upload.aborted) return;
        setStep({
          kind: "failed",
          message: error instanceof Error ? error.message : "The archive could not be read",
        });
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [upload]);

  const cancel = () => {
    upload.abort();
    if (step.kind === "preview")
      void apiJson(`/api/import/${step.preview.importId}`, { method: "DELETE" }).catch(
        () => undefined,
      );
    onClose();
  };

  const confirm = async (preview: ImportPreview) => {
    setStep({ kind: "importing", preview });
    try {
      const report = await apiJson<ImportReport>(`/api/import/${preview.importId}/commit`, {
        method: "POST",
        json: { conflicts, memories, preferences },
      });
      // Only this user's data can have changed.
      await client.invalidateQueries({ queryKey: ["u", userId] });
      setStep({ kind: "done", report });
    } catch (error) {
      setStep({
        kind: "failed",
        message:
          error instanceof ApiError || error instanceof Error
            ? error.message
            : "The import did not finish",
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (step.kind === "importing") return; // committing: wait for the report
          if (step.kind === "done" || step.kind === "failed") onClose();
          else cancel();
        }
      }}
      title="Import data"
      className="import-dialog"
    >
      {step.kind === "uploading" ? (
        <div className="import-body">
          <p>Reading {file.name}…</p>
          <progress
            className="import-progress"
            aria-label="Upload progress"
            max={1}
            value={step.progress}
          />
          <div className="dialog-actions">
            <button type="button" className="pill-button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : step.kind === "failed" ? (
        <div className="import-body">
          <p role="alert">{step.message}</p>
          <div className="dialog-actions">
            <button type="button" className="pill-button pill-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : step.kind === "done" ? (
        <div className="import-body" data-testid="import-report">
          <p role="status">
            Imported {plural(step.report.counts.conversations, "chat")},{" "}
            {plural(step.report.counts.files + step.report.counts.filesFromReplies, "file")} and{" "}
            {plural(step.report.counts.memories, "memory", "memories")}.
            {step.report.counts.present
              ? ` ${plural(step.report.counts.present, "chat")} were already here.`
              : ""}
          </p>
          {step.report.skipped.length > 0 ? (
            <>
              <p className="import-heading">Not imported</p>
              <ul className="import-list">
                {step.report.skipped.map((s) => (
                  <li key={`${s.kind}:${s.id}`}>
                    {s.kind}: {s.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="pill-button pill-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <ImportPreviewBody
          preview={step.preview}
          busy={step.kind === "importing"}
          conflicts={conflicts}
          setConflicts={setConflicts}
          memories={memories}
          setMemories={setMemories}
          preferences={preferences}
          setPreferences={setPreferences}
          onCancel={cancel}
          onConfirm={() => {
            void confirm(step.preview);
          }}
        />
      )}
    </Dialog>
  );
}

function ImportPreviewBody(props: {
  preview: ImportPreview;
  busy: boolean;
  conflicts: "skip" | "copy";
  setConflicts: (v: "skip" | "copy") => void;
  memories: string[];
  setMemories: (v: string[]) => void;
  preferences: boolean;
  setPreferences: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { preview } = props;
  const selectable = preview.memories.filter((m) => m.status !== "present");
  return (
    <div className="import-body" data-testid="import-preview">
      {preview.alreadyImported ? (
        <p className="import-note" role="status">
          You imported this archive before. Items already here are skipped.
        </p>
      ) : null}
      <ul className="import-summary">
        <li>{plural(preview.chats.new, "new chat")}</li>
        {preview.chats.present ? (
          <li>{plural(preview.chats.present, "chat")} already here</li>
        ) : null}
        {preview.chats.conflict ? (
          <li>{plural(preview.chats.conflict, "chat")} that differ from yours</li>
        ) : null}
        <li>
          {plural(preview.files, "file")}, {plural(preview.filesFromReplies, "file")} from replies
        </li>
        {preview.suggestions ? (
          <li>
            {plural(preview.suggestions, "memory suggestion")} (pending ones won’t be actionable)
          </li>
        ) : null}
      </ul>
      {preview.conflicts.length > 0 ? (
        <fieldset className="import-fieldset">
          <legend>Items that differ from yours ({preview.conflicts.length})</legend>
          <ul className="import-list">
            {preview.conflicts.slice(0, 20).map((c) => (
              <li key={`${c.kind}:${c.id}`}>
                {c.kind}: {c.label}
              </li>
            ))}
          </ul>
          <label className="import-choice">
            <input
              type="radio"
              name="conflicts"
              checked={props.conflicts === "skip"}
              onChange={() => {
                props.setConflicts("skip");
              }}
            />
            Keep mine and skip them
          </label>
          <label className="import-choice">
            <input
              type="radio"
              name="conflicts"
              checked={props.conflicts === "copy"}
              onChange={() => {
                props.setConflicts("copy");
              }}
            />
            Import them as copies
          </label>
        </fieldset>
      ) : null}
      {selectable.length > 0 ? (
        <fieldset className="import-fieldset">
          <legend>Memories to add (choose)</legend>
          {selectable.map((m) => (
            <label key={m.id} className="import-choice">
              <input
                type="checkbox"
                checked={props.memories.includes(m.id)}
                disabled={m.status === "name_taken"}
                onChange={(event) => {
                  props.setMemories(
                    event.currentTarget.checked
                      ? [...props.memories, m.id]
                      : props.memories.filter((id) => id !== m.id),
                  );
                }}
              />
              <span>
                <strong>{m.name}</strong>
                {m.status === "name_taken" ? " — you have a memory with this name" : ""}
                <span className="import-memory-body">{m.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {preview.hasPreferences ? (
        <label className="import-choice">
          <input
            type="checkbox"
            checked={props.preferences}
            onChange={(event) => {
              props.setPreferences(event.currentTarget.checked);
            }}
          />
          Also use the archive’s default model and image settings
        </label>
      ) : null}
      {preview.skipped.length > 0 ? (
        <p className="import-note">
          {plural(preview.skipped.length, "item")} can’t be imported and will be listed in the
          report.
        </p>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="pill-button"
          onClick={props.onCancel}
          disabled={props.busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="pill-button pill-primary"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy ? "Importing…" : "Import"}
        </button>
      </div>
    </div>
  );
}
