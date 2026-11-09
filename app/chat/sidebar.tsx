import { useQuery } from "@tanstack/react-query";
import type { PreferencesDto } from "@shared/preferences";
import { openProjectDialog } from "./project-dialogs";
import { FolderPlus, LibraryBig, Search, PanelLeft, SquarePen } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { paths } from "../lib/paths";
import { usePrefetcher } from "../lib/prefetch";
import { conversationsQuery, preferencesQuery } from "../lib/query/queries";
import { useRenderProbe } from "../lib/render-probe";
import { useUi } from "../lib/ui-context";
import { IconButton } from "../ui/icon-button";
import { useChat } from "./chat-context";
import { openSearch } from "./search-events";
import { AccountMenu } from "./sidebar-account";
import { ProjectRow } from "./sidebar-project";
import { ConversationRow } from "./sidebar-row";
import { Section } from "./sidebar-section";

const NO_PINS: string[] = [];
const NO_PROJECTS: PreferencesDto["projects"] = [];
const NO_PLACES: Record<string, string> = {};

export const Sidebar = memo(function Sidebar() {
  useRenderProbe("Sidebar");
  const { userId, conversationId } = useChat();
  const {
    setSidebarOpen,
    recentsCollapsed,
    setRecentsCollapsed,
    pinnedCollapsed,
    setPinnedCollapsed,
  } = useUi();
  const prefs = useQuery(preferencesQuery(userId));
  const pins = prefs.data?.pins ?? NO_PINS;
  const list = useQuery(conversationsQuery(userId));
  const prefetcher = usePrefetcher(userId);
  const { pathname } = useLocation();
  // Pinned chats in pin order; Recents shows the rest.
  const pinnedItems = useMemo(() => {
    const byId = new Map((list.data ?? []).map((c) => [c.id, c]));
    return pins.flatMap((id) => byId.get(id) ?? []);
  }, [list.data, pins]);
  const projects = prefs.data?.projects ?? NO_PROJECTS;
  const places = prefs.data?.chatProjects ?? NO_PLACES;
  // Chats in a project live under it; Recents shows the rest (pins aside).
  const recentItems = useMemo(
    () => (list.data ?? []).filter((c) => !pins.includes(c.id) && !(c.id in places)),
    [list.data, pins, places],
  );
  const byProject = useMemo(() => {
    const map = new Map<string, ConversationSummary[]>();
    for (const c of list.data ?? []) {
      const project = places[c.id];
      if (project) map.set(project, [...(map.get(project) ?? []), c]);
    }
    return map;
  }, [list.data, places]);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [openProjects, setOpenProjects] = useState<ReadonlySet<string>>(() => new Set());
  // The open chat's project unfolds so the chat is visible.
  const currentProject = conversationId ? places[conversationId] : undefined;

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
            <PanelLeft size={20} aria-hidden />
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
        <Section
          id="projects"
          label="Projects"
          collapsed={projectsCollapsed}
          onToggle={setProjectsCollapsed}
        >
          <ul className="chat-list" id="projects" data-testid="project-list">
            <li>
              <button
                type="button"
                className="side-row"
                onClick={() => {
                  openProjectDialog({ kind: "create" });
                }}
              >
                <FolderPlus size={18} aria-hidden />
                <span>New project</span>
              </button>
            </li>
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                items={byProject.get(project.id) ?? []}
                open={openProjects.has(project.id) || currentProject === project.id}
                onToggle={() => {
                  setOpenProjects((current) => {
                    const next = new Set(current);
                    const isOpen = next.has(project.id) || currentProject === project.id;
                    if (isOpen) next.delete(project.id);
                    else next.add(project.id);
                    return next;
                  });
                }}
                conversationId={conversationId}
                pins={pins}
                prefetcher={prefetcher}
              />
            ))}
          </ul>
        </Section>
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
        <AccountMenu />
      </div>
    </nav>
  );
});
