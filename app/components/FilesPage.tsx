import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Download,
  Ellipsis,
  Eye,
  File,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image,
  Music,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { FileCategory, FileItem } from "@shared/files";
import { currentSession } from "../lib/api";
import { formatBytes } from "../lib/format";
import { paths } from "../lib/paths";
import { ApiError, apiJson, queries, queryKeys } from "../lib/query";
import { useSidebar } from "../lib/sidebar-context";
import { ConfirmDialog } from "./Dialogs";
import "./files.css";

const ArtifactPanel = lazy(() => import("./ArtifactPanel"));

const FILTERS: readonly { id: FileCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "document", label: "Documents" },
  { id: "image", label: "Images" },
  { id: "code", label: "Code" },
  { id: "data", label: "Data" },
  { id: "audio", label: "Audio" },
];

const ICON: Record<FileCategory, ReactNode> = {
  image: <Image size={18} aria-hidden />,
  document: <FileText size={18} aria-hidden />,
  code: <FileCode size={18} aria-hidden />,
  audio: <Music size={18} aria-hidden />,
  data: <FileSpreadsheet size={18} aria-hidden />,
  other: <File size={18} aria-hidden />,
};

/** "Today", "Yesterday", else "Oct 9" (with the year when it isn't this one). */
function added(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(today) - day(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Uploads one file to keep in Files (multipart, like the composer's uploads). */
function uploadToLibrary(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");
    const session = currentSession();
    if (session?.csrfToken && session.user) {
      xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
      xhr.setRequestHeader("X-Expected-User", session.user.id);
    }
    xhr.onload = () => {
      if (xhr.status === 201) resolve();
      else {
        const response = xhr.response as { error?: { message?: string } } | null;
        reject(new Error(response?.error?.message ?? `${file.name} couldn’t be uploaded.`));
      }
    };
    xhr.onerror = () => {
      reject(new Error("The upload failed. Check your connection and try again."));
    };
    xhr.send(body);
  });
}

/**
 * Files: everything you attached or a reply produced, in one place. Search,
 * filter by kind, upload files to keep, open the chat a file came from.
 */
export function FilesPage({ userId }: { userId: string }) {
  const client = useQueryClient();
  const { narrow } = useSidebar();
  const list = useQuery(queries.files(userId));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FileCategory | "all">("all");
  const [deleting, setDeleting] = useState<FileItem | null>(null);
  const [viewing, setViewing] = useState<{ file: FileItem; trigger: HTMLElement } | null>(null);
  const [uploading, setUploading] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.files(userId) });
    void client.invalidateQueries({ queryKey: queryKeys.artifacts(userId) });
    void client.invalidateQueries({ queryKey: queryKeys.attachmentLimits(userId) });
  };
  const remove = useMutation({
    mutationFn: (file: FileItem) =>
      apiJson(
        file.origin === "reply"
          ? `/api/artifacts/${encodeURIComponent(file.id)}`
          : `/api/files/${encodeURIComponent(file.id)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, file) => {
      setNotice({ text: `${file.name} deleted.`, error: false });
    },
    onError: (e) => {
      setNotice({
        text: e instanceof ApiError ? e.message : "The file couldn’t be deleted.",
        error: true,
      });
    },
    onSettled: refresh,
  });

  const upload = async (files: File[]) => {
    setNotice(null);
    setUploading(files.length);
    const failed: string[] = [];
    for (const file of files) {
      try {
        await uploadToLibrary(file);
      } catch (e) {
        failed.push(e instanceof Error ? e.message : file.name);
      }
      setUploading((n) => n - 1);
    }
    refresh();
    setNotice(
      failed.length > 0
        ? { text: failed.join(" "), error: true }
        : {
            text: `${String(files.length)} file${files.length === 1 ? "" : "s"} uploaded.`,
            error: false,
          },
    );
  };

  const q = query.trim().toLowerCase();
  const files = (list.data?.files ?? []).filter(
    (f) =>
      (filter === "all" || f.category === filter) &&
      (q === "" ||
        f.name.toLowerCase().includes(q) ||
        (f.conversationTitle ?? "").toLowerCase().includes(q)),
  );
  const total = list.data?.files.length ?? 0;

  return (
    <main className="files-page" data-testid="files-page">
      {narrow ? (
        <header className="mobile-head">
          <Link to={paths.newChat()} className="icon-btn" aria-label="Back">
            <ArrowLeft size={20} aria-hidden />
          </Link>
          <span className="title">Files</span>
        </header>
      ) : null}
      <div className="page-scroll">
        <div className="page-body wide">
          <div className="page-head">
            <h1 className="page-title">Files</h1>
            <label className={`btn primary file-pick${uploading > 0 ? " busy" : ""}`}>
              <Upload size={16} aria-hidden /> {uploading > 0 ? "Uploading…" : "Upload"}
              <input
                ref={fileRef}
                type="file"
                multiple
                className="visually-hidden"
                disabled={uploading > 0}
                onChange={(event) => {
                  const picked = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (picked.length > 0) void upload(picked);
                }}
              />
            </label>
          </div>
          <div className="files-tools">
            <label className="search-field grow">
              <Search size={16} aria-hidden />
              <input
                type="search"
                placeholder="Search files"
                aria-label="Search files"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
              />
            </label>
            <div className="chips" role="group" aria-label="File type">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="chip"
                  aria-pressed={filter === f.id}
                  onClick={() => {
                    setFilter(f.id);
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <p
            className={notice?.error ? "form-error" : "section-hint"}
            role="status"
            aria-live="polite"
          >
            {notice?.text ?? ""}
          </p>
          {list.isPending ? (
            <p className="hint">Loading files…</p>
          ) : list.isError ? (
            <div className="alert danger" role="alert">
              <span className="alert-text">Your files couldn’t be loaded.</span>
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                Try again
              </button>
            </div>
          ) : total === 0 ? (
            <section className="group files-empty" data-testid="files-empty">
              <div className="row">
                <div className="row-text">
                  <h2 className="row-label">No files yet</h2>
                  <p className="row-hint">
                    Files you attach to messages, files replies produce and files you upload here
                    all show up in one place.
                  </p>
                </div>
                <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>
                  Upload a file
                </button>
              </div>
            </section>
          ) : (
            <section className="group files-table" aria-label="Your files">
              <div className="files-head" aria-hidden>
                <span className="col-icon" />
                <span className="col-name">Name</span>
                <span className="col-chat">Chat</span>
                <span className="col-date">Added</span>
                <span className="col-menu" />
              </div>
              <ul>
                {files.map((file) => (
                  <li key={`${file.origin}:${file.id}`} className="file-row" data-testid="file-row">
                    <span className="file-icon col-icon" aria-hidden>
                      {ICON[file.category]}
                    </span>
                    <div className="col-name file-text">
                      <span className="file-name">{file.name}</span>
                      <span className="file-meta">
                        <span className="wide-only">
                          {file.kindLabel} · {formatBytes(file.size)}
                        </span>
                        <span className="narrow-only">{added(file.createdAt)}</span>
                      </span>
                    </div>
                    <span className="col-chat">
                      {file.conversationId && file.conversationTitle ? (
                        <Link
                          to={`${paths.chat(file.conversationId)}${file.messageId ? `#m-${file.messageId}` : ""}`}
                          className="chat-link"
                        >
                          {file.conversationTitle}
                        </Link>
                      ) : (
                        <span className="muted">
                          {file.conversationId ? "Chat deleted" : "Uploaded here"}
                        </span>
                      )}
                    </span>
                    <span className="col-date muted">
                      <time dateTime={file.createdAt}>{added(file.createdAt)}</time>
                    </span>
                    <Menu.Root modal={false}>
                      <Menu.Trigger
                        className="icon-btn col-menu"
                        aria-label={`Options for ${file.name}`}
                      >
                        <Ellipsis size={18} aria-hidden />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Content
                          className="menu"
                          align="end"
                          sideOffset={4}
                          collisionPadding={8}
                        >
                          {file.origin === "reply" ? (
                            <Menu.Item
                              className="menu-item"
                              onSelect={() => {
                                const trigger = document.activeElement;
                                setViewing({
                                  file,
                                  trigger: trigger instanceof HTMLElement ? trigger : document.body,
                                });
                              }}
                            >
                              <Eye size={20} aria-hidden /> View source
                            </Menu.Item>
                          ) : null}
                          <Menu.Item asChild className="menu-item">
                            <a href={file.downloadUrl} download={file.name}>
                              <Download size={20} aria-hidden /> Download
                            </a>
                          </Menu.Item>
                          <Menu.Separator className="menu-separator" />
                          <Menu.Item
                            className="menu-item"
                            onSelect={() => {
                              setDeleting(file);
                            }}
                          >
                            <Trash2 size={20} aria-hidden /> Delete
                          </Menu.Item>
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu.Root>
                  </li>
                ))}
                {files.length === 0 ? (
                  <li className="row row-hint files-none">No files match.</li>
                ) : null}
              </ul>
            </section>
          )}
          {list.data && total > 0 ? (
            <p className="files-foot">
              {total} file{total === 1 ? "" : "s"} · {formatBytes(list.data.usedBytes)} of{" "}
              {formatBytes(list.data.quotaBytes)} used
            </p>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this file?"
        description={
          deleting?.origin === "upload" && deleting.conversationId
            ? `“${deleting.name}” is removed from the chat it was sent in, too.`
            : `“${deleting?.name ?? ""}” is removed for good.`
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      />
      {viewing ? (
        <Suspense fallback={null}>
          <ArtifactPanel
            userId={userId}
            artifact={{
              id: viewing.file.id,
              name: viewing.file.name,
              language: viewing.file.kindLabel,
              size: viewing.file.size,
            }}
            trigger={viewing.trigger}
            onClose={() => {
              setViewing(null);
              refresh();
            }}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
