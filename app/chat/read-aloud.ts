import { useSyncExternalStore } from "react";

/**
 * Read aloud with the browser's own speech synthesis (no server, no network).
 * Offered only where the browser supports it (INV-52); one reply at a time.
 */
let speakingId: string | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(id: string, text: string): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = utterance.onerror = () => {
    if (speakingId === id) {
      speakingId = null;
      notify();
    }
  };
  speakingId = id;
  notify();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  speakingId = null;
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether this reply is being read; false on the server and while hydrating. */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => speakingId === id,
    () => false,
  );
}

/** Whether to offer the action at all (false on the server and while hydrating). */
export function useSpeechSupported(): boolean {
  return useSyncExternalStore(subscribe, speechSupported, () => false);
}

/** Speech wants prose: drop Markdown markup and code fences. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " code block. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
