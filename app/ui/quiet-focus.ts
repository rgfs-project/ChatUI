/**
 * Focus that returns to a button after a menu or dialog closes is drawn with
 * the keyboard ring only when the person was using the keyboard. Closing with
 * Escape alone does not count: a menu opened by a click and closed with
 * Escape returns focus quietly. The ring comes back on the next key press.
 */
let pointer = false;

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (pointer = true), { capture: true, passive: true });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") pointer = false;
    },
    { capture: true },
  );
}

/** Whether the latest interaction (Escape aside) was with a pointer. */
export function usingPointer(): boolean {
  return pointer;
}

/** Marks a focused element so it shows no ring until it blurs or gets a key press. */
export function quietFocus(element: HTMLElement): void {
  element.dataset.quietFocus = "";
  const clear = () => {
    delete element.dataset.quietFocus;
    element.removeEventListener("blur", clear);
    element.removeEventListener("keydown", clear);
  };
  element.addEventListener("blur", clear);
  element.addEventListener("keydown", clear);
  // Focus may move elsewhere instead (a click outside): then nothing is quiet.
  requestAnimationFrame(() => {
    if (document.activeElement !== element) clear();
  });
}
