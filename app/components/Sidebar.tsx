import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  Ellipsis,
  FolderClosed,
  FolderInput,
  FolderMinus,
  FolderPlus,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { ConversationSummary } from "@shared/conversations";
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Link, useLocation, useParams } from "react-router";
import { menuRequest, type MenuRequest } from "../lib/menu-request";
import { paths } from "../lib/paths";
import { endIntent, prefetchIntent } from "../lib/prefetch";
import { queries } from "../lib/query";
import { count } from "../lib/render-counters";
import { useCollapsedSections } from "../lib/sidebar-sections";
import { useSignOut } from "../lib/use-sign-out";
import { AccountLabel, type ProfileUser } from "./AccountLabel";
import { preloadDialogs, useChatActions } from "./ChatActions";
import type { MenuItems } from "./Menus";

const loadMenus = () => import("./Menus");
const RowMenu = lazy(() => loadMenus().then((m) => ({ default: m.RowMenu })));
const AccountMenu = lazy(() => loadMenus().then((m) => ({ default: m.AccountMenu })));
const SearchDialog = lazy(() =>
  import("./SearchDialog").then((m) => ({ default: m.SearchDialog })),
);

export interface SidebarUser extends ProfileUser {
  role: string;
}

interface SidebarProps {
  user: SidebarUser;
  /** Wide screens: folded to the icon rail. */
  collapsed: boolean;
  /** Rendered inside the phone drawer. */
  drawer: boolean;
  /** The drawer copy needs its own ids. */
  navId?: string;
  /** Folds the rail, or closes the drawer. */
  onToggle: () => void;
  /** After choosing a destination (closes the drawer). */
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
  const location = useLocation();
  const [searching, setSearching] = useState(false);
  const searchTrigger = useRef<HTMLElement | null>(null);
  const rail = collapsed && !drawer;
  const toggleLabel = rail ? "Open sidebar" : "Close sidebar";
  // Settings, Files and Projects keep the page you came from to go back to.
  const background = { background: location.pathname };

  // Ctrl/⌘+K opens search (the in-page sidebar owns it, not the drawer copy).
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
          className="icon-btn toggle-btn"
          aria-label={drawer ? "Close sidebar" : toggleLabel}
          aria-controls={drawer ? undefined : `${navId}-lists`}
          title={drawer ? "Close sidebar" : toggleLabel}
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
        <button
          type="button"
          className="nav-row"
          aria-label="Search chats"
          aria-haspopup="dialog"
          title="Search chats (Ctrl+K)"
          onClick={openSearch}
        >
          <Search size={20} aria-hidden />
          <span className="label">Search</span>
        </button>
        <Link
          to={paths.files()}
          state={background}
          className="nav-row"
          aria-label="Files"
          aria-current={location.pathname === "/files" ? "page" : undefined}
          onClick={onNavigate}
        >
          <FolderClosed size={20} aria-hidden />
          <span className="label">Files</span>
        </Link>
      </div>

      <ChatLists user={user} listId={`${navId}-lists`} hidden={rail} onNavigate={onNavigate} />

