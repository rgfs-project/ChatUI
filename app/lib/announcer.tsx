import { useSyncExternalStore } from "react";

/**
 * The shell's one polite live region for replies (Phase 18). It lives in the
 * app layout, not the conversation view, so it survives the new chat becoming
 * `/chat/:id` mid-reply: a region replaced while it speaks is often not read.
 * Views call `announce()` from effects; the server always renders it empty.
 */
let message = "";
const listeners = new Set<() => void>();

export function announce(text: string) {
  if (text === message) return;
  message = text;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // The last region gone (sign-out, account switch): start silent next time.
    if (listeners.size === 0) message = "";
  };
}

export function LiveAnnouncer() {
  const text = useSyncExternalStore(
    subscribe,
    () => message,
    () => "",
  );
  return (
    <p
      className="visually-hidden"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="response-announcer"
    >
      {text}
    </p>
  );
}
