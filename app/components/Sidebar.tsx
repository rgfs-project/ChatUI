import * as Menu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Settings,
  Shield,
  SquarePen,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { Link, useLocation, useMatches, useNavigate, useParams } from "react-router";
import { paths, type OverlayState } from "../lib/paths";
import { fetchers, queryKeys } from "../lib/query";
import { count } from "../lib/render-counters";
import { useSignOut } from "../lib/use-sign-out";
import { useConversationActions } from "./ConversationActions";

export interface SidebarUser {
  id: string;
  username: string;
  role: string;
}

interface SidebarProps {
  user: SidebarUser;
  hidden: boolean;
  /** Overlay drawer on narrow screens. */
  drawer: boolean;
  onHide: () => void;
  /** Called after choosing a destination (closes the drawer). */
  onNavigate: () => void;
}

function SidebarImpl({ user, hidden, drawer, onHide, onNavigate }: SidebarProps) {
  count("sidebarRenders");
  useEffect(() => {
    count("sidebarMounts");
  }, []);
  const { conversationId } = useParams();
  const { data: conversations = [] } = useQuery({
    queryKey: queryKeys.conversations(user.id),
    queryFn: fetchers.conversations,
  });
  const actions = useConversationActions(user.id);
  // The row menu trigger last used: dialogs return focus there (INV-47).
  const menuTrigger = useRef<HTMLElement | null>(null);

  return (
    <nav
      id="sidebar"
      className={`sidebar${drawer ? " drawer" : ""}`}
      aria-label="Conversations"
      hidden={hidden}
    >
      <div className="sidebar-top">
        <Link to={paths.newChat()} className="brand" onClick={onNavigate}>
          ChatUI
        </Link>
        <button
          type="button"
          className="icon-btn"
          aria-label="Hide sidebar"
          aria-expanded
          aria-controls="sidebar"
          title="Hide sidebar"
          onClick={onHide}
        >
          <PanelLeft size={18} aria-hidden />
        </button>
      </div>
      <Link to={paths.newChat()} className="nav-row" onClick={onNavigate}>
        <SquarePen size={18} aria-hidden /> New chat
      </Link>
      <p className="section-label">All chats</p>
      <ul className="chat-list" data-testid="conversation-list">
        {conversations.map((item) => (
          <li key={item.id} className={item.id === conversationId ? "current" : undefined}>
            <Link
              to={paths.chat(item.id)}
              aria-current={item.id === conversationId ? "page" : undefined}
              onClick={onNavigate}
            >
              {item.malformed ? <AlertTriangle size={14} aria-label="Unreadable" /> : null}
              <span className="row-title">
                {item.malformed ? `${item.title} (unreadable)` : item.title}
              </span>
            </Link>
            <Menu.Root modal={false}>
              <Menu.Trigger asChild>
                <button
                  type="button"
                  className="icon-btn row-menu"
                  aria-label={`Actions for ${item.title}`}
                  title="More"
                  onFocus={(event) => {
                    menuTrigger.current = event.currentTarget;
                  }}
                >
                  <MoreHorizontal size={16} aria-hidden />
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu-popover" align="start" sideOffset={4}>
                  {item.malformed ? null : (
                    <Menu.Item
                      className="menu-item"
                      onSelect={() => {
                        actions.rename(item, menuTrigger.current);
                      }}
                    >
                      <Pencil size={16} aria-hidden /> Rename
                    </Menu.Item>
                  )}
                  <Menu.Item
                    className="menu-item danger"
                    onSelect={() => {
                      actions.remove(item, menuTrigger.current);
                    }}
                  >
                    <Trash2 size={16} aria-hidden /> Delete
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </li>
        ))}
      </ul>
      <AccountMenu user={user} onNavigate={onNavigate} />
      {actions.dialogs}
    </nav>
  );
}

/** Avatar and name at the bottom, opening Settings and Sign out. */
function AccountMenu({ user, onNavigate }: { user: SidebarUser; onNavigate: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const signOut = useSignOut();
  const inOverlay = matches.some((m) => /routes\/(settings|admin)$/.test(m.id));
  const background = inOverlay
    ? (location.state as OverlayState | null)?.background
    : location.pathname;
  const openOverlay = (to: string) => {
    onNavigate();
    void navigate(to, { state: { background } satisfies OverlayState });
  };
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className="account-trigger">
        <span className="avatar" aria-hidden>
          {(user.username.at(0) ?? "?").toUpperCase()}
        </span>
        <span data-testid="signed-in-user">{user.username}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-popover account-popover" side="top" sideOffset={6}>
          <Menu.Item
            className="menu-item"
            onSelect={() => {
              openOverlay(paths.settings());
            }}
          >
            <Settings size={16} aria-hidden /> Settings
          </Menu.Item>
          {user.role === "admin" ? (
            <Menu.Item
              className="menu-item"
              onSelect={() => {
                openOverlay(paths.admin());
              }}
            >
              <Shield size={16} aria-hidden /> Administration
            </Menu.Item>
          ) : null}
          <Menu.Separator className="menu-separator" />
          <Menu.Item className="menu-item" onSelect={() => void signOut()}>
            <LogOut size={16} aria-hidden /> Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export const Sidebar = memo(SidebarImpl);
