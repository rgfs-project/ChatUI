/**
 * Lazy menus (Phase 9) render a placeholder trigger until their chunk arrives;
 * this records how the placeholder was activated. Kept apart from `Menus.tsx`
 * so the critical bundle can use it without loading the menus.
 */

/**
 * How a lazy menu was requested before its chunk arrived: not at all, by
 * pointer, or from the keyboard (Enter/Space on the placeholder).
 */
export type MenuRequest = boolean | "keyboard";

/** The request mode of a placeholder click (`detail` is 0 for keyboard activation). */
export function menuRequest(event: { detail: number }): MenuRequest {
  return event.detail === 0 ? "keyboard" : true;
}
