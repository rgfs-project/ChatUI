import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { SEARCH_LIMITS, type SearchResult } from "@shared/conversations";
import { useFocusReturn } from "../lib/focus-return";
import { paths } from "../lib/paths";
import "./operations.css";
import { queries } from "../lib/query";

/** Keystrokes settle this long before a query is sent. */
const DEBOUNCE_MS = 200;

function optionId(index: number): string {
  return `search-option-${String(index)}`;
}

/** Where a result goes: the conversation, scrolled to the matching message. */
export function resultHref(result: SearchResult): string {
  return `${paths.chat(result.conversationId)}${result.messageId ? `#m-${result.messageId}` : ""}`;
}

/**
 * Search chats (Phase 13a, INV-36; loaded when opened). A Radix Dialog with a
 * combobox: typing searches the signed-in user's titles and messages
 * (debounced, bounded by the server); ↑/↓ move through the results, Enter
 * opens the conversation at the matching message, Escape closes.
 */
export function SearchDialog({
  userId,
  onClose,
  onNavigate,
}: {
  userId: string;
  /** `navigated`: a result was opened (focus then stays with the new page). */
  onClose: (navigated: boolean) => void;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const focus = useFocusReturn();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
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
  const results = query === "" ? [] : (search.data?.results ?? []);
  const current = Math.min(active, results.length - 1);

  const open = (result: SearchResult) => {
    onNavigate();
    onClose(true);
    void navigate(resultHref(result));
  };

  const status =
    query === ""
      ? "Search your chat titles and messages."
      : search.isPending
        ? "Searching…"
        : search.isError
          ? "Search failed. Try again."
          : results.length === 0
            ? "No matches."
            : `${String(results.length)}${search.data.truncated ? "+" : ""} result${results.length === 1 ? "" : "s"}${
                search.data.skippedMalformed
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
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content search-dialog"
          data-testid="search-dialog"
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        >
          <Dialog.Title className="visually-hidden">Search chats</Dialog.Title>
          <Dialog.Description className="visually-hidden">
            Type to search; use the arrow keys to choose a result and Enter to open it.
          </Dialog.Description>
          <div className="search-field">
            <Search size={18} aria-hidden />
            <input
              className="search-input"
              type="search"
              role="combobox"
              aria-label="Search chats"
              aria-expanded={results.length > 0}
              aria-controls="search-results"
              aria-autocomplete="list"
              aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
              placeholder="Search chats"
              maxLength={SEARCH_LIMITS.maxQuery}
              value={text}
              autoFocus
              onChange={(event) => {
                setText(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (results.length === 0) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : results.length - 1;
                  setActive((current + step) % results.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const chosen = results[current];
                  if (chosen) open(chosen);
                }
              }}
            />
          </div>
          <p className="search-status" role="status" aria-live="polite">
            {status}
          </p>
          <ul id="search-results" role="listbox" aria-label="Results" className="search-results">
            {results.map((result, index) => (
              <li
                key={`${result.conversationId}:${result.messageId ?? "title"}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                className={`search-result${index === current ? " active" : ""}`}
                onPointerMove={() => {
                  setActive(index);
                }}
                onClick={() => {
                  open(result);
                }}
              >
                <MessageSquare size={16} aria-hidden />
                <span className="search-text">
                  <span className="search-title">{result.title}</span>
                  <span className="search-snippet">
                    {result.role ? (
                      <span className="visually-hidden">
                        {result.role === "user" ? "You: " : "Assistant: "}
                      </span>
                    ) : null}
                    {result.snippet.before}
                    <mark>{result.snippet.match}</mark>
                    {result.snippet.after}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
