import { useEffect } from 'react';

/**
 * How much of the screen the on-screen keyboard is covering, in CSS pixels.
 *
 * The layout asks the browser for this in CSS: `interactive-widget=resizes-content`
 * in the viewport tag makes the keyboard shorten the *layout* viewport, so
 * `100dvh` becomes the room left above the keys and the composer follows it up
 * with no measurement at all.
 *
 * Safari does not implement that hint. On iOS the keyboard changes only the
 * *visual* viewport: `dvh` stays the height of the whole screen, the bottom of
 * the shell — the composer — is left underneath the keys, and Safari then
 * scrolls the page to bring the focused field into view, which takes the header
 * off the top. The composer ends up adrift in the middle of what can be seen
 * with the transcript collapsed above it.
 *
 * So the same number is measured where CSS cannot express it, and published as
 * a custom property for the shell to subtract. Where the hint *is* honoured the
 * layout viewport has already shrunk, this measures 0, and nothing changes —
 * the two never both apply.
 */

/** Smaller than this is a rounding difference, not a keyboard. */
const EPSILON_PX = 1;

export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    let frame: number | null = null;

    const apply = (): void => {
      frame = null;

      /*
       * What the layout viewport has that the visible one does not, below it.
       * `offsetTop` is included because a page Safari has already scrolled up
       * has moved that much of itself above the visible band, and it is not
       * the keyboard's doing.
       */
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      const inset = covered > EPSILON_PX ? Math.round(covered) : 0;
      root.style.setProperty('--keyboard-inset', `${inset}px`);

      /*
       * And the scroll Safari made to reveal the field is undone, once there is
       * somewhere for the field to be: the shell has just given up the height
       * the keyboard took, so the composer is above the keys without the page
       * having to move — and while the page is moved, the header is off the top
       * of a layout that is supposed to be fixed to the screen.
       */
      if (inset > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
    };

    const onChange = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(apply);
    };

    viewport.addEventListener('resize', onChange);
    viewport.addEventListener('scroll', onChange);
    apply();

    return () => {
      viewport.removeEventListener('resize', onChange);
      viewport.removeEventListener('scroll', onChange);
      if (frame !== null) window.cancelAnimationFrame(frame);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}
