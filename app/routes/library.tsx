import "./library.css";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Grid2x2, List, Search } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import type { AttachmentList } from "@shared/attachments";
import { useChat } from "../chat/chat-context";
import { formatSize } from "../chat/message-attachments";
import { ViewerProvider, type ViewerImage } from "../chat/viewer";
import { apiJson } from "../lib/api";
import { qk } from "../lib/query/keys";
import { conversationsQuery } from "../lib/query/queries";
import { Menu, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { PageHeader } from "../ui/page-header";
import { KINDS, SORTS, MATCHES, COMPARE, oneOf } from "../library/sort";
import { titleOf, FileRow, FileCard } from "../library/file-items";
import { NewMenu } from "../library/new-menu";
import { CreatedFiles } from "../library/created-files";

export const handle = { kind: "page" };

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