      <div className="sidebar-foot">
        <Account user={user} settingsState={background} onNavigate={onNavigate} />
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

/** Pinned and Recents: the sidebar's one scrolling region. */
function ChatLists({
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
  // Secondary data: loaded after hydration, never in the way of the composer.
  const list = useQuery(queries.conversations(user.id));
  const chats = list.data ?? [];
  const actions = useChatActions(user.id);
  // The row "…" used last: dialogs give focus back to it.
  const menuTrigger = useRef<HTMLElement | null>(null);
  // A placeholder clicked before the menu chunk arrived opens the menu then.
  const [openRequest, setOpenRequest] = useState<{ id: string; mode: MenuRequest } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useCollapsedSections();
  // Projects: their own sidebar section (as ChatGPT), and "Move to project".
  const projects = useQuery(queries.projects(user.id));
  const { projectId: openProjectId } = useParams();
  const location = useLocation();
  const visible = chats.filter((c) => c.archived !== true);
  const pinned = visible
    .filter((c) => typeof c.pinnedRank === "number")
    .sort((a, b) => (a.pinnedRank ?? 0) - (b.pinnedRank ?? 0));
  const recents = visible.filter((c) => typeof c.pinnedRank !== "number");

  const rowItems = (chat: ConversationSummary): MenuItems => {
    const isPinned = typeof chat.pinnedRank === "number";
    const others = (projects.data ?? []).filter((p) => p.id !== chat.projectId);
    return [
      ...(chat.malformed
        ? []
        : [
            {
              label: "Rename",
              icon: <Pencil size={20} aria-hidden />,
              onSelect: () => {
                actions.rename(chat, menuTrigger.current);
              },
            },
          ]),
      {
        label: isPinned ? "Unpin" : "Pin",
        icon: isPinned ? <PinOff size={20} aria-hidden /> : <Pin size={20} aria-hidden />,
        onSelect: () => {
          actions.togglePin({ ...chat, pinned: isPinned });
        },
      },
      "separator",
      {
        label: "Archive",
        icon: <Archive size={20} aria-hidden />,
        onSelect: () => {
          actions.setArchived(chat, true);
        },
      },
      {
        label: "Delete",
        icon: <Trash2 size={20} aria-hidden />,
        onSelect: () => {
          actions.remove(chat, menuTrigger.current);
        },
      },
      "separator",
      {
        label: "Move to project",
        icon: <FolderInput size={20} aria-hidden />,
        submenu: [
          ...others.map((project) => ({
            label: project.name,
            icon: <FolderClosed size={20} aria-hidden />,
            onSelect: () => {
              actions.moveTo(chat, project.id);
            },
          })),
          ...(chat.projectId
            ? [
                {
                  label: "Remove from project",
                  icon: <FolderMinus size={20} aria-hidden />,
                  onSelect: () => {
                    actions.moveTo(chat, null);
                  },
                },
              ]
            : []),
          ...(others.length > 0 || chat.projectId ? (["separator"] as const) : []),
          {
            label: "New project",
            icon: <FolderPlus size={20} aria-hidden />,
            onSelect: () => {
              actions.moveToNewProject(chat, menuTrigger.current);
            },
          },
        ],
      },
    ];
  };

  const row = (chat: ConversationSummary) => {
    const current = chat.id === conversationId;
    return (
      <li
        key={chat.id}
        className={`chat-row${current ? " current" : ""}${menuOpenId === chat.id ? " menu-open" : ""}`}
      >
        <Link
          to={paths.chat(chat.id)}
          aria-current={current ? "page" : undefined}
          onClick={onNavigate}
          prefetch="intent"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") prefetchIntent(client, user.id, chat.id);
          }}
          onPointerLeave={endIntent}
          onFocus={() => {
            prefetchIntent(client, user.id, chat.id, 0);
          }}
          onBlur={endIntent}
        >
          {chat.malformed ? <AlertTriangle size={14} aria-label="Unreadable" /> : null}
          <span className="row-title">
            {chat.malformed ? `${chat.title} (unreadable)` : chat.title}
          </span>
        </Link>
        <Suspense
          fallback={
            <button
              type="button"
              className="icon-btn row-menu-btn"
              aria-label={`Actions for ${chat.title}`}
              title="More"
              onClick={(event) => {
                void preloadDialogs();
                setOpenRequest({ id: chat.id, mode: menuRequest(event) });
              }}
            >
              <Ellipsis size={18} aria-hidden />
            </button>
          }
        >
          <RowMenu
            title={chat.title}
            items={rowItems(chat)}
            defaultOpen={openRequest?.id === chat.id ? openRequest.mode : false}
            onTriggerFocus={(element) => {
              menuTrigger.current = element;
            }}
            onOpenChange={(open) => {
              if (open) {
                void preloadDialogs();
              }
              setMenuOpenId(open ? chat.id : null);
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
            className="chat-list"
            aria-labelledby={`${listId}-pinned`}
            data-testid="pinned-list"
            hidden={collapsed.pinned}
          >
            {pinned.map(row)}
          </ul>
        </>
      ) : null}
      <SectionToggle
        id={`${listId}-projects`}
        controls={`${listId}-projects-list`}
        label="Projects"
        open={!collapsed.projects}
        onToggle={(open) => {
          setCollapsed("projects", !open);
        }}
      />
      <ul
        id={`${listId}-projects-list`}
        className="chat-list"
        aria-labelledby={`${listId}-projects`}
        data-testid="project-list"
        hidden={collapsed.projects}
      >
        <li className="chat-row">
          <Link
            to={paths.projects()}
            state={{ background: location.pathname }}
            onClick={onNavigate}
          >
            <FolderPlus size={18} aria-hidden />
            <span className="row-title">New project</span>
          </Link>
        </li>
        {(projects.data ?? []).map((project) => {
          const current = openProjectId === project.id;
          const currentChat = chats.find((c) => c.id === conversationId);
          // The open project (or the open chat's project) shows its chats beneath it.
          const expanded = current || currentChat?.projectId === project.id;
          const inside = expanded ? visible.filter((c) => c.projectId === project.id) : [];
          return (
            <Fragment key={project.id}>
              <li className={`chat-row${current ? " current" : ""}`}>
                <Link
                  to={paths.projects(project.id)}
                  aria-current={current ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <FolderClosed size={18} aria-hidden />
                  <span className="row-title">{project.name}</span>
                </Link>
              </li>
              {inside.length > 0 ? (
                <li className="project-chats">
                  <ul className="chat-list">{inside.map(row)}</ul>
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ul>
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
          // Rows the size of real ones: nothing shifts when the list arrives.
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
        ) : visible.length === 0 ? (
          <p className="sidebar-empty" data-testid="conversations-empty">
            No conversations yet.
          </p>
        ) : null}
        <ul className="chat-list" data-testid="conversation-list">
          {recents.map(row)}
        </ul>
      </div>
      {actions.dialogs}
    </div>
  );
}

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

/** The avatar and name at the bottom, opening the account menu. */
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
          className="nav-row account-row"
          aria-label={`Account (${user.username})`}
          onClick={(event) => {
            setOpenRequest(menuRequest(event));
          }}
        >
          <AccountLabel user={user} />
        </button>
      }
    >
      <AccountMenu
        user={user}
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
