import { useSyncExternalStore } from "react";

/**
 * Read aloud, on the browser's speech synthesis: one reply at a time, and a
 * second press stops it. Markdown syntax and code blocks are left out of what
 * is spoken (a code block is announced as such instead).
 */
let speaking: string | null = null;
const listeners = new Set<() => void>();

function set(id: string | null) {
  speaking = id;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Markdown reduced to the words a listener needs. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code block) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, "$2")
    .replace(/\$\$?[^$]*\$\$?/g, " (formula) ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  set(null);
}

export function toggleSpeaking(id: string, markdown: string): void {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;
  const wasThis = speaking === id;
  synth.cancel();
  if (wasThis) {
    set(null);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(speakableText(markdown));
  utterance.onend = () => {
    if (speaking === id) set(null);
  };
  utterance.onerror = utterance.onend;
  set(id);
  synth.speak(utterance);
}

const noopSubscribe = () => () => undefined;

/** Known only in the browser: false on the server and during hydration. */
export function useSpeechSupported(): boolean {
  return useSyncExternalStore(noopSubscribe, speechSupported, () => false);
}

/** Whether `id` is the reply being read right now. */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => speaking === id,
    () => false,
  );
}
