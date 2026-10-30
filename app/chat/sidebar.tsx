import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  CircleUserRound,
  LibraryBig,
  Keyboard,
  LogOut,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  PanelLeftClose,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
  Shield,
} from "lucide-react";
import { memo, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { paths, type OverlayState } from "../lib/paths";
import { usePrefetcher } from "../lib/prefetch";
import { conversationsQuery } from "../lib/query/queries";
import { useRenderProbe } from "../lib/render-probe";
import { useUi } from "../lib/ui-context";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { useChat } from "./chat-context";
import { useConversationOps } from "./conversation-ops";
import { openSearch } from "./search-events";
import { preferencesQuery } from "../lib/query/queries";

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
      <Menu
        label={`Options for ${item.title}`}
        align="start"
        trigger={
          <button type="button" className="row-menu" aria-label={`Options for ${item.title}`}>
            <MoreHorizontal size={16} aria-hidden />
          </button>
        }
      >
        <MenuItem
          icon={pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
          onSelect={() => {
            void ops.togglePin(item.id);
          }}
        >
          {pinned ? "Unpin" : "Pin"}
        </MenuItem>
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

const NO_PINS: string[] = [];

/** A folding sidebar section: its heading is a button (reference UI). */
function Section({
  id,
  label,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <h2 className="side-heading">
        <button
          type="button"
          className={`side-label${collapsed ? " is-collapsed" : ""}`}
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={() => {
            onToggle(!collapsed);
          }}
        >
          <span>{label}</span>
          <ChevronDown size={14} className="side-label-chevron" aria-hidden />
        </button>
      </h2>
      {collapsed ? null : children}
    </>
  );
}

export const Sidebar = memo(function Sidebar() {
  useRenderProbe("Sidebar");
  const { userId, username, role, conversationId, logout } = useChat();
  const {
    setSidebarOpen,
    recentsCollapsed,
    setRecentsCollapsed,
    pinnedCollapsed,
    setPinnedCollapsed,
  } = useUi();
  const prefs = useQuery(preferencesQuery(userId));
  const pins = prefs.data?.pins ?? NO_PINS;
  const openOverlay = useOpenOverlay();
  const list = useQuery(conversationsQuery(userId));
  const prefetcher = usePrefetcher(userId);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Pinned chats in pin order; Recents shows the rest.
  const pinnedItems = useMemo(() => {
    const byId = new Map((list.data ?? []).map((c) => [c.id, c]));
    return pins.flatMap((id) => byId.get(id) ?? []);
  }, [list.data, pins]);
  const recentItems = useMemo(
    () => (list.data ?? []).filter((c) => !pins.includes(c.id)),
    [list.data, pins],
  );

  return (
    <nav className="sidebar" aria-label="Chats">
      <div className="sidebar-head">
        <Link to={paths.newChat()} className="brand">
          ChatUI
        </Link>
        <div className="sidebar-head-actions">
          <IconButton label="Search chats (Ctrl+K)" tooltipSide="bottom" onClick={openSearch}>
            <Search size={20} aria-hidden />
          </IconButton>
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
      </div>
      <div className="sidebar-scroll">
        <Link to={paths.newChat()} className="side-row new-chat" data-testid="new-chat">
          <SquarePen size={18} aria-hidden />
          <span>New chat</span>
        </Link>
        <Link
          to={paths.library()}
          className={`side-row${pathname === paths.library() ? " is-active" : ""}`}
          aria-current={pathname === paths.library() ? "page" : undefined}
          data-testid="library-link"
        >
          <LibraryBig size={18} aria-hidden />
          <span>Library</span>
        </Link>
        {pinnedItems.length > 0 ? (
          <Section
            id="pinned"
            label="Pinned"
            collapsed={pinnedCollapsed}
            onToggle={setPinnedCollapsed}
          >
            <ul className="chat-list" id="pinned" data-testid="pinned-list">
              {pinnedItems.map((item) => (
                <ConversationRow
                  key={item.id}
                  item={item}
                  active={item.id === conversationId}
                  pinned
                  prefetcher={prefetcher}
                />
              ))}
            </ul>
          </Section>
        ) : null}
        <Section
          id="recents"
          label="Recents"
          collapsed={recentsCollapsed}
          onToggle={setRecentsCollapsed}
        >
          {list.isPending ? (
            <p className="side-note">Loading chats…</p>
          ) : list.isError ? (
            <p className="side-note">Chats could not be loaded.</p>
          ) : recentItems.length === 0 ? (
            <p className="side-note">No chats yet.</p>
          ) : (
            <ul className="chat-list" id="recents" data-testid="conversation-list">
              {recentItems.map((item) => (
                <ConversationRow
                  key={item.id}
                  item={item}
                  active={item.id === conversationId}
                  pinned={false}
                  prefetcher={prefetcher}
                />
              ))}
            </ul>
          )}
        </Section>
      </div>
      <div className="sidebar-foot">
        <Menu
          label="Account"
          side="top"
          align="start"
          contentClassName="profile-menu"
          trigger={
            <button type="button" className="profile-row" aria-label={`Account: ${username}`}>
              <Avatar userId={userId} username={username} />
              <span className="profile-name" data-testid="signed-in-user">
                {username}
              </span>
            </button>
          }
        >
          <MenuItem
            icon={<CircleUserRound size={16} aria-hidden />}
            onSelect={() => {
              void navigate(paths.profile());
            }}
          >
            Profile
          </MenuItem>
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
          {role === "admin" ? (
            <MenuItem
              icon={<Shield size={16} aria-hidden />}
              onSelect={() => {
                openOverlay(paths.admin());
              }}
            >
              Administration
            </MenuItem>
          ) : null}
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
