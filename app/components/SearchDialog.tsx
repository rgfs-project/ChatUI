import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { SearchResponse } from "@shared/conversations";
import { api } from "../lib/api";
import { paths } from "../lib/paths";
import { useConversations } from "../lib/query";
import { splitConversations } from "./Sidebar";
import { Dialog } from "./ui";

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [value, ms]);
  return debounced;
}

/** Search chats: recent ones until something is typed, then matches with snippets. */
export function SearchDialog(props: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 200);
  const conversations = useConversations(props.userId);
  const results = useQuery({
    queryKey: ["user", props.userId, "search", q],
    queryFn: ({ signal }) =>
      api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: props.open && q.length > 0,
    staleTime: 10_000,
  });
  const close = () => {
    props.onOpenChange(false);
    setText("");
  };
  const { pinned, recents } = splitConversations(conversations.data?.conversations ?? []);
  const recent = [...pinned, ...recents].slice(0, 12);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) props.onOpenChange(true);
        else close();
      }}
      title="Search chats"
      hideTitle
      className="search-dialog"
    >
      <label className="search-field">
        <Search size={18} aria-hidden />
        <span className="sr-only">Search chats</span>
        <input
          type="search"
          placeholder="Search chats"
          value={text}
          autoFocus
          maxLength={200}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      </label>
      <div className="search-results" aria-live="polite">
        {q === "" ? (
          <>
            <p className="list-heading">Recent</p>
            {recent.length === 0 ? <p className="muted pad">No conversations yet.</p> : null}
            <ul>
              {recent.map((c) => (
                <li key={c.id}>
                  <Link to={paths.chat(c.id)} onClick={close} className="search-row">
                    <MessageSquare size={18} aria-hidden />
                    <span className="search-title">{c.title || "New chat"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : results.isError ? (
          <p className="error pad" role="alert">
            Search failed. Try again.
          </p>
        ) : results.data ? (
          <>
            {results.data.results.length === 0 ? (
              <p className="muted pad">No chats match “{q}”.</p>
            ) : null}
            <ul>
              {results.data.results.map((r) => (
                <li key={`${r.conversationId}-${r.messageId ?? "title"}`}>
                  <Link to={paths.chat(r.conversationId)} onClick={close} className="search-row">
                    <MessageSquare size={18} aria-hidden />
                    <span className="search-text">
                      <span className="search-title">{r.title || "New chat"}</span>
                      {r.messageId ? (
                        <span className="search-snippet">
                          {r.snippet.before}
                          <mark>{r.snippet.match}</mark>
                          {r.snippet.after}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {results.data.truncated ? (
              <p className="muted pad">More matches exist; refine your search.</p>
            ) : null}
          </>
        ) : (
          <p className="muted pad">Searching…</p>
        )}
      </div>
    </Dialog>
  );
}
