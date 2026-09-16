import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Where the reader had got to, kept across a reload.
 *
 * A reply that outgrows the room reserved for it releases the transcript: the
 * view stops following the bottom and stays where the reader is reading, near
 * the top of an answer that runs on for several screens. Nothing recorded that.
 * A reload rebuilt the transcript from scratch, and a transcript nobody has
 * scrolled starts at the bottom — so refreshing in the middle of a long answer
 * threw the reader thousands of pixels past the line they were on, with no way
 * back but scrolling for it. Measured at 5,713px on a 3,000-word reply.
 *
 * ## By the turn, not by the offset
 *
 * `scrollTop` alone is the wrong thing to keep. It only means the same position
 * if the transcript lays out to exactly the same height, and it does not: the
 * reserve under the last turn is rebuilt against the new viewport, a web font
 * arrives after the first paint, an image decodes. Every one of those moves a
 * saved offset off the line it was taken on.
 *
 * So what is saved is the first turn still on screen and how far its top sits
 * above the viewport's — a sentence, and where in it the reader was. Restoring
 * puts that turn back at that offset whatever the transcript now measures.
 *
 * ## Session storage, deliberately
 *
 * A reload is the case this exists for. A tab opened tomorrow is not resuming
 * anything, and the newest message is the better place to start it.
 */

/** How long after a conversation loads a position may still be restored. */
const RESTORE_WINDOW_MS = 2000;

/** Nearer the bottom than this is not a place, it is just the end. */
const BOTTOM_EPSILON_PX = 48;

/** Smaller corrections than this are the rounding of a reflow. */
const EPSILON_PX = 1;

interface Position {
  /** `data-message-id` of the first turn still on screen. */
  id: string;
  /** How far that turn's top sits above the viewport's, in pixels. */
  offset: number;
}

function key(conversationId: string): string {
  return `chat:scroll:${conversationId}`;
}

function read(conversationId: string): Position | null {
  try {
    const raw = window.sessionStorage.getItem(key(conversationId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, offset } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || typeof offset !== 'number') return null;
    return { id, offset };
  } catch {
    return null;
  }
}

function write(conversationId: string, position: Position | null): void {
  try {
    if (position === null) window.sessionStorage.removeItem(key(conversationId));
    else window.sessionStorage.setItem(key(conversationId), JSON.stringify(position));
  } catch {
    // Storage unavailable (private mode, blocked); the reload just starts at
    // the bottom, which is where it started before any of this existed.
  }
}

export interface ScrollMemoryOptions {
  /** The scroll container. */
  port: React.RefObject<HTMLElement | null>;
  /** The element holding the turns. */
  content: React.RefObject<HTMLElement | null>;
  /** The conversation on screen, or `null` for one that has no id yet. */
  conversationId: string | null;
}

export function useScrollMemory({ port, content, conversationId }: ScrollMemoryOptions): void {
  /*
   * Until this passes, every render is still a chance to restore.
   *
   * One attempt is not enough. The turns arrive, then the reserve under the
   * last one is measured and applied, then a font lands — each of them moving
   * the line that was being aimed at. So the aim is taken again on every pass
   * through the window, which is short enough that the reader's own first
   * scroll ends it well before it would fight them for the view.
   */
  const deadline = useRef(0);

  /* Whether this conversation still has a position waiting to be applied. */
  const pending = useRef<Position | null>(null);

  useLayoutEffect(() => {
    pending.current = conversationId === null ? null : read(conversationId);
    deadline.current = Date.now() + RESTORE_WINDOW_MS;
  }, [conversationId]);

  /** The reader taking the view is the end of it, whatever the clock says. */
  const stop = useCallback((): void => {
    pending.current = null;
    deadline.current = 0;
  }, []);

  useEffect(() => {
    const scroller = port.current;
    if (scroller === null) return;

    const options = { passive: true } as const;
    scroller.addEventListener('wheel', stop, options);
    scroller.addEventListener('touchstart', stop, options);
    window.addEventListener('keydown', stop, options);

    return () => {
      scroller.removeEventListener('wheel', stop);
      scroller.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [port, stop]);

  /*
   * Recorded as the reader moves, so what is stored is always the last place
   * they were rather than the last place the transcript happened to be when
   * something thought to save it.
   *
   * Sitting at the bottom is not saved at all — it is deleted. The bottom is
   * where a reload starts anyway, and a stale record of it would be restored
   * against a transcript that has since grown, putting the reader above a reply
   * that arrived while they were gone.
   */
  useEffect(() => {
    const scroller = port.current;
    if (scroller === null || conversationId === null) return;

    let frame: number | null = null;

    const save = (): void => {
      frame = null;
      const list = content.current;
      if (list === null) return;

      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (distance <= BOTTOM_EPSILON_PX) {
        write(conversationId, null);
        return;
      }

      const top = scroller.getBoundingClientRect().top;
      const turns = list.querySelectorAll<HTMLElement>('[data-message-id]');
      for (const turn of turns) {
        const box = turn.getBoundingClientRect();
        // The first turn whose bottom is still below the top edge: the one the
        // reader is reading, even when it started above the fold.
        if (box.bottom > top) {
          const id = turn.dataset['messageId'];
          if (id !== undefined) write(conversationId, { id, offset: top - box.top });
          return;
        }
      }
    };

    const onScroll = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(save);
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [port, content, conversationId]);

  /*
   * Deliberately every render, for as long as the window lasts: the transcript
   * is still settling, and each pass aims at the same line again against what
   * it now measures.
   *
   * Set on `scrollTop` directly rather than through the pin's own adjustment,
   * because this is not a correction to hold a position — it *is* the reader's
   * position. The scroll it causes is read as theirs, which is what leaves the
   * transcript unpinned with the jump-to-latest control offered, exactly as
   * they left it.
   */
  useLayoutEffect(() => {
    const target = pending.current;
    if (target === null) return;
    if (Date.now() > deadline.current) {
      pending.current = null;
      return;
    }

    const scroller = port.current;
    const list = content.current;
    if (scroller === null || list === null) return;

    const turn = list.querySelector<HTMLElement>(`[data-message-id="${target.id}"]`);
    // Not rendered yet, or gone. Either way there is nothing to aim at on this
    // pass; the window is still open for the next one.
    if (turn === null) return;

    const delta =
      turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top + target.offset;
    if (Math.abs(delta) < EPSILON_PX) return;

    const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(limit, scroller.scrollTop + delta));
  });
}
