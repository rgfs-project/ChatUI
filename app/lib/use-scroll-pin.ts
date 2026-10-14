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
export function useScrollPin<T extends HTMLElement>(
  contentVersion: unknown,
  /** Changes when a message is sent: the transcript glides up to it instead of jumping. */
  glideVersion: unknown = null,
) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  // A smooth scroll in flight: size changes don't snap it to the end.
  const gliding = useRef(false);
  const lastGlide = useRef(glideVersion);
  // After a send, the newest user message sits at the top: a spacer after
  // the transcript reserves the room its reply will grow into.
  const spacer = useRef<HTMLDivElement>(null);
  const anchored = useRef(false);
  const fitSpacer = useCallback(() => {
    const el = ref.current;
    const space = spacer.current;
    if (!el || !space) return;
    let height = 0;
    const turns = anchored.current ? el.querySelectorAll<HTMLElement>(".turn-user") : [];
    const anchor = turns[turns.length - 1];
    if (anchor) {
      const style = getComputedStyle(el);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const below = space.getBoundingClientRect().top - anchor.getBoundingClientRect().top;
      height = Math.max(0, Math.floor(el.clientHeight - padding - below));
    }
    if (space.style.height !== `${String(height)}px`) space.style.height = `${String(height)}px`;
  }, []);
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
      fitSpacer();
      if (pinned.current && !gliding.current) {
        el.scrollTop = el.scrollHeight;
        lastTop.current = el.scrollTop;
      }
      // A size change without a scroll (a reply swapped for its stored copy)
      // must not leave "jump to latest" showing at the bottom.
      updateAway();
    });
    observer.observe(el);
    for (const child of el.children) if (child !== spacer.current) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  }, [fitSpacer, updateAway]);

  // Content changed: follow it if pinned, otherwise re-check "jump to latest".
  // A layout effect, so the new content is never painted before we follow it.
  useLayoutEffect(() => {
    // A new send (not the optimistic copy being replaced by the stored one).
    const glide = lastGlide.current !== glideVersion && glideVersion !== "";
    lastGlide.current = glideVersion;
    if (glide) {
      // A send: anchor its message at the top, from wherever the view was.
      anchored.current = true;
      pinned.current = true;
    }
    fitSpacer();
    if (!pinned.current) {
      updateAway();
      return;
    }
    const el = ref.current;
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!glide || reduced || !el || el.scrollHeight <= el.clientHeight) {
      if (!gliding.current) scrollToBottom();
      return;
    }
    // A sent message pushes the conversation up (after ChatGPT and Gemini).
    gliding.current = true;
    const done = () => {
      gliding.current = false;
      el.removeEventListener("scrollend", done);
      if (pinned.current) scrollToBottom();
    };
    el.addEventListener("scrollend", done);
    setTimeout(done, 600);
    scrollToBottom("smooth");
  }, [contentVersion, glideVersion, fitSpacer, scrollToBottom, updateAway]);

  return {
    ref,
    /** Spread onto the scroll container. */
    handlers: { onScroll, onWheel, onKeyDown, onTouchMove: unpin },
    showJump: away,
    /** Back to the newest message, pinned again (no animation under reduced motion). */
    jumpToLatest: () => {
      const el = ref.current;
      const reduced =
        typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollToBottom(reduced ? "auto" : "smooth");
      // Content that grew during the glide is caught up when it ends.
      el?.addEventListener(
        "scrollend",
        () => {
          if (pinned.current) scrollToBottom();
        },
        { once: true },
      );
    },
    /** The element after the transcript that keeps a sent message at the top. */
    spacerRef: spacer,
    isPinned: () => pinned.current,
    /** Leaves the bottom to show one element (search result navigation). */
    reveal: (element: HTMLElement) => {
      pinned.current = false;
      element.scrollIntoView({ block: "center" });
      if (ref.current) lastTop.current = ref.current.scrollTop;
    },
  };
}
