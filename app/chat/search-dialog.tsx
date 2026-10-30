import * as RadixDialog from "@radix-ui/react-dialog";
import "./search-dialog.css";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, FileText, Image as ImageIcon, MessageSquare, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import type { SearchResults } from "@shared/search";
import { apiJson } from "../lib/api";
import { paths } from "../lib/paths";
import { qk } from "../lib/query/keys";
import { conversationsQuery } from "../lib/query/queries";
import { useChat } from "./chat-context";
import type { SearchJump } from "./search-events";

type Tab = "all" | "chats" | "images" | "documents";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chats", label: "Chats" },
  { id: "images", label: "Images" },
  { id: "documents", label: "Documents" },
];

interface Item {
  key: string;
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  open: () => void;
}

function Snippet({ text, match }: { text: string; match: [number, number] }) {
  return (
    <>
      {text.slice(0, match[0])}
      <mark>{text.slice(match[0], match[1])}</mark>
      {text.slice(match[1])}
    </>
  );
}

/**
 * Search (Phase 13a, Ctrl/⌘ + K): your chats by title and message text, and
 * your files by name. With no query it lists recent chats. Opening a chat
 * result jumps to the matching message and marks every match once.
 */
export default function SearchDialog({ onClose }: { onClose: () => void }) {
  const { userId } = useChat();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [active, setActive] = useState(0);
  // Debounced: one request per pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(input.trim());
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [input]);
  const recent = useQuery(conversationsQuery(userId));
  const results = useQuery({
    queryKey: qk.search(userId, query),
    queryFn: ({ signal }) =>
      apiJson<SearchResults>(`/api/search?q=${encodeURIComponent(query)}&limit=30`, { signal }),
    enabled: query !== "",
    staleTime: 10_000,
  });

  const items = useMemo<Item[]>(() => {
    const go = (conversationId: string, jump: SearchJump["search"]) => () => {
      onClose();
      void navigate(paths.chat(conversationId), { state: { search: jump } satisfies SearchJump });
    };
    if (query === "") {
      return (recent.data ?? [])
        .filter((c) => !c.malformed)
        .slice(0, 8)
        .map((c) => ({
          key: c.id,
          icon: <MessageSquare size={16} aria-hidden />,
          title: c.title,
          detail: null,
          open: () => {
            onClose();
            void navigate(paths.chat(c.id));
          },
        }));
    }
    const data = results.data;
    if (!data) return [];
    const chats =
      tab === "all" || tab === "chats"
        ? data.chats.map((c) => ({
            key: c.conversationId,
            icon: <MessageSquare size={16} aria-hidden />,
            title: c.title,
            detail: c.first ? <Snippet text={c.first.text} match={c.first.match} /> : null,
            open: go(c.conversationId, { query, messageId: c.first?.messageId ?? null }),
          }))
        : [];
    const files = data.files
      .filter((f) =>
        tab === "all"
          ? true
          : tab === "images"
            ? f.kind === "image"
            : tab === "documents" && f.kind === "text",
      )
      .map((f) => ({
        key: f.id,
        icon:
          f.kind === "image" ? (
            <ImageIcon size={16} aria-hidden />
          ) : f.kind === "audio" ? (
            <AudioLines size={16} aria-hidden />
          ) : (
            <FileText size={16} aria-hidden />
          ),
        title: f.filename,
        detail: f.conversationId ? "In a chat" : "In your Library",
        open: () => {
          onClose();
          if (f.conversationId) void navigate(paths.chat(f.conversationId));
          else void navigate(`${paths.library()}?q=${encodeURIComponent(f.filename)}`);
        },
      }));
    return [...chats, ...files];
  }, [navigate, onClose, query, recent.data, results.data, tab]);

  const current = Math.min(active, Math.max(0, items.length - 1));
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") setActive((current + 1) % Math.max(1, items.length));
    else if (event.key === "ArrowUp")
      setActive((current - 1 + items.length) % Math.max(1, items.length));
    else if (event.key === "Enter") items[current]?.open();
    else return;
    event.preventDefault();
  }

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content className="dialog search-dialog" aria-describedby={undefined}>
          <RadixDialog.Title className="visually-hidden">Search chats</RadixDialog.Title>
          <div className="search-head">
            <Search size={18} aria-hidden />
            <input
              className="search-input selectable"
              placeholder="Search chats and files"
              aria-label="Search chats and files"
              role="combobox"
              aria-expanded
              aria-controls="search-results"
              aria-activedescendant={items[current] ? `search-${items[current].key}` : undefined}
              autoFocus
              value={input}
              onChange={(event) => {
                setInput(event.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <RadixDialog.Close asChild>
              <button type="button" className="icon-button" aria-label="Close">
                <X size={18} aria-hidden />
              </button>
            </RadixDialog.Close>
          </div>
          {query !== "" ? (
            <div className="search-tabs" role="tablist" aria-label="Result type">
              {TABS.map((t, index) => (
                <button
                  key={t.id}
                  id={`search-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls="search-results"
                  // Roving focus (ARIA tabs): one tab stop, arrows move between tabs.
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => {
                    setTab(t.id);
                    setActive(0);
                  }}
                  onKeyDown={(event) => {
                    const step =
                      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                    if (step === 0) return;
                    event.preventDefault();
                    const next = TABS[(index + step + TABS.length) % TABS.length];
                    if (!next) return;
                    setTab(next.id);
                    setActive(0);
                    document.getElementById(`search-tab-${next.id}`)?.focus();
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="search-section">{query === "" ? "Recent chats" : "Results"}</p>
          <ul className="search-results" id="search-results" role="listbox" aria-label="Results">
            {items.map((item, index) => (
              <li
                key={item.key}
                id={`search-${item.key}`}
                role="option"
                aria-selected={index === current}
                className={`search-item${index === current ? " is-active" : ""}`}
                onMouseEnter={() => {
                  setActive(index);
                }}
                onClick={item.open}
              >
                <span className="search-icon">{item.icon}</span>
                <span className="search-text">
                  <span className="search-title">{item.title}</span>
                  {item.detail ? <span className="search-detail">{item.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {query !== "" && results.data && items.length === 0 ? (
            <p className="search-empty" role="status">
              No results for “{query}”.
            </p>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
