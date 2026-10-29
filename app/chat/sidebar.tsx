import { useQuery } from "@tanstack/react-query";
import {
  Keyboard,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { memo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { paths, type OverlayState } from "../lib/paths";
import { usePrefetcher } from "../lib/prefetch";
import { conversationsQuery } from "../lib/query/queries";
import { useRenderProbe } from "../lib/render-probe";
import { useUi } from "../lib/ui-context";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useChat } from "./chat-context";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/** Opens an overlay over the current page; Back closes it (INV-53). */
export function useOpenOverlay(): (to: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (to: string) => {
    const background =
      (location.state as Partial<OverlayState> | null)?.background ?? location.pathname;
    void navigate(to, { state: { background } satisfies OverlayState });
  };
}

const ConversationRow = memo(function ConversationRow({
  item,
  active,
  prefetcher,
}: {
  item: ConversationSummary;
  active: boolean;
  prefetcher: ReturnType<typeof usePrefetcher>;
}) {
  const { rename, remove } = useChat();
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
          danger
          icon={<Trash2 size={16} aria-hidden />}
          onSelect={() => {
            void remove(item.id, item.title);
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </li>
  );
});

export const Sidebar = memo(function Sidebar() {
  useRenderProbe("Sidebar");
  const { userId, username, conversationId, logout } = useChat();
  const { setSidebarOpen } = useUi();
  const openOverlay = useOpenOverlay();
  const list = useQuery(conversationsQuery(userId));
  const prefetcher = usePrefetcher(userId);

  return (
    <nav className="sidebar" aria-label="Chats">
      <div className="sidebar-head">
        <Link to={paths.newChat()} className="brand">
          ChatUI
        </Link>
        <IconButton
          label="Close sidebar"
          tooltipSide="right"
          onClick={() => {
            setSidebarOpen(false);
          }}
        >
          <PanelLeftClose size={20} aria-hidden />
        </IconButton>
      </div>
      <div className="sidebar-scroll">
        <Link to={paths.newChat()} className="side-row new-chat" data-testid="new-chat">
          <SquarePen size={18} aria-hidden />
          <span>New chat</span>
        </Link>
        <h2 className="side-label">Recents</h2>
        {list.isPending ? (
          <p className="side-note">Loading chats…</p>
        ) : list.isError ? (
          <p className="side-note">Chats could not be loaded.</p>
        ) : list.data.length === 0 ? (
          <p className="side-note">No chats yet.</p>
        ) : (
          <ul className="chat-list" data-testid="conversation-list">
            {list.data.map((item) => (
              <ConversationRow
                key={item.id}
                item={item}
                active={item.id === conversationId}
                prefetcher={prefetcher}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="sidebar-foot">
        <Menu
          label="Account"
          side="top"
          align="start"
          contentClassName="profile-menu"
          trigger={
            <button type="button" className="profile-row" aria-label={`Account: ${username}`}>
              <span className="avatar" aria-hidden>
                {initials(username)}
              </span>
              <span className="profile-name" data-testid="signed-in-user">
                {username}
              </span>
            </button>
          }
        >
          <MenuItem
            icon={<Settings size={16} aria-hidden />}
            onSelect={() => {
              openOverlay(paths.settings());
            }}
          >
            Settings
          </MenuItem>
          <MenuItem
            icon={<Keyboard size={16} aria-hidden />}
            onSelect={() => {
              openOverlay(paths.settings("shortcuts"));
            }}
          >
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<LogOut size={16} aria-hidden />}
            onSelect={() => {
              void logout();
            }}
          >
            Log out
          </MenuItem>
        </Menu>
      </div>
    </nav>
  );
});
