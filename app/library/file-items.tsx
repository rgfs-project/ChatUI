import { useQueryClient } from "@tanstack/react-query";
import {
  AudioLines,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { AttachmentDto } from "@shared/attachments";
import { useChat } from "../chat/chat-context";
import { contentUrl, formatSize } from "../chat/message-attachments";
import { useViewer } from "../chat/viewer";
import { apiFetch } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { formatSeparator } from "../lib/time";
import { useUi } from "../lib/ui-context";
import { useConfirm } from "../ui/dialog";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useToast } from "../ui/toast";

export function FileIcon({ file }: { file: AttachmentDto }) {
  if (file.kind === "audio") return <AudioLines size={18} aria-hidden />;
  if (file.kind === "image") return <ImageIcon size={18} aria-hidden />;
  return <FileText size={18} aria-hidden />;
}

export function titleOf(file: AttachmentDto, titles: Map<string, string>): string {
  if (file.status === "saved") return "Library";
  if (file.status === "pending") return "Not sent";
  return (file.conversationId && titles.get(file.conversationId)) ?? "Chat";
}

export function useFileActions(file: AttachmentDto) {
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

export function FileMenu({ file }: { file: AttachmentDto }) {
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

export function FileName({ file }: { file: AttachmentDto }) {
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

export function FileRow({ file, chatTitle }: { file: AttachmentDto; chatTitle: string }) {
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

export function FileCard({ file, chatTitle }: { file: AttachmentDto; chatTitle: string }) {
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
