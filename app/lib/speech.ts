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

/**
 * Chrome stops an utterance after about 15 seconds, so a reply is spoken in
 * sentence-sized chunks of at most this many characters.
 */
const CHUNK = 200;

/** Sentences, packed into chunks no longer than CHUNK (a longer sentence splits at spaces). */
export function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (current && current.length + 1 + piece.length > CHUNK) {
      chunks.push(current);
      current = piece;
    } else current = current ? `${current} ${piece}` : piece;
  };
  for (const sentence of text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length <= CHUNK) push(trimmed);
    else for (const word of trimmed.split(" ")) push(word);
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * The utterances being spoken, held so Chrome cannot garbage-collect one
 * mid-sentence (which cuts it off), and a run number so a stopped run's late
 * callbacks are ignored.
 */
let queue: SpeechSynthesisUtterance[] = [];
let run = 0;

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  run += 1;
  queue = [];
  window.speechSynthesis.cancel();
  set(null);
}

export function toggleSpeaking(id: string, markdown: string): void {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;
  const wasThis = speaking === id;
  const busy = synth.speaking || synth.pending;
  stopSpeaking();
  if (wasThis) return;
  const mine = run;
  queue = speechChunks(speakableText(markdown)).map((text, n, all) => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (n === all.length - 1) {
      utterance.onend = () => {
        if (run === mine) stopSpeaking();
      };
    }
    utterance.onerror = (event) => {
      // "interrupted"/"canceled" come from our own cancel().
      if (run === mine && event.error !== "interrupted" && event.error !== "canceled")
        stopSpeaking();
    };
    return utterance;
  });
  if (queue.length === 0) return;
  set(id);
  const start = () => {
    if (run !== mine) return;
    for (const utterance of queue) synth.speak(utterance);
  };
  // speak() straight after cancel() drops the start of the new speech in
  // Chrome and Safari: let the cancel settle first.
  if (busy) setTimeout(start, 100);
  else start();
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
