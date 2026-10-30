import { useQuery, useQueryClient } from "@tanstack/react-query";
import "./library.css";
import {
  ArrowDownUp,
  AudioLines,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Grid2x2,
  Image as ImageIcon,
  List,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  SquarePen,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { ArtifactDto, ArtifactList } from "@shared/artifacts";
import type { AttachmentDto, AttachmentList } from "@shared/attachments";
import { openArtifact } from "../chat/artifact-events";
import { useChat } from "../chat/chat-context";
import { contentUrl, formatSize } from "../chat/message-attachments";
import { ACCEPT } from "../chat/composer-files";
import { useViewer, ViewerProvider, type ViewerImage } from "../chat/viewer";
import { apiFetch, apiJson, apiUpload } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { conversationsQuery } from "../lib/query/queries";
import { formatSeparator } from "../lib/time";
import { useUi } from "../lib/ui-context";
import { useConfirm } from "../ui/dialog";
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "../ui/menu";
import { PageHeader } from "../ui/page-header";
import { useToast } from "../ui/toast";

export const handle = { kind: "page" };

type Kind = "all" | "images" | "audio" | "documents" | "created";
type Sort = "newest" | "oldest" | "name" | "size";

const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Documents" },
  { id: "created", label: "From replies" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "name", label: "Name" },
  { id: "size", label: "Largest first" },
];

const MATCHES: Record<Kind, (file: AttachmentDto) => boolean> = {
  all: () => true,
  images: (f) => f.kind === "image",
  audio: (f) => f.kind === "audio",
  documents: (f) => f.kind === "text",
  created: () => false,
};

const COMPARE: Record<Sort, (a: AttachmentDto, b: AttachmentDto) => number> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  name: (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" }),
  size: (a, b) => b.size - a.size,
};

function oneOf<T extends string>(
  value: string | null,
  options: readonly { id: T }[],
  fallback: T,
): T {
  return options.find((o) => o.id === value)?.id ?? fallback;
}

function FileIcon({ file }: { file: AttachmentDto }) {
  if (file.kind === "audio") return <AudioLines size={18} aria-hidden />;
  if (file.kind === "image") return <ImageIcon size={18} aria-hidden />;
  return <FileText size={18} aria-hidden />;
}

function useLibraryFiles(userId: string) {
  return useQuery({
    queryKey: qk.attachments(userId),
    queryFn: ({ signal }) => apiJson<AttachmentList>("/api/attachments", { signal }),
  });
}

/**
 * Library (Phase 12b): every file you have uploaded, from chats or straight
 * here. Search, type filter, sort and view live in the URL, so they survive
 * reloads and Back. Files that belong to a chat are removed with their chat.
 */
