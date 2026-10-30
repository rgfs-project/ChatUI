import { useEffect } from "react";
import { useLocation } from "react-router";
import type { SearchJump } from "./search-events";

const HIGHLIGHT = "chatui-search";

/** Every case-insensitive occurrence of `query` in the text under `root`. */
function rangesOf(root: Element, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toLowerCase();
    let at = text.indexOf(needle);
    while (at >= 0) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

/**
 * After opening a chat from search: scroll to the matching message and mark
 * every match (CSS Custom Highlights: no DOM changes, so React's tree and
 * the reader's selection are untouched). Once per opening: the marks go
 * when another chat opens.
 */
export function useSearchMarks(ready: boolean, conversationId: string | null) {
  const location = useLocation();
  const jump = (location.state as Partial<SearchJump> | null)?.search;
  useEffect(() => {
    if (!ready || !jump) return;
    const frame = requestAnimationFrame(() => {
      const thread = document.querySelector('[data-testid="transcript"]');
      if (!thread) return;
      const target = jump.messageId
        ? thread.querySelector(`[data-message-id="${CSS.escape(jump.messageId)}"]`)
        : null;
      target?.scrollIntoView({ block: "center" });
      if (jump.query && "highlights" in CSS) {
        CSS.highlights.set(HIGHLIGHT, new Highlight(...rangesOf(thread, jump.query)));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [ready, jump, location.key]);
  useEffect(
    () => () => {
      if ("highlights" in CSS) CSS.highlights.delete(HIGHLIGHT);
    },
    [conversationId],
  );
}
