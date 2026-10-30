import { Download, Upload } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import type { PendingUpload } from "./import-dialog";
import { Row } from "./row";

const ImportDialog = lazy(() => import("./import-dialog"));

/** Export everything (Phase 13d): one ZIP with chats, files, memories and settings. */
export function ExportAll() {
  return (
    <Row
      label="Export data"
      hint="A ZIP archive of your chats, files, files from replies, memories, suggestions and settings. Your password and sessions are not included."
    >
      <a className="pill-button" href="/api/export" download data-testid="export-all">
        <Download size={16} aria-hidden />
        Export
      </a>
    </Row>
  );
}

/** Import a ChatUI archive: preview first, then confirm. Nothing is ever overwritten. */
export function ImportData() {
  const picker = useRef<HTMLInputElement | null>(null);
  const [upload, setUpload] = useState<PendingUpload | null>(null);
  return (
    <Row
      label="Import data"
      hint="Bring in a ChatUI archive. You see what would change first; nothing you have is replaced."
    >
      <input
        ref={picker}
        type="file"
        accept=".zip,application/zip"
        hidden
        data-testid="import-file-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          // The dialog's chunk loads on demand; the upload starts with it.
          void import("./import-dialog").then((m) => {
            setUpload(new m.PendingUpload(file));
          });
        }}
      />
      <button
        type="button"
        className="pill-button"
        onClick={() => {
          picker.current?.click();
        }}
      >
        <Upload size={16} aria-hidden />
        Import
      </button>
      {upload ? (
        <Suspense fallback={null}>
          <ImportDialog
            upload={upload}
            onClose={() => {
              setUpload(null);
            }}
          />
        </Suspense>
      ) : null}
    </Row>
  );
}
