import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Ellipsis,
  FolderClosed,
  PanelLeft,
  Search,
  SquarePen,
} from "lucide-react";
import type { ConversationSummary } from "@shared/conversations";
import { lazy, memo, Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation, useParams } from "react-router";
import { menuRequest, type MenuRequest } from "../lib/menu-request";
import { paths } from "../lib/paths";
import { endIntent, prefetchIntent } from "../lib/prefetch";
import { queries } from "../lib/query";
import { count } from "../lib/render-counters";
import { useCollapsedSections } from "../lib/sidebar-sections";
import { useSignOut } from "../lib/use-sign-out";
import { AccountLabel } from "./AccountLabel";
import { preloadDialogs, useConversationActions } from "./ConversationActions";

// The row menu loads on demand; a same-looking placeholder stands in.
const loadMenus = () => import("./Menus");
const RowMenu = lazy(() => loadMenus().then((m) => ({ default: m.RowMenu })));
const AccountMenu = lazy(() => loadMenus().then((m) => ({ default: m.AccountMenu })));
// Search loads when opened.
const SearchDialog = lazy(() =>
  import("./SearchDialog").then((m) => ({ default: m.SearchDialog })),
);

export interface SidebarUser {
  id: string;
  username: string;
  role: string;
}

interface SidebarProps {
  user: SidebarUser;
  /** Wide screens: folded to an icon rail (the toggle reopens it). */
  collapsed: boolean;
  /** Rendered inside the narrow-screen drawer. */
  drawer: boolean;
  /** The drawer instance needs its own id. */
  navId?: string;
  /** Folds the rail, or closes the drawer. */
  onToggle: () => void;
  /** Called after choosing a destination (closes the drawer). */
  onNavigate: () => void;
}

