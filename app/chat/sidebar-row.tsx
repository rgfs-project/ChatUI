import { openProjectDialog } from "./project-dialogs";
import { FolderInput, MoreHorizontal, Pin, PinOff, Pencil, Trash2 } from "lucide-react";
import { memo } from "react";
import { Link } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { paths } from "../lib/paths";
import type { usePrefetcher } from "../lib/prefetch";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useChat } from "./chat-context";
import { useConversationOps } from "./conversation-ops";

export const ConversationRow = memo(function ConversationRow({
  item,
  active,
  pinned,
  prefetcher,
}: {
  item: ConversationSummary;
  active: boolean;
  pinned: boolean;
  prefetcher: ReturnType<typeof usePrefetcher>;
}) {
  const { rename, remove } = useChat();
  const ops = useConversationOps();
  const warm =
    item.malformed || active
      ? undefined
      : () => {
          prefetcher.intent(item.id);
        };
  const cool = () => {
    prefetcher.cancel(item.id);
  };
  return (
    <li className={`chat-row${active ? " is-active" : ""}`}>
      <Link
        to={paths.chat(item.id)}
        className="chat-link"
        aria-current={active ? "page" : undefined}
        title={item.title}
        onPointerEnter={(event) => {
          // Mouse hover only: touch never depends on (or triggers) hover prefetch.
          if (event.pointerType === "mouse") warm?.();
        }}
        onPointerLeave={cool}
        onFocus={warm}
        onBlur={cool}
      >
        <span className="chat-title">
          <span className="chat-title-text">{item.title}</span>
        </span>
        {item.malformed ? <span className="chat-flag">Unreadable</span> : null}
      </Link>
      {pinned ? (
        <button
          type="button"
          className="row-menu row-unpin"
          aria-label={`Unpin ${item.title}`}
          onClick={() => {
            void ops.togglePin(item.id);
          }}
        >
          <Pin size={14} aria-hidden />
        </button>
      ) : null}
      <Menu
        label={`Options for ${item.title}`}
        align="start"
        trigger={
          <button type="button" className="row-menu" aria-label={`Options for ${item.title}`}>
            <MoreHorizontal size={16} aria-hidden />
          </button>
        }
      >
        {item.malformed ? null : (
          <MenuItem
            icon={<Pencil size={16} aria-hidden />}
            onSelect={() => {
              rename({ id: item.id, title: item.title });
            }}
          >
            Rename
          </MenuItem>
        )}
        <MenuItem
          icon={pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
          onSelect={() => {
            void ops.togglePin(item.id);
          }}
        >
          {pinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash2 size={16} aria-hidden />}
          onSelect={() => {
            void remove(item.id, item.title);
          }}
        >
          Delete
        </MenuItem>
        {item.malformed ? null : <MenuSeparator />}
        {item.malformed ? null : (
          <MenuItem
            icon={<FolderInput size={16} aria-hidden />}
            onSelect={() => {
              openProjectDialog({ kind: "move", conversationId: item.id });
            }}
          >
            Move to project…
          </MenuItem>
        )}
      </Menu>
    </li>
  );
});
