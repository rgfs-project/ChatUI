import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { FolderClosed, MessageCircle, Plus, Search, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { SEARCH_LIMITS, type SearchResult } from "@shared/conversations";
import { useFocusReturn } from "../lib/focus-return";
import { paths } from "../lib/paths";
import { queries } from "../lib/query";

/** Typing settles this long before a query goes out. */
const DEBOUNCE_MS = 200;
/** Recent chats offered before anything is typed. */
const RECENT_COUNT = 5;

const optionId = (index: number) => `search-option-${String(index)}`;

/** A result opens its conversation, scrolled to the matching message. */
export function resultHref(result: SearchResult): string {
  return `${paths.chat(result.conversationId)}${result.messageId ? `#m-${result.messageId}` : ""}`;
}

interface Option {
  key: string;
  href: string;
  icon: ReactNode;
  title: string;
  snippet?: ReactNode;
  /** When it last changed, shown on the right ("Today", "Yesterday", a date). */
  when?: string;
}

const TABS = [
  { id: "all", label: "All" },
  { id: "chats", label: "Chats" },
  { id: "projects", label: "Projects" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** "Today", "Yesterday", a weekday within the week, else a short date. */
export function relativeDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Search chats: a combobox in a dialog. Empty, it offers a new chat and the
 * latest chats; typing searches titles and messages (debounced, bounded by the
 * server). ↑/↓ move, Enter opens, Escape closes.
 */
export function SearchDialog({
  userId,
  onClose,
  onNavigate,
}: {
  userId: string;
  /** `navigated`: an option was opened, so focus stays with the new page. */
  onClose: (navigated: boolean) => void;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const focus = useFocusReturn();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<Tab>("all");
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text.trim());
      setActive(0);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);
  const search = useQuery({ ...queries.search(userId, query), enabled: query !== "" });
  // The sidebar loaded the list already: read the cache, never refetch here.
  const recents = useQuery({ ...queries.conversations(userId), enabled: false });
  const projects = useQuery({ ...queries.projects(userId), enabled: query !== "" });
  const results = query === "" || tab === "projects" ? [] : (search.data?.results ?? []);
  const needle = query.toLowerCase();
  const projectMatches =
    query === "" || tab === "chats"
      ? []
      : (projects.data ?? []).filter((p) => p.name.toLowerCase().includes(needle));
  const pending =
    query !== "" &&
    ((tab !== "projects" && search.isPending) || (tab !== "chats" && projects.isPending));

  const options: Option[] =
    query === ""
      ? [
          {
            key: "new",
            href: paths.newChat(),
            icon: <Plus size={20} aria-hidden />,
            title: "New chat",
          },
          ...(recents.data ?? []).slice(0, RECENT_COUNT).map((c) => ({
            key: c.id,
            href: paths.chat(c.id),
            icon: <MessageCircle size={20} aria-hidden />,
            title: c.title,
          })),
        ]
      : [
          ...projectMatches.map((project) => ({
            key: `project:${project.id}`,
            href: paths.projects(project.id),
            icon: <FolderClosed size={20} aria-hidden />,
            title: project.name,
            when: project.updatedAt,
          })),
          ...results.map((result) => ({
            key: `${result.conversationId}:${result.messageId ?? "title"}`,
            href: resultHref(result),
            icon: <MessageCircle size={20} aria-hidden />,
            title: result.title,
            snippet: (
              <>
                {result.role ? (
                  <span className="visually-hidden">
                    {result.role === "user" ? "You: " : "Assistant: "}
                  </span>
                ) : null}
                {result.snippet.before}
                <mark>{result.snippet.match}</mark>
                {result.snippet.after}
              </>
            ),
            when: result.updatedAt,
          })),
        ];
  const current = Math.min(active, options.length - 1);

  const open = (option: Option) => {
    onNavigate();
    onClose(true);
    void navigate(option.href);
  };

  const status =
    query === ""
      ? "Search your chat titles and messages."
      : pending
        ? "Searching…"
        : search.isError && tab !== "projects"
          ? "Search failed. Try again."
          : options.length === 0
            ? "No results."
            : `${String(options.length)}${search.data?.truncated && tab !== "projects" ? "+" : ""} result${options.length === 1 ? "" : "s"}${
                search.data?.skippedMalformed && tab !== "projects"
                  ? ` (${String(search.data.skippedMalformed)} unreadable chat${search.data.skippedMalformed === 1 ? "" : "s"} skipped)`
                  : ""
              }`;

  return (
    <Dialog.Root
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="dialog search-dialog"
          data-testid="search-dialog"
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        >
          <Dialog.Title className="visually-hidden">Search chats</Dialog.Title>
          <Dialog.Description className="visually-hidden">
            Type to search; use the arrow keys to choose a result and Enter to open it.
          </Dialog.Description>
          <div className="search-head">
            <input
              type="search"
              role="combobox"
              aria-label="Search chats"
              aria-expanded={options.length > 0}
              aria-controls="search-results"
              aria-autocomplete="list"
              aria-activedescendant={options.length > 0 ? optionId(current) : undefined}
              placeholder="Search chats…"
              maxLength={SEARCH_LIMITS.maxQuery}
              value={text}
              autoFocus
              onChange={(event) => {
                setText(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (options.length === 0) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : options.length - 1;
                  setActive((current + step) % options.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const chosen = options[current];
                  if (chosen) open(chosen);
                }
              }}
            />
            {text !== "" ? (
              <>
                <button
                  type="button"
                  className="search-clear"
                  onClick={(event) => {
                    setText("");
                    setQuery("");
                    setActive(0);
                    event.currentTarget.parentElement?.querySelector("input")?.focus();
                  }}
                >
                  Clear
                </button>
                <span className="search-divider" aria-hidden />
              </>
            ) : null}
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close" title="Close">
                <X size={20} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          {query !== "" ? (
            <div className="search-tabs" role="group" aria-label="Show">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="search-tab"
                  aria-pressed={tab === t.id}
                  onClick={() => {
                    setTab(t.id);
                    setActive(0);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="visually-hidden" role="status" aria-live="polite">
            {status}
          </p>
          <ul id="search-results" role="listbox" aria-label="Results" className="search-results">
            {options.map((option, index) => (
              <li
                key={option.key}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                className={`search-result${option.snippet ? " has-snippet" : ""}`}
                onPointerMove={() => {
                  setActive(index);
                }}
                onClick={() => {
                  open(option);
                }}
              >
                {option.icon}
                <span className="text">
                  <span className="title">{option.title}</span>
                  {option.snippet ? <span className="snippet">{option.snippet}</span> : null}
                </span>
                {option.when ? <span className="when">{relativeDay(option.when)}</span> : null}
              </li>
            ))}
          </ul>
          {pending && options.length === 0 ? (
            <div className="search-skeleton" aria-hidden>
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="skeleton-row">
                  <span className="skeleton-icon" />
                  <span className="skeleton-lines">
                    <span />
                    <span />
                  </span>
                </div>
              ))}
            </div>
          ) : query !== "" && options.length === 0 ? (
            <p className="search-empty">
              <Search size={20} aria-hidden />
              {search.isError && tab !== "projects" ? "Search failed. Try again." : "No results"}
            </p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