function SidebarImpl({
  user,
  collapsed,
  drawer,
  navId = "sidebar",
  onToggle,
  onNavigate,
}: SidebarProps) {
  count("sidebarRenders");
  useEffect(() => {
    count("sidebarMounts");
  }, []);
  const [searching, setSearching] = useState(false);
  const searchTrigger = useRef<HTMLElement | null>(null);
  const location = useLocation();
  // Settings keeps the current conversation to come back to.
  const settingsState = { background: location.pathname };
  const rail = collapsed && !drawer;
  const toggleLabel = drawer ? "Close sidebar" : rail ? "Open sidebar" : "Close sidebar";

  // Ctrl/⌘+K opens search (the in-page sidebar owns the shortcut, not the drawer copy).
  useEffect(() => {
    if (drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [drawer]);

  const openSearch = (event: MouseEvent<HTMLElement>) => {
    searchTrigger.current = event.currentTarget;
    setSearching(true);
  };

  return (
    <nav
      id={navId}
      className={`sidebar${rail ? " rail" : ""}`}
      aria-label="Conversations"
      data-collapsed={rail ? "true" : undefined}
    >
      <div className="sidebar-top">
        <Link
          to={paths.newChat()}
          className="brand label"
          onClick={onNavigate}
          tabIndex={rail ? -1 : 0}
          aria-hidden={rail ? true : undefined}
        >
          ChatUI
        </Link>
        <button
          type="button"
          className="icon-btn search-btn label"
          aria-label="Search chats"
          aria-haspopup="dialog"
          title="Search chats (Ctrl+K)"
          tabIndex={rail ? -1 : 0}
          aria-hidden={rail ? true : undefined}
          onClick={openSearch}
        >
          <Search size={20} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-btn toggle-btn"
          aria-label={toggleLabel}
          aria-expanded={drawer ? undefined : !rail}
          aria-controls={drawer ? undefined : `${navId}-lists`}
          title={toggleLabel}
          onClick={onToggle}
        >
          <PanelLeft size={20} aria-hidden />
        </button>
      </div>
      <div className="sidebar-nav">
        <Link to={paths.newChat()} className="nav-row" aria-label="New chat" onClick={onNavigate}>
          <SquarePen size={20} aria-hidden />
          <span className="label">New chat</span>
        </Link>
        {drawer ? null : (
          <button
            type="button"
            className="nav-row rail-only"
            aria-label="Search chats"
            aria-haspopup="dialog"
            tabIndex={rail ? 0 : -1}
            aria-hidden={rail ? undefined : true}
            onClick={openSearch}
          >
            <Search size={20} aria-hidden />
          </button>
        )}
        <Link
          to={paths.settings("files")}
          state={settingsState}
          className="nav-row"
          aria-label="Files"
          onClick={onNavigate}
        >
          <FolderClosed size={20} aria-hidden />
          <span className="label">Files</span>
        </Link>
      </div>
      <ConversationLists
        user={user}
        listId={`${navId}-lists`}
        hidden={rail}
        onNavigate={onNavigate}
      />
      <div className="sidebar-foot">
        <Account user={user} settingsState={settingsState} onNavigate={onNavigate} />
      </div>
      {searching ? (
        <Suspense fallback={null}>
          <SearchDialog
            userId={user.id}
            onClose={(navigated) => {
              setSearching(false);
              if (!navigated) requestAnimationFrame(() => searchTrigger.current?.focus());
            }}
            onNavigate={onNavigate}
          />
        </Suspense>
      ) : null}
    </nav>
  );
}

/** Pinned and Recents: the one scrolling region of the sidebar. */
function ConversationLists({
  user,
  listId,
  hidden,
  onNavigate,
}: {
  user: SidebarUser;
  listId: string;
  hidden: boolean;
  onNavigate: () => void;
}) {
  const { conversationId } = useParams();
  const client = useQueryClient();
  // Secondary data: loaded after hydration, never gating the composer.
  const list = useQuery(queries.conversations(user.id));
  const conversations = list.data ?? [];
  const actions = useConversationActions(user.id);
  // The row menu trigger last used: dialogs return focus there.
  const menuTrigger = useRef<HTMLElement | null>(null);
  // A placeholder trigger clicked before the menu chunk arrived opens it then.
  const [openRequest, setOpenRequest] = useState<{ id: string; mode: MenuRequest } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useCollapsedSections();
  const pinned = conversations
    .filter((c) => typeof c.pinnedRank === "number")
    .sort((a, b) => (a.pinnedRank ?? 0) - (b.pinnedRank ?? 0));
  const others = conversations.filter((c) => typeof c.pinnedRank !== "number");

  const row = (item: ConversationSummary) => {
    const current = item.id === conversationId;
    const isPinned = typeof item.pinnedRank === "number";
    return (
      <li
        key={item.id}
        className={`conversation-row${current ? " current" : ""}${menuOpenId === item.id ? " menu-open" : ""}`}
      >
        <Link
          to={paths.chat(item.id)}
          aria-current={current ? "page" : undefined}
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
              className="icon-btn row-menu-btn"
              aria-label={`Actions for ${item.title}`}
              title="More"
              onClick={(event) => {
                setOpenRequest({ id: item.id, mode: menuRequest(event) });
              }}
            >
              <Ellipsis size={18} aria-hidden />
            </button>
          }
        >
          <RowMenu
            title={item.title}
            malformed={item.malformed}
            pinned={isPinned}
            onTogglePin={() => {
              actions.togglePin({ ...item, pinned: isPinned });
            }}
            defaultOpen={openRequest?.id === item.id ? openRequest.mode : false}
            onTriggerFocus={(element) => {
              menuTrigger.current = element;
            }}
            onOpen={() => {
              // Intent: fetch the dialog chunk before it is needed.
              void preloadDialogs();
            }}
            onOpenChange={(open) => {
              setMenuOpenId(open ? item.id : null);
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
    );
  };

  return (
    <div
      id={listId}
      className="sidebar-lists"
      data-testid="sidebar-scroll"
      aria-hidden={hidden ? true : undefined}
      inert={hidden}
    >
      {pinned.length > 0 ? (
        <>
          <SectionToggle
            id={`${listId}-pinned`}
            controls={`${listId}-pinned-list`}
            label="Pinned"
            open={!collapsed.pinned}
            onToggle={(open) => {
              setCollapsed("pinned", !open);
            }}
          />
          <ul
            id={`${listId}-pinned-list`}
            className="conversation-list"
            aria-labelledby={`${listId}-pinned`}
            data-testid="pinned-list"
            hidden={collapsed.pinned}
          >
            {pinned.map(row)}
          </ul>
        </>
      ) : null}
      <SectionToggle
        id={`${listId}-recents`}
        controls={`${listId}-recents-list`}
        label="Recents"
        open={!collapsed.recents}
        onToggle={(open) => {
          setCollapsed("recents", !open);
        }}
      />
      <div id={`${listId}-recents-list`} hidden={collapsed.recents}>
        {list.isPending ? (
          // Rows the size of real ones, so the list doesn't shift when it arrives.
          <div aria-busy="true" data-testid="conversations-loading">
            <span className="visually-hidden">Loading conversations…</span>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton-row" aria-hidden />
            ))}
          </div>
        ) : list.isError && !list.data ? (
          <div className="sidebar-empty" role="alert" data-testid="conversations-error">
            <p>Conversations couldn’t be loaded.</p>
            <button type="button" className="link-button" onClick={() => void list.refetch()}>
              Try again
            </button>
          </div>
        ) : conversations.length === 0 ? (
          <p className="sidebar-empty" data-testid="conversations-empty">
            No conversations yet.
          </p>
        ) : null}
        <ul className="conversation-list" data-testid="conversation-list">
          {others.map(row)}
        </ul>
      </div>
      {actions.dialogs}
    </div>
  );
}

/** A section header that shows or hides its list ("Pinned ›", "Recents ›"). */
function SectionToggle(props: {
  id: string;
  controls: string;
  label: string;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  return (
    <button
      type="button"
      id={props.id}
      className="section-toggle"
      aria-expanded={props.open}
      aria-controls={props.controls}
      onClick={() => {
        props.onToggle(!props.open);
      }}
    >
      {props.label}
      <ChevronRight size={14} aria-hidden />
    </button>
  );
}

/** Avatar and name at the bottom, opening Settings, the theme, Administration and Sign out. */
function Account({
  user,
  settingsState,
  onNavigate,
}: {
  user: SidebarUser;
  settingsState: { background: string };
  onNavigate: () => void;
}) {
  const signOut = useSignOut();
  const [openRequest, setOpenRequest] = useState<MenuRequest>(false);
  return (
    <Suspense
      fallback={
        <button
          type="button"
          className="nav-row account-btn"
          aria-label={`Account (${user.username})`}
          onClick={(event) => {
            setOpenRequest(menuRequest(event));
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
        settingsState={settingsState}
        onNavigate={onNavigate}
        onSignOut={() => void signOut()}
      />
    </Suspense>
  );
}

export const Sidebar = memo(SidebarImpl);
