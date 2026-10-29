import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Within this distance of the bottom the reader counts as pinned. */
export const PIN_THRESHOLD_PX = 32;
/** A scroll this soon after wheel/touch/pointer/scroll-key input is the reader's. */
const USER_INPUT_WINDOW_MS = 800;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollIntentState {
  pinned: boolean;
  /** New content arrived while unpinned: show "jump to latest". */
  hasNew: boolean;
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.clientHeight - m.scrollTop;
}

/**
 * Scroll intent as a pure state machine. Only scrolls the user made change
 * pinning; programmatic scrolls and content growth never do, because the
 * caller marks its own scrolls (origin is tracked explicitly).
 */
export const scrollIntent = {
  initial: (): ScrollIntentState => ({ pinned: true, hasNew: false }),

  /** A scroll event. `programmatic` is true for scrolls this code issued. */
  onScroll(state: ScrollIntentState, m: ScrollMetrics, programmatic: boolean): ScrollIntentState {
    if (programmatic) return state;
    const pinned = distanceFromBottom(m) <= PIN_THRESHOLD_PX;
    if (pinned === state.pinned && (!pinned || !state.hasNew)) return state;
    return { pinned, hasNew: pinned ? false : state.hasNew };
  },

  /** Content grew. Returns whether to follow (scroll to the bottom). */
  onGrowth(state: ScrollIntentState): { state: ScrollIntentState; follow: boolean } {
    if (state.pinned) return { state, follow: true };
    return { state: state.hasNew ? state : { ...state, hasNew: true }, follow: false };
  },

  /** The user asked to jump to the latest content. */
  onJump: (): ScrollIntentState => ({ pinned: true, hasNew: false }),
};

/**
 * Wires the state machine to a scroll container and its content element
 * (attach the returned refs). `resetKey` (the conversation) re-pins and jumps
 * to the bottom before paint.
 */
export function useScrollIntent(resetKey: string): {
  scrollerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  state: ScrollIntentState;
  jumpToLatest: () => void;
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [stored, setStored] = useState(() => ({ key: resetKey, intent: scrollIntent.initial() }));
  // A different conversation starts pinned (derived; no effect needed).
  const state = stored.key === resetKey ? stored.intent : scrollIntent.initial();
  const stateRef = useRef(state);
  const keyRef = useRef(resetKey);
  /** Scroll positions this code set; their scroll events are not user intent. */
  const expected = useRef<number[]>([]);

  const setState = useCallback((next: ScrollIntentState) => {
    stateRef.current = next;
    setStored({ key: keyRef.current, intent: next });
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - target) < 1) return;
    expected.current.push(Math.round(target));
    el.scrollTop = target;
  }, []);

  useLayoutEffect(() => {
    keyRef.current = resetKey;
    stateRef.current = scrollIntent.initial();
    scrollToBottom();
  }, [resetKey, scrollToBottom]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = Math.round(el.scrollTop);
      const i = expected.current.findIndex((t) => Math.abs(t - top) <= 1);
      const ours = i !== -1;
      if (ours) expected.current.splice(0, i + 1);
      else expected.current = [];
      // Only a scroll right after real input is the reader's intent. Scroll
      // anchoring, late-loading renderers and layout changes are not (Phase 14).
      const fromUser = !ours && performance.now() - lastInput <= USER_INPUT_WINDOW_MS;
      const next = scrollIntent.onScroll(stateRef.current, el, !fromUser);
      if (next !== stateRef.current) setState(next);
    };
    let lastInput = -Infinity;
    const onInput = () => {
      lastInput = performance.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) onInput();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onInput, { passive: true });
    el.addEventListener("touchmove", onInput, { passive: true });
    el.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onInput);
      el.removeEventListener("touchmove", onInput);
      el.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onKey);
    };
  }, [setState]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const height = el.getBoundingClientRect().height;
      const grew = height > lastHeight;
      lastHeight = height;
      if (!grew) return;
      const { state: next, follow } = scrollIntent.onGrowth(stateRef.current);
      if (next !== stateRef.current) setState(next);
      if (follow) scrollToBottom();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [scrollToBottom, setState]);

  // The viewport (on-screen keyboard, rotation, window resize) changing size is
  // not the reader scrolling: a pinned reader stays at the latest message.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === lastHeight) return;
      lastHeight = el.clientHeight;
      if (stateRef.current.pinned) scrollToBottom();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [scrollToBottom]);

  const jumpToLatest = useCallback(() => {
    setState(scrollIntent.onJump());
    scrollToBottom();
  }, [scrollToBottom, setState]);

  return { scrollerRef, contentRef, state, jumpToLatest };
}
