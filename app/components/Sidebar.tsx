import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis, PanelLeft, Search, SquarePen } from "lucide-react";
import { Link, useParams } from "react-router";
import type { ConversationSummary } from "@shared/conversations";
import { paths } from "../lib/paths";
import { fetchConversation, keys, useConversations } from "../lib/query";
import { useShell } from "../lib/shell";
import { AccountMenu } from "./AccountMenu";
import { useConversationActions } from "./ConversationActions";
import { IconButton, Menu, MenuContent, MenuTrigger } from "./ui";

/** Pinned first (in pin order), then recents, newest first. */
export function splitConversations(list: readonly ConversationSummary[]) {
  const pinned = list
    .filter((c) => c.pinnedRank !== null)
    .sort((a, b) => (a.pinnedRank ?? 0) - (b.pinnedRank ?? 0));
  const recents = list
    .filter((c) => c.pinnedRank === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { pinned, recents };
}

/** The conversations column: brand, New chat, Search, Pinned, Recents, account. */
export function Sidebar(props: {
  onClose: () => void;
  closeLabel: string;
  onNavigate?: () => void;
}) {
  const shell = useShell();
  const { conversationId } = useParams();
  const conversations = useConversations(shell.user.id);
  const actions = useConversationActions(shell.user.id);
  const client = useQueryClient();
  const { pinned, recents } = splitConversations(conversations.data?.conversations ?? []);

  // Intent prefetch: hovering or focusing a row warms its conversation.
  const warm = (id: string) => {
    void client
      .query({
        queryKey: keys.conversation(shell.user.id, id),
        queryFn: ({ signal }) => fetchConversation(id, signal),
        staleTime: 30_000,
      })
      .catch(() => undefined);
  };

  const row = (c: ConversationSummary) => {
    const current = c.id === conversationId;
    const title = c.title || "New chat";
    return (
      <li key={c.id} className={current ? "current" : undefined}>
        <Link
          to={paths.chat(c.id)}
          aria-current={current ? "page" : undefined}
          onPointerEnter={() => {
            warm(c.id);
          }}
          onFocus={() => {
            warm(c.id);
          }}
          onClick={props.onNavigate}
        >
          {title}
        </Link>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`Actions for ${title}`} className="row-actions">
              <Ellipsis size={18} aria-hidden />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start">
            {actions.items({ id: c.id, title, pinned: c.pinnedRank !== null })}
          </MenuContent>
        </Menu>
      </li>
    );
  };

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar-top">
        <Link to={paths.newChat()} className="brand" onClick={props.onNavigate}>
          ChatUI
        </Link>
        <IconButton label={props.closeLabel} className="muted-icon" onClick={props.onClose}>
          <PanelLeft size={18} aria-hidden />
        </IconButton>
      </div>
      <div className="sidebar-actions">
        <Link
          to={paths.newChat()}
          className="sidebar-action"
          aria-current={conversationId === undefined ? "page" : undefined}
          onClick={props.onNavigate}
        >
          <SquarePen size={18} aria-hidden />
          New chat
        </Link>
        <button type="button" className="sidebar-action" onClick={shell.openSearch}>
          <Search size={18} aria-hidden />
          Search chats
        </button>
      </div>
      <div className="sidebar-list" data-testid="conversation-list">
        {conversations.isError ? (
          <p className="sidebar-note" role="alert">
            Couldn’t load your chats.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void conversations.refetch()}
            >
              Try again
            </button>
          </p>
        ) : null}
        {pinned.length > 0 ? (
          <section aria-labelledby="sb-pinned">
            <h2 id="sb-pinned" className="sidebar-heading">
              Pinned
            </h2>
            <ul>{pinned.map(row)}</ul>
          </section>
        ) : null}
        <section aria-labelledby="sb-recents">
          <h2 id="sb-recents" className="sidebar-heading">
            Recents
          </h2>
          {conversations.isSuccess && recents.length === 0 ? (
            <p className="sidebar-note">
              {pinned.length ? "Nothing else yet." : "No conversations yet."}
            </p>
          ) : null}
          <ul>{recents.map(row)}</ul>
        </section>
      </div>
      <AccountMenu user={shell.user} />
      {actions.dialogs}
    </nav>
  );
}

/** The hidden sidebar on wide screens: a slim column of icons. */
export function Rail() {
  const shell = useShell();
  // Same rows as the open sidebar, so each icon stays where it was.
  return (
    <nav className="rail" aria-label="Conversations">
      <div className="rail-top">
        <IconButton label="Open sidebar" className="muted-icon" onClick={shell.openSidebar}>
          <PanelLeft size={18} aria-hidden />
        </IconButton>
      </div>
      <div className="sidebar-actions">
        <Link to={paths.newChat()} className="icon-button" aria-label="New chat" title="New chat">
          <SquarePen size={18} aria-hidden />
        </Link>
        <IconButton label="Search chats" onClick={shell.openSearch}>
          <Search size={18} aria-hidden />
        </IconButton>
      </div>
      <span className="spacer" />
      <AccountMenu user={shell.user} compact />
    </nav>
  );
}
