import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from "react";

/** Distance from the bottom (px) that still counts as "pinned". */
export const PIN_THRESHOLD = 48;

/** "Jump to latest" appears once the user is this far from the bottom. */
export const JUMP_DISTANCE = 200;

/** Keys that scroll a focused region towards older content. */
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Scroll intent for the transcript: follow new content only while the user is
 * pinned to the bottom. Scroll origin is tracked explicitly: our own scrolls
 * and content growth only ever move the viewport down, so upward movement,
 * an upward wheel, a touch drag or an upward navigation key is user intent
 * and unpins. Reaching the bottom (within the threshold) re-pins. Nothing
 * depends on frame timing, so fast streams cannot swallow a user's scroll.
 */
export function useScrollPin<T extends HTMLElement>(contentVersion: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  // Unpinned and well away from the bottom: offer "jump to latest", whether
  // or not anything new has arrived (owner's request, after ChatGPT).
  const [away, setAway] = useState(false);
  const updateAway = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAway(!pinned.current && el.scrollHeight - el.scrollTop - el.clientHeight > JUMP_DISTANCE);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior });
    lastTop.current = el.scrollTop;
  }, []);

  /** Explicit user intent to leave the bottom (only if there is somewhere to go). */
  const unpin = useCallback(() => {
    const el = ref.current;
    if (el && el.scrollHeight > el.clientHeight) pinned.current = false;
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop;
    const distance = el.scrollHeight - top - el.clientHeight;
    if (distance <= PIN_THRESHOLD) {
      pinned.current = true;
    } else if (top < lastTop.current) {
      pinned.current = false;
    }
    lastTop.current = top;
    updateAway();
  }, [updateAway]);

  const onWheel = useCallback(
    (event: WheelEvent) => {
      if (event.deltaY < 0) unpin();
    },
    [unpin],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) unpin();
    },
    [unpin],
  );

  // Any size change of the container or its content (status lines, a reply
  // swapped for its stored copy, late layout) is followed while pinned.
  // ResizeObserver fires after layout and before paint, so nothing lags.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinned.current) return;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Content changed: follow it if pinned, otherwise re-check "jump to latest".
  // A layout effect, so the new content is never painted before we follow it.
  useLayoutEffect(() => {
    if (pinned.current) scrollToBottom();
    else updateAway();
  }, [contentVersion, scrollToBottom, updateAway]);

  return {
    ref,
    /** Spread onto the scroll container. */
    handlers: { onScroll, onWheel, onKeyDown, onTouchMove: unpin },
    showJump: away,
    /** Back to the newest message, pinned again (no animation under reduced motion). */
    jumpToLatest: () => {
      const reduced =
        typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollToBottom(reduced ? "auto" : "smooth");
    },
    isPinned: () => pinned.current,
    /** Leaves the bottom to show one element (search result navigation). */
    reveal: (element: HTMLElement) => {
      pinned.current = false;
      element.scrollIntoView({ block: "center" });
      if (ref.current) lastTop.current = ref.current.scrollTop;
    },
  };
}
