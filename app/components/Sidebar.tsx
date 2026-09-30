import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, MoreHorizontal, PanelLeft, SquarePen } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { Link, useLocation, useMatches, useParams } from "react-router";
import { paths, type OverlayState } from "../lib/paths";
import { endIntent, prefetchIntent } from "../lib/prefetch";
import { queries } from "../lib/query";
import { count } from "../lib/render-counters";
import { useSignOut } from "../lib/use-sign-out";
import { AccountLabel } from "./AccountLabel";
import { preloadDialogs, useConversationActions } from "./ConversationActions";

// Menus load on demand (Phase 9); a same-looking placeholder stands in.
const loadMenus = () => import("./Menus");
const RowMenu = lazy(() => loadMenus().then((m) => ({ default: m.RowMenu })));
const AccountMenu = lazy(() => loadMenus().then((m) => ({ default: m.AccountMenu })));

export interface SidebarUser {
  id: string;
  username: string;
  role: string;
}

interface SidebarProps {
  user: SidebarUser;
  hidden: boolean;
  /** Rendered inside the narrow-screen drawer (Phase 11). */
  drawer: boolean;
  /** The drawer instance needs its own id. */
  navId?: string;
  /** Accessible name of the hide/close button. */
  hideLabel?: string;
  onHide: () => void;
  /** Called after choosing a destination (closes the drawer). */
  onNavigate: () => void;
}

function SidebarImpl({
  user,
  hidden,
  drawer,
  navId = "sidebar",
  hideLabel = "Hide sidebar",
  onHide,
  onNavigate,
}: SidebarProps) {
  count("sidebarRenders");
  useEffect(() => {
    count("sidebarMounts");
  }, []);
  const { conversationId } = useParams();
  const client = useQueryClient();
  // Secondary data: loaded after hydration, never gating the composer.
  const list = useQuery(queries.conversations(user.id));
  const conversations = list.data ?? [];
  const actions = useConversationActions(user.id);
  // The row menu trigger last used: dialogs return focus there (INV-47).
  const menuTrigger = useRef<HTMLElement | null>(null);
  // A placeholder trigger clicked before the menu chunk arrived opens it then.
  const [openRequest, setOpenRequest] = useState<string | null>(null);

  return (
    <nav
      id={navId}
      className={`sidebar${drawer ? " in-drawer" : ""}`}
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
          aria-label={hideLabel}
          aria-expanded={drawer ? undefined : true}
          aria-controls={drawer ? undefined : navId}
          title={hideLabel}
          onClick={onHide}
        >
          <PanelLeft size={18} aria-hidden />
        </button>
      </div>
      <Link to={paths.newChat()} className="nav-row" onClick={onNavigate}>
        <SquarePen size={18} aria-hidden /> New chat
      </Link>
      <p className="section-label">All chats</p>
      {list.isPending ? (
        <p className="sidebar-note" aria-busy="true" data-testid="conversations-loading">
          Loading conversations…
        </p>
      ) : list.isError && !list.data ? (
        <div className="sidebar-note" role="alert" data-testid="conversations-error">
          <p>Conversations couldn’t be loaded.</p>
          <button type="button" className="link-button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </div>
      ) : conversations.length === 0 ? (
        <p className="sidebar-note" data-testid="conversations-empty">
          No conversations yet. Your chats will appear here.
        </p>
      ) : null}
      <ul className="chat-list" data-testid="conversation-list">
        {conversations.map((item) => (
          <li key={item.id} className={item.id === conversationId ? "current" : undefined}>
            <Link
              to={paths.chat(item.id)}
              aria-current={item.id === conversationId ? "page" : undefined}
              onClick={onNavigate}
              // Route chunk on intent; the data through the shared query cache.
              prefetch="intent"
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") prefetchIntent(client, user.id, item.id);
              }}
              onPointerLeave={endIntent}
              onFocus={() => {
                prefetchIntent(client, user.id, item.id, 0);
              }}
              onBlur={endIntent}
            >
              {item.malformed ? <AlertTriangle size={14} aria-label="Unreadable" /> : null}
              <span className="row-title">
                {item.malformed ? `${item.title} (unreadable)` : item.title}
              </span>
            </Link>
            <Suspense
              fallback={
                <button
                  type="button"
                  className="icon-btn row-menu"
                  aria-label={`Actions for ${item.title}`}
                  title="More"
                  onClick={() => {
                    setOpenRequest(item.id);
                  }}
                >
                  <MoreHorizontal size={16} aria-hidden />
                </button>
              }
            >
              <RowMenu
                title={item.title}
                malformed={item.malformed}
                defaultOpen={openRequest === item.id}
                onTriggerFocus={(element) => {
                  menuTrigger.current = element;
                }}
                onOpen={() => {
                  // Intent: fetch the dialog chunk before it is needed.
                  void preloadDialogs();
                }}
                onRename={() => {
                  actions.rename(item, menuTrigger.current);
                }}
                onDelete={() => {
                  actions.remove(item, menuTrigger.current);
                }}
              />
            </Suspense>
          </li>
        ))}
      </ul>
      <Account user={user} onNavigate={onNavigate} />
      {actions.dialogs}
    </nav>
  );
}

/** Avatar and name at the bottom, opening Settings, Administration and Sign out. */
function Account({ user, onNavigate }: { user: SidebarUser; onNavigate: () => void }) {
  const location = useLocation();
  const matches = useMatches();
  const signOut = useSignOut();
  const [openRequest, setOpenRequest] = useState(false);
  const inOverlay = matches.some((m) => /routes\/(settings|admin)$/.test(m.id));
  const background = inOverlay
    ? (location.state as OverlayState | null)?.background
    : location.pathname;
  return (
    <Suspense
      fallback={
        <button
          type="button"
          className="account-trigger"
          onClick={() => {
            setOpenRequest(true);
          }}
        >
          <AccountLabel username={user.username} />
        </button>
      }
    >
      <AccountMenu
        username={user.username}
        isAdmin={user.role === "admin"}
        defaultOpen={openRequest}
        overlayState={background ? { background } : {}}
        onNavigate={onNavigate}
        onSignOut={() => void signOut()}
      />
    </Suspense>
  );
}

export const Sidebar = memo(SidebarImpl);