export default function Library() {
  const { userId } = useChat();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "grid" ? "grid" : "list";
  const kind = oneOf(params.get("type"), KINDS, "all");
  const sort = oneOf(params.get("sort"), SORTS, "newest");
  const query = params.get("q") ?? "";
  const files = useLibraryFiles(userId);
  const chats = useQuery(conversationsQuery(userId));
  const titles = useMemo(
    () => new Map((chats.data ?? []).map((c) => [c.id, c.title])),
    [chats.data],
  );
  const update = (key: string, value: string | null) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (files.data?.attachments ?? [])
      .filter(MATCHES[kind])
      .filter((f) => needle === "" || f.filename.toLowerCase().includes(needle))
      .sort(COMPARE[sort]);
  }, [files.data, kind, query, sort]);
  const images = useMemo(
    () =>
      shown
        .filter((f) => f.kind === "image")
        .map((f): ViewerImage => ({
          id: f.id,
          missing: false,
          filename: f.filename,
          mediaType: f.mediaType,
          kind: f.kind,
          size: f.size,
          width: f.width,
          height: f.height,
        })),
    [shown],
  );

  return (
    <ViewerProvider images={images}>
      <div className="page library">
        <title>Library · ChatUI</title>
        <PageHeader title="Library">
          <NewMenu userId={userId} />
        </PageHeader>
        <div className="page-body">
          <div className="library-toolbar" role="toolbar" aria-label="Library tools">
            <label className="library-search">
              <Search size={16} aria-hidden />
              <input
                type="search"
                className="selectable"
                placeholder="Search files"
                aria-label="Search files"
                defaultValue={query}
                onChange={(event) => {
                  update("q", event.currentTarget.value);
                }}
              />
            </label>
            <div className="segmented" role="group" aria-label="File type">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  aria-pressed={kind === k.id}
                  onClick={() => {
                    update("type", k.id === "all" ? null : k.id);
                  }}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="library-tools-end">
              <Menu
                label="Sort"
                align="end"
                trigger={
                  <button
                    type="button"
                    className="pill-button"
                    aria-label={`Sort: ${SORTS.find((s) => s.id === sort)?.label ?? ""}`}
                  >
                    <ArrowDownUp size={16} aria-hidden />
                    <span className="library-sort-label">
                      {SORTS.find((s) => s.id === sort)?.label}
                    </span>
                  </button>
                }
              >
                <MenuRadioGroup
                  value={sort}
                  onValueChange={(value) => {
                    update("sort", value === "newest" ? null : value);
                  }}
                >
                  {SORTS.map((s) => (
                    <MenuRadioItem key={s.id} value={s.id}>
                      {s.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </Menu>
              <div className="segmented" role="group" aria-label="View">
                <button
                  type="button"
                  aria-label="List view"
                  aria-pressed={view === "list"}
                  onClick={() => {
                    update("view", null);
                  }}
                >
                  <List size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Grid view"
                  aria-pressed={view === "grid"}
                  onClick={() => {
                    update("view", "grid");
                  }}
                >
                  <Grid2x2 size={16} aria-hidden />
                </button>
              </div>
            </div>
          </div>
          {files.data ? (
            <p className="library-usage">
              {formatSize(files.data.usedBytes)} of {formatSize(files.data.quotaBytes)} used
            </p>
          ) : null}
          {kind === "created" ? (
            <CreatedFiles userId={userId} query={query} sort={sort} titles={titles} />
          ) : files.isPending ? (
            <p className="library-note">Loading files…</p>
          ) : files.isError ? (
            <p className="library-note" role="alert">
              Your files could not be loaded.
            </p>
          ) : shown.length === 0 ? (
            <p className="library-note" data-testid="library-empty">
              {files.data.attachments.length === 0
                ? "No files yet. Upload files here, or attach them to a message."
                : "No files match."}
            </p>
          ) : view === "grid" ? (
            <ul className="library-grid" data-testid="library-grid">
              {shown.map((file) => (
                <FileCard key={file.id} file={file} chatTitle={titleOf(file, titles)} />
              ))}
            </ul>
          ) : (
            <table className="library-table" data-testid="library-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="col-chat">Chat</th>
                  <th className="col-size">Size</th>
                  <th className="col-date">Added</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((file) => (
                  <FileRow key={file.id} file={file} chatTitle={titleOf(file, titles)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </ViewerProvider>
  );
}

function titleOf(file: AttachmentDto, titles: Map<string, string>): string {
  if (file.status === "saved") return "Library";
  if (file.status === "pending") return "Not sent";
  return (file.conversationId && titles.get(file.conversationId)) ?? "Chat";
}

function NewMenu({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const picker = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(0);
  async function upload(list: File[]) {
    setUploading((n) => n + list.length);
    let failed = 0;
    for (const file of list) {
      try {
        await apiUpload("/api/attachments?to=library", file, file.name);
      } catch (error) {
        failed++;
        toast(`${file.name}: ${error instanceof Error ? error.message : "upload failed"}`, "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    await client.invalidateQueries({ queryKey: qk.attachments(userId) });
    if (failed < list.length)
      toast(list.length - failed === 1 ? "File uploaded." : "Files uploaded.");
  }
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        data-testid="library-file-input"
        onChange={(event) => {
          void upload(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      {uploading > 0 ? (
        <span className="library-uploading" role="status">
          Uploading {uploading}…
        </span>
      ) : null}
      <Menu
        label="New"
        align="end"
        trigger={
          <button type="button" className="pill-button pill-primary" aria-label="New">
            <Plus size={16} aria-hidden />
            <span>New</span>
          </button>
        }
      >
        <MenuItem
          icon={<Upload size={16} aria-hidden />}
          onSelect={() => {
            picker.current?.click();
          }}
        >
          Upload files
        </MenuItem>
        <MenuItem
          icon={<SquarePen size={16} aria-hidden />}
          onSelect={() => {
            void navigate(paths.newChat());
          }}
        >
          New chat
        </MenuItem>
      </Menu>
    </>
  );
}

function useFileActions(file: AttachmentDto) {
  const { userId } = useChat();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const viewer = useViewer();
  const navigate = useNavigate();
  const deletable = file.status !== "linked";
  return {
    deletable,
    open: () => {
      if (file.kind === "image") viewer.open(file.id);
      else window.location.assign(contentUrl(file.id, true));
    },
    goToChat:
      file.conversationId === null
        ? null
        : () => {
            void navigate(paths.chat(file.conversationId ?? ""));
          },
    remove: async () => {
      const yes = await confirm({
        title: `Delete ${file.filename}?`,
        body: "The file is removed from your Library. This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!yes) return;
      const response = await apiFetch(`/api/attachments/${file.id}`, { method: "DELETE" });
      if (response.ok) toast("File deleted.");
      else toast("The file could not be deleted.", "error");
      await client.invalidateQueries({ queryKey: qk.attachments(userId) });
    },
  };
}

function FileMenu({ file }: { file: AttachmentDto }) {
  const actions = useFileActions(file);
  return (
    <Menu
      label={`Options for ${file.filename}`}
      align="end"
      trigger={
        <button type="button" className="icon-button" aria-label={`Options for ${file.filename}`}>
          <MoreHorizontal size={18} aria-hidden />
        </button>
      }
    >
      {file.kind === "image" ? (
        <MenuItem icon={<ExternalLink size={16} aria-hidden />} onSelect={actions.open}>
          Open
        </MenuItem>
      ) : null}
      <MenuItem
        icon={<Download size={16} aria-hidden />}
        onSelect={() => {
          window.location.assign(contentUrl(file.id, true));
        }}
      >
        Download
      </MenuItem>
      {actions.goToChat ? (
        <MenuItem icon={<MessageSquare size={16} aria-hidden />} onSelect={actions.goToChat}>
          Go to chat
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        danger
        disabled={!actions.deletable}
        icon={<Trash2 size={16} aria-hidden />}
        onSelect={() => {
          void actions.remove();
        }}
      >
        {actions.deletable ? "Delete" : "Delete (remove it with its chat)"}
      </MenuItem>
    </Menu>
  );
}

function FileName({ file }: { file: AttachmentDto }) {
  const actions = useFileActions(file);
  return (
    <button type="button" className="library-name" onClick={actions.open} title={file.filename}>
      {file.kind === "image" ? (
        <img
          src={contentUrl(file.id)}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="library-icon">
          <FileIcon file={file} />
        </span>
      )}
      <span className="library-name-text">{file.filename}</span>
    </button>
  );
}

function FileRow({ file, chatTitle }: { file: AttachmentDto; chatTitle: string }) {
  const { timeFormat } = useUi();
  return (
    <tr data-testid="library-row">
      <td>
        <FileName file={file} />
      </td>
      <td className="col-chat">
        {file.status === "linked" && file.conversationId ? (
          <Link to={paths.chat(file.conversationId)} className="library-chat">
            {chatTitle}
          </Link>
        ) : (
          <span className="library-muted">{chatTitle}</span>
        )}
      </td>
      <td className="col-size">{formatSize(file.size)}</td>
      <td className="col-date">{formatSeparator(file.createdAt, timeFormat)}</td>
      <td className="col-actions">
        <FileMenu file={file} />
      </td>
    </tr>
  );
}

function FileCard({ file, chatTitle }: { file: AttachmentDto; chatTitle: string }) {
  const actions = useFileActions(file);
  return (
    <li className="library-card" data-testid="library-card">
      <button
        type="button"
        className="library-card-preview"
        onClick={actions.open}
        aria-label={`Open ${file.filename}`}
      >
        {file.kind === "image" ? (
          <img
            src={contentUrl(file.id)}
            alt=""
            width={file.width ?? 160}
            height={file.height ?? 120}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <FileIcon file={file} />
        )}
      </button>
      <div className="library-card-text">
        <span className="library-name-text" title={file.filename}>
          {file.filename}
        </span>
        <span className="library-muted">
          {formatSize(file.size)} · {chatTitle}
        </span>
      </div>
      <FileMenu file={file} />
    </li>
  );
}

const COMPARE_CREATED: Record<Sort, (a: ArtifactDto, b: ArtifactDto) => number> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  name: (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" }),
  size: (a, b) => b.size - a.size,
};

/**
 * Files captured from replies (Phase 13c). They outlive their chat; deleting
 * one never touches the chat, and a deleted file is never captured again.
 */
function CreatedFiles({
  userId,
  query,
  sort,
  titles,
}: {
  userId: string;
  query: string;
  sort: Sort;
  titles: Map<string, string>;
}) {
  const { timeFormat } = useUi();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const created = useQuery({
    queryKey: qk.artifacts(userId),
    queryFn: ({ signal }) => apiJson<ArtifactList>("/api/artifacts", { signal }),
  });
  const needle = query.trim().toLowerCase();
  const shown = (created.data?.artifacts ?? [])
    .filter((a) => needle === "" || a.filename.toLowerCase().includes(needle))
    .sort(COMPARE_CREATED[sort]);
  if (created.isPending) return <p className="library-note">Loading files…</p>;
  if (created.isError)
    return (
      <p className="library-note" role="alert">
        Your files could not be loaded.
      </p>
    );
  if (shown.length === 0)
    return (
      <p className="library-note" data-testid="library-empty">
        {created.data.artifacts.length === 0
          ? "No files from replies yet. Files a model creates appear here."
          : "No files match."}
      </p>
    );
  return (
    <table className="library-table" data-testid="library-created">
      <thead>
        <tr>
          <th>Name</th>
          <th className="col-chat">Chat</th>
          <th className="col-size">Size</th>
          <th className="col-date">Created</th>
          <th>
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {shown.map((file) => (
          <tr key={file.id} data-testid="library-row">
            <td>
              <button
                type="button"
                className="library-name"
                onClick={() => {
                  openArtifact(file.id);
                }}
              >
                <FileCode2 size={18} aria-hidden />
                <span className="library-name-text">{file.filename}</span>
              </button>
            </td>
            <td className="col-chat">
              {file.conversationAvailable ? (
                <Link to={paths.chat(file.conversationId)} className="library-chat">
                  {titles.get(file.conversationId) ?? "Chat"}
                </Link>
              ) : (
                <span className="library-muted">Chat deleted</span>
              )}
            </td>
            <td className="col-size">{formatSize(file.size)}</td>
            <td className="col-date">{formatSeparator(file.createdAt, timeFormat)}</td>
            <td className="col-actions">
              <Menu
                label={`Options for ${file.filename}`}
                align="end"
                trigger={
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Options for ${file.filename}`}
                  >
                    <MoreHorizontal size={18} aria-hidden />
                  </button>
                }
              >
                <MenuItem
                  icon={<ExternalLink size={16} aria-hidden />}
                  onSelect={() => {
                    openArtifact(file.id);
                  }}
                >
                  Open
                </MenuItem>
                <MenuItem
                  icon={<Download size={16} aria-hidden />}
                  onSelect={() => {
                    window.location.assign(`/api/artifacts/${file.id}/source?download=1`);
                  }}
                >
                  Download
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 size={16} aria-hidden />}
                  danger
                  onSelect={() => {
                    void (async () => {
                      const yes = await confirm({
                        title: "Delete this file?",
                        body: `“${file.filename}” is deleted. Its chat stays as it is.`,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!yes) return;
                      try {
                        await apiJson(`/api/artifacts/${file.id}`, { method: "DELETE" });
                        toast("File deleted.");
                      } catch (error) {
                        toast(error instanceof Error ? error.message : "Could not delete", "error");
                      }
                      await client.invalidateQueries({ queryKey: ["u", userId] });
                    })();
                  }}
                >
                  Delete
                </MenuItem>
              </Menu>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
