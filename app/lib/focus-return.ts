import { useRef } from "react";

/**
 * Focus restoration for Radix dialogs opened without a `Dialog.Trigger`
 * (Phase 15, INV-47). A modal Radix dialog returns focus to its Trigger on
 * close; every ChatUI dialog is opened through its `open` prop instead, so
 * without this focus would fall to `<body>`. The element focused when the
 * dialog opens is remembered and focused again on close. `explicit` wins
 * when it resolves to a connected element. A dialog opened from a menu item
 * returns to the menu's trigger, because the item is gone by then.
 *
 * Spread the handlers onto `Dialog.Content`; a dialog with its own
 * `onOpenAutoFocus` calls `remember` first.
 */
export function useFocusReturn(explicit?: () => HTMLElement | null) {
  const opener = useRef<HTMLElement | null>(null);
  const remember = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) {
      opener.current = null;
      return;
    }
    // Opened from a menu item: the item unmounts with its menu, so return to
    // the menu's trigger (Radix links it with aria-controls).
    const menu = active.closest<HTMLElement>('[role="menu"]');
    const trigger = menu?.id
      ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`)
      : null;
    opener.current = trigger ?? active;
  };
  return {
    remember,
    onOpenAutoFocus: remember,
    onCloseAutoFocus: (event: Event) => {
      const target = explicit?.() ?? opener.current;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
  };
}
